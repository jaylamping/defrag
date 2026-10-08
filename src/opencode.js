import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { snapshot } from './corpus.js';
import { configureJev, judgeJev } from './jev.js';

const fingerprint = state => createHash('sha256').update(JSON.stringify(state)).digest('hex');

async function capture(ctx, invocation, secrets = [], stateVersion = 3) {
  invocation.signal?.throwIfAborted();
  const sessionID = invocation.sessionID;
  if (typeof sessionID !== 'string' || !sessionID.startsWith('ses')) throw new Error('session');
  const session = await ctx.session.get({ sessionID }, { signal: invocation.signal });
  if (session.location?.directory !== ctx.location.directory) throw new Error('location');
  const messages = await ctx.session.context({ sessionID }, { signal: invocation.signal });
  if (!Array.isArray(messages)) throw new Error('context');
  const boundary = messages.findLastIndex(m => m.type === 'compaction' && m.status === 'completed');
  const visible = messages.slice(Math.max(0, boundary)).map(m => {
    if (m.type !== 'assistant' || m.id !== invocation.messageID) return m;
    const parts = m.content ?? [];
    const content = parts.filter(p => !(p.type === 'tool' && p.id === invocation.id && ['defrag_preview', 'defrag_check'].includes(p.name)));
    if (content.length === parts.length) return m;
    // OpenCode can persist this message's streamed timestamp while its observer
    // tool is awaiting the judge. Exclude only that bookkeeping field alongside
    // the identified observer; retain created/completed and all other evidence.
    const time = m.time ? Object.fromEntries(Object.entries(m.time).filter(([key]) => key !== 'streamed')) : m.time;
    return { ...m, ...(m.time ? { time } : {}), content };
  });
  invocation.signal?.throwIfAborted();
  return { state: snapshot(visible, String(stateVersion), boundary >= 0 ? 'compaction-summary' : 'session-context-boundary', 'live', secrets),
    revision: fingerprint({ messages: visible, agent: session.agent, model: session.model, revert: session.revert }),
    activeTools: visible.flatMap(m => m.type === 'assistant' ? m.content ?? [] : [])
      .filter(p => p.type === 'tool' && ['running', 'streaming'].includes(p.state?.status)).length };
}

// Plugin.define is an identity helper. Export the V2 plugin contract directly
// so the existing dependency-free Node CLI needs no SDK installation.
export default {
  id: 'defrag',
  async setup(ctx) {
    const options = ctx.options ?? {};
    const stateVersion = options.stateVersion ?? 3;
    if (![3, 4].includes(stateVersion)) throw new Error('stateVersion must be 3 or 4');
    if (options.remoteEnabled !== undefined && typeof options.remoteEnabled !== 'boolean') throw new Error('remoteEnabled must be boolean');
    const remoteEnabled = options.remoteEnabled === true;
    if (remoteEnabled && (typeof options.keyFile !== 'string' || !isAbsolute(options.keyFile))) throw new Error('Hosted checks require an absolute private keyFile path');
    const timeout = options.timeoutMs ?? 5000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 10000) throw new Error('timeoutMs must be 1..10000');
    const lifetime = new AbortController(), checking = new Set();
    const bounded = caller => ({ ...caller,
      signal: AbortSignal.any([caller.signal, lifetime.signal, AbortSignal.timeout(timeout)].filter(Boolean)) });
    const failure = (caller, invocation, error) => {
      const kinds = ['response', 'http', 'input', 'authentication', 'rate-limit', 'server', 'timeout', 'network'];
      return caller.signal?.aborted || lifetime.signal.aborted ? 'cancelled' : invocation.signal.aborted ? 'timeout'
        : kinds.includes(error?.kind) ? error.kind : 'context';
    };
    const keyFile = options.keyFile, endpoint = options.endpoint;
    await ctx.tool.transform(editor => {
      editor.add({ name: 'defrag_preview',
        description: 'Manually preview a bounded, redacted compaction-check snapshot of this session. Local only; no credentials, hosted inference or compaction. Returns metadata, not transcript text. This experimental snapshot is not proof that compaction is safe.',
        input: { type: 'object', properties: {}, additionalProperties: false },
        // Code Mode persists only the outer execute call. A direct tool gives
        // capture an identifiable observer without hiding arbitrary wrappers.
        options: { codemode: false },
        execute: async (_, caller) => {
          const invocation = bounded(caller);
          try {
            const { state, activeTools } = await capture(ctx, invocation, [], stateVersion);
            const { text, ...latestRequest } = state.latestRequest;
            const retained = state.retainedContext;
            const retainedMetadata = retained ? Object.fromEntries(Object.entries(retained).filter(([key]) => !['entries', 'latestUser'].includes(key))) : null;
            return { content: JSON.stringify({ mode: 'local-preview', advisoryOnly: true, hostedCalls: 0, compactionRequested: false,
              stateVersion, fingerprint: fingerprint(state), encodedStateBytes: Buffer.byteLength(JSON.stringify(JSON.stringify(state))),
              ...(retainedMetadata ? { retainedContext: retainedMetadata } : {}),
              latestRequest, coverage: state.coverage, observerToolExcluded: true, activeTools,
              warning: 'Live context approximation, not an idle checkpoint or verified scope/persistence. No safety judgment has been made.' }) };
          } catch (error) { return { content: JSON.stringify({ mode: 'local-preview', advisoryOnly: true, hostedCalls: 0,
            compactionRequested: false, decision: null, error: failure(caller, invocation, error) }) }; }
        },
      });
      if (remoteEnabled) editor.add({ name: 'defrag_check',
        description: 'Manually ask Jev to assess this session using experimental checkpoint-v2 and configured state v3 (default) or v4. Available only with installation-time hosted opt-in. Sends bounded, best-effort-redacted session text to Jev; costs may apply. Does not force permission prompts in Allow All mode. Advisory only: never compacts, retries, changes prompts or installs automatic monitoring. Not validated safety or accuracy.',
        input: { type: 'object', properties: {}, additionalProperties: false },
        options: { permission: 'defrag.remote', codemode: false },
        execute: async (_, caller) => {
          const invocation = bounded(caller);
          if (checking.has(invocation.sessionID)) return { content: JSON.stringify({ mode: 'hosted-check', advisoryOnly: true,
            compactionRequested: false, hostedCalls: 0, decision: null, error: 'busy' }) };
          checking.add(invocation.sessionID);
          let hostedCalls = 0;
          try {
            invocation.signal.throwIfAborted();
            const configuration = configureJev({ 'allow-remote': 'yes', 'key-file': keyFile, endpoint });
            const { state, revision, activeTools } = await capture(ctx, invocation, [configuration.key], stateVersion);
            if (activeTools) return { content: JSON.stringify({ mode: 'hosted-check', advisoryOnly: true,
              compactionRequested: false, hostedCalls: 0, decision: null, error: 'busy' }) };
            hostedCalls = 1;
            const result = await judgeJev({ state }, configuration, timeout, 'checkpoint-v2', invocation.signal);
            const current = await capture(ctx, invocation, [configuration.key], stateVersion);
            if (current.revision !== revision) return { content: JSON.stringify({ mode: 'hosted-check', advisoryOnly: true,
              compactionRequested: false, hostedCalls, decision: null, error: 'stale-context', stateUnchanged: false }) };
            return { content: JSON.stringify({ mode: 'hosted-check', advisoryOnly: true, compactionRequested: false,
              hostedCalls, recipe: 'checkpoint-v2', stateVersion, fingerprint: fingerprint(state), stateUnchanged: true,
              ...result, warning: 'Live context approximation, not an idle checkpoint or authorization to compact. Accuracy and host persistence are unverified.' }) };
          } catch (error) {
            return { content: JSON.stringify({ mode: 'hosted-check', advisoryOnly: true, compactionRequested: false,
              hostedCalls, decision: null, error: failure(caller, invocation, error) }) };
          } finally { checking.delete(invocation.sessionID); }
        },
      });
    });
    return () => lifetime.abort();
  },
};

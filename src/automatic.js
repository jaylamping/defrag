import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createHostApi } from './host-api.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = kind => Object.assign(new Error(kind), { kind });
const day = 86400000;
const historyLimit = 256;
const sameLocation = (a, b) => a?.directory === b.directory && a?.workspaceID === b.workspaceID;

function settings(options, dependencies) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw fail('automatic');
  const result = { quietMs: 1000, cooldownMs: 300000, maxChecks: 12, maxCompactions: 3, minimumInputTokens: 40000, hardLimitRatio: null, ...options };
  if (Object.keys(result).some(key => !['expiresAt', 'quietMs', 'cooldownMs', 'maxChecks', 'maxCompactions', 'minimumInputTokens', 'hardLimitRatio'].includes(key))) throw fail('automatic');
  if (result.hardLimitRatio !== null && (typeof result.hardLimitRatio !== 'number'
      || !Number.isFinite(result.hardLimitRatio) || result.hardLimitRatio <= 0 || result.hardLimitRatio > 1)) throw fail('automatic');
  const expires = Date.parse(result.expiresAt);
  if (!Number.isFinite(expires) || new Date(expires).toISOString() !== result.expiresAt || expires > Date.now() + 7 * day) throw fail('automatic');
  for (const key of ['maxChecks', 'maxCompactions']) {
    if (result[key] !== null && (!Number.isSafeInteger(result[key]) || result[key] < 1)) throw fail('automatic');
  }
  for (const [key, low, high] of [['quietMs', 1, 60000], ['cooldownMs', 5000, day], ['minimumInputTokens', 40000, 1000000]]) {
    if (!Number.isSafeInteger(result[key]) || result[key] < low || result[key] > high) throw fail('automatic');
  }
  if ((result.maxChecks !== null && result.maxCompactions !== null && result.maxCompactions > result.maxChecks)
      || dependencies.remoteEnabled !== true || !dependencies.telemetry
      || typeof dependencies.directory !== 'string' || !isAbsolute(dependencies.directory)) throw fail('automatic');
  return { ...result, expires };
}

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw fail('automatic-ledger');
}

async function lease(directory, pilot) {
  await privateDirectory(directory);
  const path = join(directory, pilot + '.lock');
  let handle;
  try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw fail('automatic-busy'); throw fail('automatic-ledger'); }
  const inode = (await handle.stat()).ino;
  return async () => {
    await handle.close();
    try { if ((await lstat(path)).ino === inode) await unlink(path); } catch {}
  };
}

async function readLedger(path, expiresAt) {
  let text;
  try {
    const info = await lstat(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 65536 || (process.getuid && info.uid !== process.getuid())) throw fail('automatic-ledger');
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 2, expiresAt, checks: 0, compactions: 0, seen: [] };
    throw fail('automatic-ledger');
  }
  let value;
  try { value = JSON.parse(text); } catch { throw fail('automatic-ledger'); }
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['version', 'expiresAt', 'checks', 'compactions', 'seen'].includes(key))
      || ![1, 2].includes(value.version) || value.expiresAt !== expiresAt || !Array.isArray(value.seen) || value.seen.length > historyLimit
      || !['checks', 'compactions'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
      || value.checks < value.seen.length || (value.version === 1 && value.checks !== value.seen.length) || value.compactions > value.checks
      || value.seen.some(item => !item || Object.keys(item).some(key => !['checkpoint', 'session', 'at'].includes(key))
        || !/^[a-f0-9]{64}$/.test(item.checkpoint ?? '') || !/^[a-f0-9]{64}$/.test(item.session ?? '') || !Number.isSafeInteger(item.at) || item.at < 0)) throw fail('automatic-ledger');
  return { ...value, version: 2 };
}

async function saveLedger(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

function ineligibleReason(session, messages, event, minimum) {
  if (session.time?.archived) return 'archived-session';
  if (session.outcome !== 'succeeded') return 'unsuccessful-session';
  if (session.time?.idle !== event.created) return 'stale-idle';
  if (!Array.isArray(messages)) return 'invalid-context';
  const idle = messages.at(-1);
  if (idle?.type !== 'idle') return 'missing-idle';
  if (idle.outcome !== 'succeeded') return 'unsuccessful-idle';
  if (idle.time?.created !== event.created) return 'stale-idle-message';
  if (typeof idle.id !== 'string') return 'invalid-idle-id';
  const boundary = messages.findLastIndex(m => m.type === 'compaction' && m.status === 'completed');
  const visible = messages.slice(Math.max(0, boundary));
  const assistant = visible.at(-2);
  if (assistant?.type !== 'assistant') return 'missing-assistant';
  if (assistant?.finish !== 'stop' || assistant.error || !Number.isFinite(assistant.time?.completed)) return 'unfinished-assistant';
  if (visible.some(m => m.content?.some(p => p.type === 'tool' && ['running', 'streaming'].includes(p.state?.status)))) return 'active-tool';
  const tokens = [assistant.tokens?.input, assistant.tokens?.cache?.read, assistant.tokens?.cache?.write];
  if (!tokens.every(n => Number.isSafeInteger(n) && n >= 0)) return 'unknown-input-usage';
  return tokens.reduce((a, b) => a + b, 0) >= minimum ? null : 'below-minimum-input';
}

async function contextPressure(ctx, session, messages, ratio, signal) {
  if (ratio === null) return null;
  try {
    const assistant = messages.at(-2);
    const fallback = session.model ? null : await ctx.model.default(undefined, { signal });
    const selected = session.model ?? fallback?.data ?? fallback;
    if (!selected || assistant.model?.providerID !== selected.providerID || assistant.model?.id !== selected.id) return null;
    const response = await ctx.model.list(undefined, { signal });
    const models = response?.data ?? response;
    const context = models.find(m => m.providerID === selected.providerID && m.id === selected.id)?.limit?.context;
    if (!Number.isSafeInteger(context) || context <= 0 || !Number.isSafeInteger(assistant.tokens?.output) || assistant.tokens.output < 0) return null;
    const input = assistant.tokens.input + assistant.tokens.cache.read + assistant.tokens.cache.write;
    const used = input + assistant.tokens.output;
    if (!Number.isSafeInteger(input) || !Number.isSafeInteger(used)) return null;
    // Output includes reasoning usage; adding reasoning again would double count.
    return { inputTokens: input, usedTokens: used, contextTokens: context, hardLimitRatio: ratio };
  } catch { return null; } // Unknown capacity never authorizes a forced compaction.
}

export async function startAutomatic(ctx, options, dependencies) {
  if (options === undefined || options === false) return null;
  const policy = settings(options, dependencies);
  // Keep automatic work prompt-free without granting any denied/Ask action.
  // Manual checks and unrelated permissions retain the host's normal policy.
  await ctx.permission.hook('evaluate', event => {
    if (event.metadata?.defragAutomatic === true && ['defrag.remote', 'defrag.compact'].includes(event.action)
        && event.effect === 'ask') event.effect = 'deny';
  });
  const api = dependencies.api ?? createHostApi(ctx.location.directory);
  const controller = new AbortController();
  const signal = dependencies.signal ? AbortSignal.any([controller.signal, dependencies.signal]) : controller.signal;
  const jobs = new Map(), completions = new Set(), admitted = new Map(), pilot = hash(policy.expiresAt), directory = join(dependencies.directory, 'automatic');
  const ledgerPath = join(directory, pilot + '.json');
  let state = policy.expires <= Date.now() ? 'expired' : 'active', lastReason = null, ledger = null;
  const status = () => ({ state, expiresAt: policy.expiresAt, maxChecks: policy.maxChecks, maxCompactions: policy.maxCompactions,
    hardLimitRatio: policy.hardLimitRatio, checks: ledger?.checks ?? null, compactionsRequested: ledger?.compactions ?? null, pending: jobs.size, lastReason });
  const assertLive = job => {
    job.signal.throwIfAborted();
    if (state !== 'active' || Date.now() >= policy.expires) throw fail('automatic-expired');
    if (dependencies.telemetry.status().state !== 'active') throw fail('automatic-telemetry');
  };
  const quiet = async job => {
    assertLive(job);
    const active = await api.call('get', '/api/session/active', undefined, job.signal);
    if (!active || typeof active !== 'object' || Array.isArray(active)
        || (job.childSession ? Object.hasOwn(active, job.sessionID) : Object.keys(active).length)) throw fail('automatic-busy');
    for (const suffix of ['inbox', 'permission']) {
      const pending = await api.call('get', `/api/session/${job.sessionID}/${suffix}`, undefined, job.signal);
      if (!Array.isArray(pending) || pending.length) throw fail('automatic-busy');
    }
  };
  const permit = async (job, action, agent) => {
    assertLive(job);
    const permission = await api.call('post', `/api/session/${job.sessionID}/permission`,
      { action, resources: ['*'], agent, metadata: { defragAutomatic: true } }, job.signal);
    if (permission?.effect !== 'allow') throw fail('automatic-permission');
  };

  const run = async (job, event) => {
    const started = performance.now(), trace = { mode: 'automatic-check', sessionID: job.sessionID, timings: {},
      target: dependencies.target ?? 'hosted-jev', stateVersion: dependencies.stateVersion ?? 3 };
    let release, result = { mode: 'automatic-check', hostedCalls: 0, decision: null, compactionRequested: false };
    const reject = reason => {
      if (!reason) return;
      trace.ineligibleReason = reason;
      throw fail('automatic-ineligible');
    };
    try {
      assertLive(job);
      const session = await ctx.session.get({ sessionID: job.sessionID }, { signal: job.signal });
      reject(session.id !== job.sessionID ? 'session-mismatch' : !sameLocation(session.location, ctx.location) ? 'foreign-location' : null);
      // A completed child can be quiet while its orchestrator or siblings run.
      // Root sessions retain the existing host-wide quiet policy.
      job.childSession = Boolean(session.parentID);
      const messages = await ctx.session.context({ sessionID: job.sessionID }, { signal: job.signal });
      reject(ineligibleReason(session, messages, event, 0));
      trace.pressure = await contextPressure(ctx, session, messages, policy.hardLimitRatio, job.signal);
      const forced = trace.pressure !== null && trace.pressure.usedTokens / trace.pressure.contextTokens >= policy.hardLimitRatio;
      if (!forced) reject(ineligibleReason(session, messages, event, policy.minimumInputTokens));
      result.trigger = forced ? 'hard-limit' : 'jev';
      if (forced) {
        trace.target = 'native-host';
        const initial = await dependencies.capture({ sessionID: job.sessionID, signal: job.signal }, { session, messages });
        if (initial.activeTools) throw fail('automatic-busy');
        trace.revision = initial.revision;
      }
      release = await lease(directory, pilot);
      ledger = await readLedger(ledgerPath, policy.expiresAt);
      const checkpoint = hash([job.sessionID, messages.at(-1).id, event.created]), sessionHash = hash(job.sessionID);
      if ((policy.maxChecks !== null && ledger.checks >= policy.maxChecks)
          || (policy.maxCompactions !== null && ledger.compactions >= policy.maxCompactions)) throw fail('automatic-budget');
      if (ledger.seen.some(item => item.checkpoint === checkpoint)) throw fail('automatic-duplicate');
      if (ledger.seen.some(item => item.session === sessionHash && Date.now() - item.at < policy.cooldownMs)) throw fail('automatic-cooldown');
      if (ledger.seen.length >= historyLimit) {
        const evict = ledger.seen.findIndex(item => Date.now() - item.at >= policy.cooldownMs);
        if (evict < 0) throw fail('automatic-busy');
        ledger.seen.splice(evict, 1);
      }
      if (ledger.checks >= Number.MAX_SAFE_INTEGER || ledger.compactions >= Number.MAX_SAFE_INTEGER) throw fail('automatic-ledger');
      await quiet(job);
      if (!forced) await permit(job, 'defrag.remote', session.agent);
      assertLive(job);
      ledger.checks++;
      ledger.seen.push({ checkpoint, session: sessionHash, at: Date.now() });
      await saveLedger(ledgerPath, ledger);
      assertLive(job);
      if (!forced) {
        result = { ...await dependencies.assess({ sessionID: job.sessionID, signal: job.signal }, trace, { session, messages }),
          mode: 'automatic-check', trigger: 'jev', compactionRequested: false };
        assertLive(job);
        if (result.decision !== true || result.assessment !== 'safe' || result.stateUnchanged !== true
            || result.recipe !== 'checkpoint-v2' || result.floor !== 0.9) return;
      }
      await permit(job, 'defrag.compact', session.agent);
      await quiet(job);
      const current = await dependencies.capture({ sessionID: job.sessionID, signal: job.signal });
      if (current.revision !== trace.revision || current.activeTools) throw fail('stale-context');
      if (forced) {
        const pressure = await contextPressure(ctx, current.session, current.messages, policy.hardLimitRatio, job.signal);
        if (!pressure || pressure.contextTokens !== trace.pressure.contextTokens || pressure.usedTokens !== trace.pressure.usedTokens) throw fail('stale-context');
        result.stateUnchanged = true;
      }
      assertLive(job);
      ledger.compactions++;
      await saveLedger(ledgerPath, ledger);
      assertLive(job);
      result.compactionRequested = true;
      result.compactionStatus = 'unknown';
      const id = 'msg_defrag_' + hash([pilot, checkpoint]);
      job.compactionID = id;
      admitted.set(job.sessionID, { id, trigger: result.trigger, pressure: trace.pressure });
      const acknowledgement = await api.call('post', `/api/session/${job.sessionID}/compact`, { id, delivery: 'queue' }, job.signal);
      if (acknowledgement?.id !== id || acknowledgement.type !== 'compaction') throw fail('host-api');
      result.compactionStatus = 'admitted';
      lastReason = 'compaction-admitted';
    } catch (error) {
      const kinds = ['automatic-ineligible', 'automatic-busy', 'automatic-budget', 'automatic-duplicate', 'automatic-cooldown',
        'automatic-permission', 'automatic-expired', 'automatic-telemetry', 'automatic-ledger', 'stale-context', 'host-api'];
      const kind = job.signal.aborted ? 'cancelled' : kinds.includes(error?.kind) ? error.kind : 'automatic-context';
      lastReason = kind;
      result = { ...result, error: kind, decision: null };
      if (trace.judgment) trace.discardedJudgment = trace.judgment;
    } finally {
      if (release) { try { await release(); } catch { lastReason = 'automatic-ledger'; } }
      if (!result.error && !result.compactionRequested) lastReason = 'recommendation-withheld';
      dependencies.telemetry.record({ ...trace, durationMs: performance.now() - started, result,
        discardedJudgment: result.error ? trace.judgment : undefined });
    }
  };

  const handle = event => {
    if (state !== 'active' || signal.aborted) return;
    // OpenCode 2.0.20's in-process native stream omits location, despite the
    // current public contract. run() verifies authoritative session ownership
    // before reading context or taking action. Activity/completion handling is
    // scoped to jobs/admissions already verified for this plugin instance.
    // An explicit foreign or malformed location never gets this fallback.
    if (event.location !== undefined && !sameLocation(event.location, ctx.location)) return;
    const sessionID = event.data?.sessionID;
    if (typeof sessionID !== 'string' || !/^ses[a-zA-Z0-9_-]{1,200}$/.test(sessionID)) return;
    if (['session.compaction.ended', 'session.compaction.failed'].includes(event.type) && admitted.has(sessionID)) {
      const { id, trigger, pressure } = admitted.get(sessionID);
      admitted.delete(sessionID);
      const completion = (async () => {
        let message;
        try { message = await api.call('get', `/api/session/${sessionID}/message/${id}`, undefined, signal); } catch {}
        const verified = message?.id === id && message.type === 'compaction';
        const outcome = verified && ['completed', 'failed'].includes(message.status) ? message.status : 'unknown';
        dependencies.telemetry.record({ mode: 'automatic-compaction', sessionID, target: 'native-host', stateVersion: dependencies.stateVersion ?? 3, pressure,
          result: { hostedCalls: 0, decision: null, trigger, compactionRequested: true, compactionStatus: outcome,
            ...(outcome === 'failed' ? { error: 'native-compaction-failed' } : {}) },
          nativeCompaction: verified ? { modelHash: message.model ? hash(message.model) : undefined, cost: message.cost, tokens: message.tokens } : undefined });
      })().catch(() => {}).finally(() => completions.delete(completion));
      completions.add(completion);
      return;
    }
    const current = jobs.get(sessionID);
    if (current?.compactionID && !current.signal.aborted && (
      (event.type === 'session.inbox.enqueued' && event.data.inboxID === current.compactionID)
      || (event.type === 'session.compaction.started' && event.data.inputID === current.compactionID)
      || ['session.execution.started', 'session.execution.succeeded'].includes(event.type))) return;
    if (['session.execution.started', 'session.execution.failed', 'session.execution.interrupted', 'session.inbox.enqueued',
      'session.compaction.started', 'session.model.selected', 'session.agent.selected', 'session.revert.staged',
      'session.revert.cleared', 'session.revert.committed', 'session.permissions', 'session.moved', 'session.deleted',
      'session.synthetic', 'session.shell.started', 'session.skill.activated', 'session.instructions.updated'].includes(event.type)) {
      jobs.get(sessionID)?.controller.abort();
      return;
    }
    if (event.type !== 'session.execution.succeeded' || !Number.isFinite(event.created)) return;
    if (current?.created === event.created) return;
    jobs.get(sessionID)?.controller.abort();
    if (jobs.size >= 64) { lastReason = 'automatic-busy'; return; }
    const local = new AbortController();
    let resolve;
    const job = { sessionID, created: event.created, controller: local, signal: AbortSignal.any([local.signal, signal, AbortSignal.timeout(30000)]),
      started: false, done: new Promise(done => { resolve = done; }) };
    const finish = () => { if (jobs.get(sessionID) === job) jobs.delete(sessionID); resolve(); };
    job.timer = setTimeout(() => { job.started = true; void run(job, event).catch(() => { lastReason = 'automatic-context'; }).finally(finish); }, policy.quietMs);
    job.signal.addEventListener('abort', () => { clearTimeout(job.timer); if (!job.started) finish(); }, { once: true });
    jobs.set(sessionID, job);
  };

  const settled = async () => { await Promise.all([...jobs.values()].map(job => job.done)); await Promise.all(completions); };
  const stop = async () => {
    if (state === 'active') state = 'stopped';
    controller.abort();
    clearTimeout(expiry);
    let timer;
    try { await Promise.race([settled(), new Promise(resolve => { timer = setTimeout(resolve, 100); })]); }
    finally { clearTimeout(timer); }
  };
  let expiry;
  if (state === 'active') {
    expiry = setTimeout(() => { state = 'expired'; controller.abort(); }, policy.expires - Date.now());
    expiry.unref?.();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal })) handle(event);
        if (!signal.aborted) { state = 'unavailable'; controller.abort(); }
      } catch { if (!signal.aborted) { state = 'unavailable'; controller.abort(); } }
      finally { clearTimeout(expiry); }
    })();
  }
  return { handle, settled, status, stop };
}

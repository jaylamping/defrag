import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { checkpointQuestions } from './checkpoint.js';

const queueLimit = 64, byteLimit = 8 * 1024 * 1024, recordLimit = 4096;
const choices = Object.fromEntries(Object.entries(checkpointQuestions).map(([axis, q]) => [axis, Object.keys(q.criteria)]));
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const boolean = value => typeof value === 'boolean' ? value : null;
const select = (value, allowed) => allowed.includes(value) ? value : null;
const milliseconds = value => number(value) === null ? null : Math.round(value * 100) / 100;
const counts = (source, keys) => Object.fromEntries(keys.map(key => [key, integer(source?.[key])]));

function judgment(result = {}, secret) {
  const axes = {};
  for (const [axis, names] of Object.entries(choices)) {
    const answer = result.axes?.[axis];
    if (!answer) continue;
    axes[axis] = { choice: select(answer.choice, names), probabilities: Object.fromEntries(names.map(name => {
      const p = number(answer.probabilities?.[name]);
      return [name, p !== null && p <= 1 ? p : null];
    })) };
  }
  const model = result.resolvedModel;
  return { decision: boolean(result.decision), assessment: select(result.assessment, ['safe', 'unsafe', 'uncertain']),
    score: number(result.score), floor: number(result.floor),
    blockedBy: Array.isArray(result.blockedBy) ? Object.keys(choices).filter(axis => result.blockedBy.includes(axis)) : [],
    axes, model: typeof model === 'string' && /^jev-[\w.-]{1,80}$/.test(model) && !(secret && model.includes(secret)) ? model : null,
    usage: counts(result.usage, ['input', 'output']) };
}

// Explicit projection, never a transcript or arbitrary provider/diagnostic copy.
function event(input, eventID) {
  const snapshot = input.snapshot, state = snapshot?.state, coverage = state?.coverage, request = state?.latestRequest;
  const retained = state?.retainedContext, result = input.result ?? {};
  return { version: 1, eventID, timestamp: new Date().toISOString(),
    sessionHash: typeof input.sessionID === 'string' ? createHash('sha256').update(input.sessionID).digest('hex') : null,
    mode: select(input.mode, ['local-preview', 'hosted-check', 'automatic-check', 'automatic-compaction']), stateVersion: select(input.stateVersion, [3, 4]),
    target: select(input.target, ['none', 'hosted-jev', 'loopback-fixture', 'native-host']),
    durationMs: milliseconds(input.durationMs),
    timings: Object.fromEntries(['captureMs', 'judgeMs', 'revalidateMs'].map(key => [key, milliseconds(input.timings?.[key])])),
    snapshot: snapshot ? {
      fingerprint: typeof snapshot.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(snapshot.fingerprint) ? snapshot.fingerprint : null,
      encodedStateBytes: integer(snapshot.encodedStateBytes), activeTools: integer(snapshot.activeTools),
      startsAt: select(coverage?.sourceHistory?.startsAt, ['compaction-summary', 'session-context-boundary']),
      loss: counts(coverage, ['omittedEntries', 'textClippedEntries', 'redactedEntries', 'omittedToolStatuses']),
      latestRequest: { status: select(request?.status, ['available', 'unavailable']),
        textClipped: boolean(request?.loss?.textClipped), redacted: boolean(request?.loss?.redacted) },
      retainedContext: retained ? { status: select(retained.status, ['excluded', 'not-applicable', 'unavailable', 'empty', 'recovered']),
        reason: select(retained.reason, ['no-completed-compaction', 'retained-field-not-present', 'unsupported-source-format',
          'empty-retained-field', 'source-byte-limit', 'structured-source-unavailable', 'no-exact-source-match',
          'structured-source-byte-limit', 'structured-source-window-limit']), sourceBytes: integer(retained.sourceBytes),
        rawTranscriptExcluded: boolean(retained.loss?.rawTranscriptExcluded), contentExcluded: boolean(retained.loss?.contentExcluded) } : null,
    } : null,
    hostedCalls: integer(result.hostedCalls), stateUnchanged: boolean(result.stateUnchanged),
    error: select(result.error, ['busy', 'stale-context', 'cancelled', 'response', 'http', 'input', 'authentication', 'rate-limit', 'server', 'timeout', 'network', 'context',
      'automatic-ineligible', 'automatic-busy', 'automatic-budget', 'automatic-duplicate', 'automatic-cooldown', 'automatic-permission',
      'automatic-expired', 'automatic-telemetry', 'automatic-ledger', 'automatic-context', 'host-api', 'native-compaction-failed']),
    ineligibleReason: select(input.ineligibleReason, ['foreign-location', 'session-mismatch', 'child-session', 'archived-session',
      'unsuccessful-session', 'stale-idle', 'invalid-context', 'missing-idle', 'unsuccessful-idle', 'stale-idle-message',
      'invalid-idle-id', 'missing-assistant', 'unfinished-assistant', 'active-tool', 'unknown-input-usage', 'below-minimum-input']),
    httpStatus: Number.isInteger(input.httpStatus) && input.httpStatus >= 100 && input.httpStatus <= 599 ? input.httpStatus : null,
    recipe: ['hosted-check', 'automatic-check'].includes(input.mode) && result.trigger !== 'hard-limit' ? 'checkpoint-v2' : null,
    trigger: select(result.trigger, ['jev', 'hard-limit']),
    pressure: input.pressure ? { ...counts(input.pressure, ['inputTokens', 'usedTokens', 'contextTokens']),
      hardLimitRatio: number(input.pressure.hardLimitRatio) !== null && input.pressure.hardLimitRatio > 0 && input.pressure.hardLimitRatio <= 1
        ? input.pressure.hardLimitRatio : null } : null,
    compactionRequested: ['automatic-check', 'automatic-compaction'].includes(input.mode) && result.compactionRequested === true,
    compactionStatus: select(result.compactionStatus, ['admitted', 'completed', 'failed', 'unknown']),
    nativeCompaction: input.nativeCompaction ? {
      modelHash: typeof input.nativeCompaction.modelHash === 'string' && /^[a-f0-9]{64}$/.test(input.nativeCompaction.modelHash) ? input.nativeCompaction.modelHash : null,
      cost: number(input.nativeCompaction.cost), tokens: counts(input.nativeCompaction.tokens, ['input', 'output', 'reasoning']),
      cache: counts(input.nativeCompaction.tokens?.cache, ['read', 'write']),
    } : null,
    result: judgment(result, input.secret),
    discardedJudgment: input.discardedJudgment ? judgment(input.discardedJudgment, input.secret) : null };
}

export async function createTelemetry(options, io = { open }) {
  if (options === undefined || options === false) return null;
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => key !== 'directory') || typeof options.directory !== 'string'
      || !isAbsolute(options.directory) || options.directory.length > 4096) throw new Error('telemetry requires only an absolute directory');
  let handle, state = 'active', written = 0, bytes = 0, dropped = 0, errors = 0;
  let pending = null, inFlight = 0, closing = false;
  const queue = [];
  try {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(options.directory);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error('private directory required');
    const path = join(options.directory, `defrag-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.jsonl`);
    handle = await io.open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch { state = 'unavailable'; errors++; }

  const status = () => ({ state, written, queued: queue.length + inFlight, dropped, errors });
  const discard = () => { dropped += queue.length; queue.length = 0; };
  const schedule = () => {
    if (pending || !queue.length) return;
    pending = new Promise(resolve => setImmediate(async () => {
      try {
        while (queue.length && state === 'active') {
          const lines = [];
          while (queue.length) {
            const line = JSON.stringify(queue.shift()) + '\n', size = Buffer.byteLength(line);
            if (size > recordLimit) { dropped++; continue; }
            if (bytes + size > byteLimit) { state = 'full'; dropped++; discard(); break; }
            bytes += size;
            lines.push(line);
          }
          if (!lines.length) break;
          inFlight = lines.length;
          try { await handle.writeFile(lines.join('')); written += inFlight; }
          catch { errors++; dropped += inFlight; state = 'unavailable'; discard(); }
          finally { inFlight = 0; }
        }
      } finally {
        if (closing || state !== 'active') {
          try { await handle?.close(); } catch { errors++; }
          handle = undefined;
        }
        pending = null;
        resolve();
      }
    }));
  };
  const flush = async () => { schedule(); await pending; };
  return {
    status,
    record(input) {
      if (closing || state !== 'active' || queue.length + inFlight >= queueLimit) { dropped++; return { accepted: false }; }
      try {
        const eventID = randomUUID();
        queue.push(event(input, eventID));
        schedule();
        return { accepted: true, eventID };
      } catch { errors++; dropped++; return { accepted: false }; }
    },
    flush,
    get drained() { return pending ?? Promise.resolve(); },
    async close() {
      closing = true;
      let timer;
      try {
        await Promise.race([flush(), new Promise(resolve => { timer = setTimeout(resolve, 100); })]);
      } finally {
        clearTimeout(timer);
        discard();
        if (state === 'active') state = 'closed';
        if (!pending && handle) {
          try { await handle.close(); } catch { errors++; }
          handle = undefined;
        }
      }
    },
  };
}

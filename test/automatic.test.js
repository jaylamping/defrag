import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { startAutomatic } from '../src/automatic.js';
import { createHostApi } from '../src/host-api.js';
import { scoreCheckpoint } from '../src/checkpoint.js';

const safe = () => ({ ...scoreCheckpoint(Object.fromEntries([
  ['scope', 'sufficient', 'insufficient'], ['obligation', 'settled', 'owed'],
  ['preservation', 'recoverable', 'unrecoverable'], ['consistency', 'current', 'conflicting'],
].map(([axis, positive, negative]) => [axis, { choice: positive,
  probabilities: { [positive]: 0.99, [negative]: 0.005, unclear: 0.005 } }]))),
  recipe: 'checkpoint-v2', stateUnchanged: true, hostedCalls: 1 });

async function fixture(t, changes = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'defrag-auto-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const now = Date.now(), expiresAt = new Date(now + 60000).toISOString();
  const messages = [
    { type: 'user', id: 'msg_user', text: 'PRIVATE TASK' },
    { type: 'assistant', id: 'msg_done', finish: 'stop', time: { completed: now - 1 },
      tokens: { input: 40000, cache: { read: 0, write: 0 } }, content: [{ type: 'text', text: 'PRIVATE COMPLETE' }] },
    { type: 'idle', id: 'msg_idle', outcome: 'succeeded', time: { created: now } },
  ];
  const session = { id: 'ses_test', agent: 'build', outcome: 'succeeded', time: { idle: now }, location: { directory: '/owned' } };
  const event = { id: 'evt_test', type: 'session.execution.succeeded', created: now, location: { directory: '/owned' }, data: { sessionID: 'ses_test' } };
  const calls = [], records = [];
  let revision = 'original';
  const captured = () => ({ session: structuredClone(session), messages: structuredClone(messages), state: {}, revision, activeTools: 0 });
  const ctx = { location: { directory: '/owned' }, session: {
    get: async () => structuredClone(session), context: async () => structuredClone(messages),
  }, permission: { hook: async () => {} }, event: { subscribe: async function* ({ signal }) {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  } } };
  const dependencies = {
    directory, remoteEnabled: true, timeout: 5000, signal: new AbortController().signal,
    telemetry: { status: () => ({ state: 'active' }), record: input => { records.push(input); return { accepted: true }; } },
    api: { call: async (method, path, body) => {
      calls.push({ method, path, body });
      if (path === '/api/session/active') return {};
      if (path.endsWith('/inbox') || (method === 'get' && path.endsWith('/permission'))) return [];
      if (path.endsWith('/permission')) return { id: 'per_test', effect: 'allow' };
      if (path.endsWith('/compact')) return { id: body.id, type: 'compaction' };
      throw new Error('Unexpected API operation');
    } },
    capture: async () => captured(),
    assess: async (caller, trace) => {
      calls.push({ method: 'judge' });
      trace.revision = revision;
      return safe();
    },
    ...changes,
  };
  const options = { expiresAt, quietMs: 1, cooldownMs: 5000, maxChecks: 2, maxCompactions: 2, minimumInputTokens: 40000 };
  return { ctx, dependencies, options, event, session, messages, calls, records, directory,
    changeRevision: () => { revision = 'changed'; } };
}

test('automatic mode is off by default and requires explicit bounded hosted opt-in and telemetry', async t => {
  const f = await fixture(t);
  assert.equal(await startAutomatic(f.ctx, undefined, f.dependencies), null);
  assert.equal(await startAutomatic(f.ctx, false, f.dependencies), null);
  for (const option of [true, {}, { ...f.options, expiresAt: 'invalid' }, { ...f.options, extra: true },
    { ...f.options, maxChecks: false }, { ...f.options, maxCompactions: 'unlimited' }, { ...f.options, maxChecks: 0 }]) {
    await assert.rejects(startAutomatic(f.ctx, option, f.dependencies));
  }
  await assert.rejects(startAutomatic(f.ctx, f.options, { ...f.dependencies, remoteEnabled: false }));
  await assert.rejects(startAutomatic(f.ctx, f.options, { ...f.dependencies, telemetry: null }));
  assert.equal(f.calls.length, 0);
});

test('ineligible checkpoints identify the rejecting guard without copying context', async t => {
  const cases = {
    'foreign-location': f => { f.session.location.directory = '/PRIVATE'; },
    'session-mismatch': f => { f.session.id = 'ses_OTHER'; },
    'archived-session': f => { f.session.time.archived = Date.now(); },
    'unsuccessful-session': f => { f.session.outcome = 'failed'; },
    'stale-idle': f => { f.session.time.idle--; },
    'missing-idle': f => { f.messages.pop(); },
    'unsuccessful-idle': f => { f.messages.at(-1).outcome = 'failed'; },
    'stale-idle-message': f => { f.messages.at(-1).time.created--; },
    'invalid-idle-id': f => { delete f.messages.at(-1).id; },
    'missing-assistant': f => { f.messages.splice(1, 1); },
    'unfinished-assistant': f => { f.messages[1].finish = 'tool-calls'; },
    'active-tool': f => { f.messages[1].content.push({ type: 'tool', state: { status: 'running' }, text: 'PRIVATE' }); },
    'unknown-input-usage': f => { delete f.messages[1].tokens.cache; },
    'below-minimum-input': f => { f.messages[1].tokens.input = 39999; },
    'invalid-context': f => { f.ctx.session.context = async () => ({}); },
  };
  for (const [reason, change] of Object.entries(cases)) {
    const f = await fixture(t); change(f);
    const automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
    automatic.handle(f.event); await automatic.settled();
    assert.equal(f.records.at(-1).result.error, 'automatic-ineligible');
    assert.equal(f.records.at(-1).ineligibleReason, reason);
    assert.equal(f.calls.length, 0);
    assert.ok(!JSON.stringify(f.records).includes('PRIVATE'));
    await automatic.stop();
  }
});

test('a location-less child completion is assessed only by its owning instance', async t => {
  const fixtures = await Promise.all([fixture(t), fixture(t), fixture(t)]);
  const automatic = [];
  for (const [index, f] of fixtures.entries()) {
    f.event.location = undefined;
    f.session.parentID = 'ses_parent';
    if (index > 0) f.ctx.location.directory = '/other-' + index;
    const instance = await startAutomatic(f.ctx, f.options, f.dependencies);
    automatic.push(instance);
    instance.handle(f.event);
  }
  await Promise.all(automatic.map(a => a.settled()));
  assert.equal(fixtures[0].calls.filter(c => c.method === 'judge').length, 1);
  assert.equal(fixtures[0].calls.filter(c => c.path?.endsWith('/compact')).length, 1);
  assert.deepEqual(fixtures.slice(1).map(f => f.records.at(-1).ineligibleReason), ['foreign-location', 'foreign-location']);
  assert.ok(fixtures.slice(1).every(f => f.calls.length === 0));
  await Promise.all(automatic.map(a => a.stop()));
});

test('an explicit seven-day renewal is bounded, keeps total budgets and never renews itself on reload', async t => {
  const f = await fixture(t), week = 7 * 86400000;
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const expiresAt = new Date(now + week).toISOString();
  let automatic = await startAutomatic(f.ctx, { expiresAt }, f.dependencies);
  assert.equal(automatic.status().state, 'active');
  assert.equal(automatic.status().expiresAt, expiresAt);
  assert.equal(automatic.status().maxChecks, 12);
  assert.equal(automatic.status().maxCompactions, 3);
  await automatic.stop();
  await assert.rejects(startAutomatic(f.ctx, { ...f.options, expiresAt: new Date(now + week + 1).toISOString() }, f.dependencies));
  now += 2 * 86400000;
  automatic = await startAutomatic(f.ctx, { ...f.options, expiresAt }, f.dependencies);
  assert.equal(automatic.status().expiresAt, expiresAt);
  now += 5 * 86400000 + 1;
  automatic.handle(f.event); await automatic.settled();
  assert.equal(f.calls.length, 0, 'the persisted deadline still stops work after reload');
  await automatic.stop();
  automatic = await startAutomatic(f.ctx, { ...f.options, expiresAt }, f.dependencies);
  assert.equal(automatic.status().state, 'expired');
  automatic.handle(f.event); await automatic.settled();
  assert.equal(f.calls.length, 0);
  await automatic.stop();
});

async function pressureFixture(t, ratio = 0.35, context = 100000, input = 35000) {
  const f = await fixture(t);
  f.options.hardLimitRatio = ratio;
  f.session.model = { providerID: 'fixture', id: 'selected' };
  f.messages[1].model = { ...f.session.model };
  f.messages[1].tokens = { input, output: 0, cache: { read: 0, write: 0 } };
  f.models = [{ ...f.session.model, limit: { context } }];
  f.ctx.model = { list: async () => structuredClone(f.models), default: async () => f.models[0] };
  f.dependencies.assess = async (caller, trace) => {
    f.calls.push({ method: 'judge' }); trace.revision = 'original';
    return { ...safe(), decision: false, assessment: 'unsafe' };
  };
  return f;
}

test('hard limit configuration accepts null or a finite ratio in (0, 1] and reports it', async t => {
  const f = await fixture(t);
  for (const hardLimitRatio of [0, -0.1, 1.01, NaN, Infinity, true, '0.35']) {
    await assert.rejects(startAutomatic(f.ctx, { ...f.options, hardLimitRatio }, f.dependencies));
  }
  for (const hardLimitRatio of [null, 0.35, 1]) {
    const automatic = await startAutomatic(f.ctx, { ...f.options, hardLimitRatio }, f.dependencies);
    assert.equal(automatic.status().hardLimitRatio, hardLimitRatio);
    await automatic.stop();
  }
  const automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
  assert.equal(automatic.status().hardLimitRatio, null, 'existing configurations keep the Jev gate');
  await automatic.stop();
});

test('hard limit forces native compaction at the configured ratio without a Jev call or 40k minimum', async t => {
  for (const [ratio, context, input] of [[0.35, 100000, 35000], [0.5, 200000, 100000], [1, 100000, 100000]]) {
    const f = await pressureFixture(t, ratio, context, input);
    const automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
    automatic.handle(f.event); await automatic.settled();
    assert.equal(f.calls.filter(c => c.method === 'judge').length, 0);
    assert.equal(f.calls.filter(c => c.body?.action === 'defrag.remote').length, 0);
    assert.equal(f.calls.filter(c => c.body?.action === 'defrag.compact').length, 1);
    assert.equal(f.calls.filter(c => c.path?.endsWith('/compact')).length, 1);
    const record = f.records.at(-1);
    assert.equal(record.result.trigger, 'hard-limit');
    assert.equal(record.result.hostedCalls, 0);
    assert.equal(record.result.decision, null, 'not misrepresented as a safety judgment');
    assert.deepEqual(record.pressure, { inputTokens: input, usedTokens: input, contextTokens: context, hardLimitRatio: ratio });
    automatic.handle(f.event); await automatic.settled();
    assert.equal(f.calls.filter(c => c.path?.endsWith('/compact')).length, 1, 'deduplication still applies');
    await automatic.stop();
  }
});

test('hard limit includes cached input and output, resolves selected/default models and ignores other models', async t => {
  for (const useDefault of [false, true]) {
    const f = await pressureFixture(t, 0.35, 100000, 20000);
    f.messages[1].tokens.cache = { read: 10000, write: 4000 };
    f.messages[1].tokens.output = 1000;
    if (useDefault) delete f.session.model;
    f.models.unshift({ providerID: 'other', id: 'selected', limit: { context: 1000000 } });
    f.ctx.model.default = async () => ({ location: f.ctx.location, data: f.models[1] });
    f.ctx.model.list = async () => ({ location: f.ctx.location, data: structuredClone(f.models) });
    const automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
    automatic.handle(f.event); await automatic.settled();
    assert.equal(f.calls.filter(c => c.path?.endsWith('/compact')).length, 1);
    assert.equal(f.records.at(-1).pressure.usedTokens, 35000);
    await automatic.stop();
  }
});

test('below/disabled/unknown hard limits keep the Jev gate and never invent context capacity', async t => {
  for (const scenario of ['below', 'disabled', 'unknown', 'invalid', 'mismatched', 'unavailable', 'unknown-output']) {
    const f = await pressureFixture(t, scenario === 'disabled' ? null : 0.35, 200000, 40000);
    if (scenario === 'unknown') f.models = [];
    if (scenario === 'invalid') f.models[0].limit.context = 0;
    if (scenario === 'mismatched') f.messages[1].model.id = 'previous';
    if (scenario === 'unavailable') f.ctx.model.list = async () => { throw new Error('PRIVATE'); };
    if (scenario === 'unknown-output') { delete f.messages[1].tokens.output; f.models[0].limit.context = 100000; }
    const automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
    automatic.handle(f.event); await automatic.settled();
    assert.equal(f.calls.filter(c => c.method === 'judge').length, 1);
    assert.equal(f.calls.filter(c => c.path?.endsWith('/compact')).length, 0);
    await automatic.stop();
  }
});

test('hard limit retains permissions, busy/expiry/cooldown guards and final revision cancellation', async t => {
  for (const scenario of ['deny', 'busy', 'changed', 'capacity-changed', 'active-tool', 'cancelled', 'expired', 'cooldown', 'budget']) {
    const f = await pressureFixture(t);
    if (scenario === 'deny' || scenario === 'busy') {
      const call = f.dependencies.api.call;
      f.dependencies.api.call = async (...args) => {
        const value = await call(...args);
        return scenario === 'deny' && args[0] === 'post' && args[1].endsWith('/permission') ? { effect: 'deny' }
          : scenario === 'busy' && args[1] === '/api/session/active' ? { ses_other: {} } : value;
      };
    }
    let automatic, captures = 0;
    const capture = f.dependencies.capture;
    f.dependencies.capture = async (...args) => {
      if (++captures === 2) {
        if (scenario === 'changed') f.changeRevision();
        if (scenario === 'capacity-changed') f.models[0].limit.context = 200000;
        if (scenario === 'cancelled') automatic.handle({ ...f.event, type: 'session.inbox.enqueued', location: undefined });
      }
      const value = await capture(...args);
      if (scenario === 'active-tool') value.activeTools = 1;
      return value;
    };
    if (scenario === 'expired') f.options.expiresAt = new Date(Date.now() - 1).toISOString();
    if (scenario === 'budget') { f.options.maxChecks = 1; f.options.maxCompactions = 1; }
    automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
    if (scenario === 'cooldown' || scenario === 'budget') {
      automatic.handle(f.event); await automatic.settled();
      f.event.created++; f.session.time.idle++; f.messages[2].time.created++; f.messages[2].id = 'msg_next_idle';
    }
    automatic.handle(f.event); await automatic.settled();
    assert.equal(f.calls.filter(c => c.path?.endsWith('/compact')).length, ['cooldown', 'budget'].includes(scenario) ? 1 : 0);
    assert.equal(f.calls.filter(c => c.method === 'judge').length, 0);
    await automatic.stop();
  }
});

test('explicit null budgets allow checks and compactions beyond old caps with bounded private history', async t => {
  const f = await fixture(t), hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  f.options.maxChecks = null; f.options.maxCompactions = null;
  let automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
  automatic.handle(f.event); await automatic.settled(); await automatic.stop();
  const path = join(f.directory, 'automatic', hash(f.options.expiresAt) + '.json');
  const seen = Array.from({ length: 256 }, (_, index) => ({ checkpoint: hash(index), session: hash(index), at: Date.now() - 600000 }));
  writeFileSync(path, JSON.stringify({ version: 2, expiresAt: f.options.expiresAt, checks: 1000, compactions: 1000, seen }));
  automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
  automatic.handle(f.event); await automatic.settled();
  assert.equal(automatic.status().maxChecks, null);
  assert.equal(automatic.status().maxCompactions, null);
  assert.equal(automatic.status().checks, 1001);
  assert.equal(automatic.status().compactionsRequested, 1001);
  assert.equal(f.calls.filter(c => c.method === 'judge').length, 2);
  assert.equal(f.calls.filter(c => c.path?.endsWith('/compact')).length, 2);
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(ledger.seen.length, 256);
  assert.ok(!JSON.stringify(ledger).includes('PRIVATE'));
  await automatic.stop();
  automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
  automatic.handle(f.event); await automatic.settled();
  assert.equal(f.calls.filter(c => c.method === 'judge').length, 2, 'recent deduplication survives reload with unlimited budgets');
  await automatic.stop();
});

test('bounded unlimited-mode history never evicts a checkpoint still inside its cooldown', async t => {
  const f = await fixture(t), hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  f.options.maxChecks = null; f.options.maxCompactions = null;
  let automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
  automatic.handle(f.event); await automatic.settled(); await automatic.stop();
  const path = join(f.directory, 'automatic', hash(f.options.expiresAt) + '.json');
  const seen = Array.from({ length: 256 }, (_, index) => ({ checkpoint: hash(index), session: hash(index), at: Date.now() }));
  writeFileSync(path, JSON.stringify({ version: 2, expiresAt: f.options.expiresAt, checks: 1000, compactions: 1000, seen }));
  automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
  automatic.handle(f.event); await automatic.settled();
  assert.equal(automatic.status().lastReason, 'automatic-busy');
  assert.equal(f.calls.filter(c => c.method === 'judge').length, 1);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).seen, seen);
  await automatic.stop();
});

test('automatic permission checks suppress Ask rather than grant it or publish repeated prompts', async t => {
  const f = await fixture(t);
  let hook;
  f.ctx.permission.hook = async (name, callback) => { assert.equal(name, 'evaluate'); hook = callback; };
  const automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
  for (const effect of ['allow', 'ask', 'deny']) {
    const event = { action: 'defrag.remote', metadata: { defragAutomatic: true }, effect };
    hook(event);
    assert.equal(event.effect, effect === 'ask' ? 'deny' : effect);
  }
  for (const event of [{ action: 'read', metadata: { defragAutomatic: true }, effect: 'ask' },
    { action: 'defrag.remote', effect: 'ask' }]) {
    hook(event); assert.equal(event.effect, 'ask');
  }
  automatic.handle(f.event); await automatic.settled();
  assert.equal(f.calls.find(c => c.method === 'post' && c.path.endsWith('/permission')).body.metadata.defragAutomatic, true);
  await automatic.stop();
});

test('duplicate success events during inference neither cancel nor spend twice', async t => {
  const f = await fixture(t);
  let automatic;
  const original = f.dependencies.assess;
  f.dependencies.assess = async (...args) => { automatic.handle(f.event); args[0].signal.throwIfAborted(); return original(...args); };
  automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
  automatic.handle(f.event); await automatic.settled();
  assert.equal(f.calls.filter(c => c.method === 'judge').length, 1);
  assert.equal(f.calls.filter(c => c.path?.endsWith('/compact')).length, 1);
  await automatic.stop();
});

test('a successful owned idle checkpoint is assessed once then requests idempotent queued native compaction', async t => {
  const f = await fixture(t);
  const automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
  automatic.handle(f.event);
  await automatic.settled();
  assert.equal(f.calls.filter(c => c.method === 'judge').length, 1);
  const [compact] = f.calls.filter(c => c.path?.endsWith('/compact'));
  assert.equal(compact.body.delivery, 'queue');
  assert.match(compact.body.id, /^msg_defrag_[a-f0-9]{64}$/);
  assert.equal(f.records.at(-1).result.compactionRequested, true);
  automatic.handle(f.event);
  await automatic.settled();
  assert.equal(f.calls.filter(c => c.method === 'judge').length, 1);
  assert.equal(f.calls.filter(c => c.path?.endsWith('/compact')).length, 1);
  await automatic.stop();
});

test('failed, interrupted, foreign and malformed events cannot trigger reads, inference or compaction', async t => {
  const f = await fixture(t);
  const automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
  for (const event of [
    { ...f.event, type: 'session.execution.failed' }, { ...f.event, type: 'session.execution.interrupted' },
    { ...f.event, location: { directory: '/PRIVATE FOREIGN' } }, { ...f.event, location: {} },
    { ...f.event, data: { sessionID: 'bad' } },
  ]) automatic.handle(event);
  await automatic.settled();
  assert.equal(f.calls.length, 0);
  await automatic.stop();
});

test('native success events without location are assessed only after authoritative session ownership verification', async t => {
  for (const owner of ['owned', 'foreign-directory', 'foreign-workspace', 'unavailable']) {
    const f = await fixture(t);
    delete f.event.location;
    if (owner === 'foreign-directory') f.session.location.directory = '/foreign';
    if (owner === 'foreign-workspace') f.session.location.workspaceID = 'wrk_foreign';
    if (owner === 'unavailable') f.ctx.session.get = async () => { throw new Error('Not found'); };
    const automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
    automatic.handle(f.event); await automatic.settled();
    assert.equal(f.calls.filter(c => c.method === 'judge').length, owner === 'owned' ? 1 : 0);
    assert.equal(f.calls.filter(c => c.path?.endsWith('/compact')).length, owner === 'owned' ? 1 : 0);
    if (owner !== 'owned') assert.equal(f.calls.length, 0, 'foreign/unavailable sessions never reach the API bridge');
    await automatic.stop();
  }
});

test('native activity without location cancels the already-owned session during inference', async t => {
  const f = await fixture(t);
  let automatic;
  f.dependencies.assess = async () => {
    f.calls.push({ method: 'judge' });
    automatic.handle({ ...f.event, location: undefined, type: 'session.inbox.enqueued' });
    return safe();
  };
  automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
  automatic.handle(f.event); await automatic.settled();
  assert.equal(f.calls.filter(c => c.method === 'judge').length, 1);
  assert.equal(f.calls.filter(c => c.path?.endsWith('/compact')).length, 0);
  assert.equal(f.records.at(-1).result.error, 'cancelled');
  await automatic.stop();
});

test('stale idle markers, unknown/small context and unfinished work are ineligible', async t => {
  for (const change of [
    f => { f.messages.at(-1).time.created--; },
    f => { f.messages[1].tokens = undefined; },
    f => { f.messages[1].tokens.input = 39999; },
    f => { f.messages[1].finish = 'tool-calls'; },
    f => { f.messages[1].time.completed = undefined; },
    f => { f.messages[1].content.push({ type: 'tool', state: { status: 'running' } }); },
    f => { f.messages.push({ type: 'user', text: 'PRIVATE NEW REQUEST' }); },
    f => { f.messages.splice(-1, 0, { type: 'user', text: 'PRIVATE NEW REQUEST' }); },
    f => { f.messages.splice(-1, 0, { type: 'shell', text: 'PRIVATE SHELL' }); },
  ]) {
    const f = await fixture(t); change(f);
    const automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
    automatic.handle(f.event); await automatic.settled();
    assert.equal(f.calls.filter(c => c.method === 'judge').length, 0);
    assert.equal(f.calls.filter(c => c.path?.endsWith('/compact')).length, 0);
    await automatic.stop();
  }
});

test('idle subagents qualify through Jev or the hard limit while their parent and siblings run', async t => {
  for (const forced of [false, true]) {
    const f = forced ? await pressureFixture(t) : await fixture(t);
    f.session.parentID = 'ses_parent'; f.session.agent = 'general';
    const original = f.dependencies.api.call;
    f.dependencies.api.call = async (method, path, body, signal) => {
      if (path === '/api/session/active') return { ses_parent: {}, ses_sibling: {} };
      return original(method, path, body, signal);
    };
    const automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
    automatic.handle(f.event); await automatic.settled();
    assert.equal(f.calls.filter(c => c.method === 'judge').length, forced ? 0 : 1);
    const compactions = f.calls.filter(c => c.path?.endsWith('/compact'));
    assert.equal(compactions.length, 1);
    assert.equal(compactions[0].path, '/api/session/ses_test/compact', 'Never compact the parent');
    assert.ok(f.calls.filter(c => c.body?.action).every(c => c.body.agent === 'general'));
    assert.equal(f.records.at(-1).result.trigger, forced ? 'hard-limit' : 'jev');
    automatic.handle(f.event); await automatic.settled();
    assert.equal(f.calls.filter(c => c.path?.endsWith('/compact')).length, 1);
    await automatic.stop();
  }
});

test('subagents retain their own activity, pending work, permission, safety and revision guards', async t => {
  for (const blocker of ['active', 'unknown-active', 'inbox', 'permission', 'ask', 'deny', 'unsafe', 'revision', 'new-work']) {
    const f = await fixture(t); f.session.parentID = 'ses_parent';
    const original = f.dependencies.api.call;
    f.dependencies.api.call = async (method, path, body, signal) => {
      if (path === '/api/session/active') return blocker === 'unknown-active' ? null
        : { ses_parent: {}, ...(blocker === 'active' ? { ses_test: {} } : {}) };
      if (blocker === 'inbox' && path.endsWith('/inbox')) return [{}];
      if (blocker === 'permission' && method === 'get' && path.endsWith('/permission')) return [{}];
      if (['ask', 'deny'].includes(blocker) && method === 'post' && path.endsWith('/permission')) return { effect: blocker };
      return original(method, path, body, signal);
    };
    let automatic;
    const assess = f.dependencies.assess;
    f.dependencies.assess = async (caller, trace) => {
      const result = await assess(caller, trace);
      if (blocker === 'revision') f.changeRevision();
      if (blocker === 'new-work') automatic.handle({ ...f.event, type: 'session.inbox.enqueued' });
      return blocker === 'unsafe' ? { ...result, decision: false, assessment: 'unsafe' } : result;
    };
    automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
    automatic.handle(f.event); await automatic.settled();
    assert.equal(f.calls.filter(c => c.method === 'judge').length, ['unsafe', 'revision', 'new-work'].includes(blocker) ? 1 : 0, blocker);
    assert.equal(f.calls.filter(c => c.path?.endsWith('/compact')).length, 0, blocker);
    await automatic.stop();
  }
});

test('same-directory events from another workspace do not read or spend', async t => {
  const f = await fixture(t);
  f.ctx.location.workspaceID = 'wrk_owned';
  f.session.location.workspaceID = 'wrk_owned';
  f.event.location.workspaceID = 'wrk_foreign';
  let reads = 0;
  f.ctx.session.get = async () => { reads++; return f.session; };
  const automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
  automatic.handle(f.event); await automatic.settled();
  assert.equal(reads, 0);
  assert.equal(f.calls.length, 0);
  await automatic.stop();
});

test('new work during hosted inference cancels without compaction or a retry', async t => {
  for (const activity of ['session.inbox.enqueued', 'session.permissions', 'session.moved', 'session.shell.started']) {
    const f = await fixture(t);
    let automatic;
    f.dependencies.assess = async (caller, trace) => {
      f.calls.push({ method: 'judge' }); trace.revision = 'original';
      automatic.handle({ ...f.event, type: activity });
      return safe();
    };
    automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
    automatic.handle(f.event); await automatic.settled();
    assert.equal(f.calls.filter(c => c.method === 'judge').length, 1);
    assert.equal(f.calls.filter(c => c.path?.endsWith('/compact')).length, 0);
    await automatic.stop();
  }
});

test('host activity, pending inbox work and Ask/Deny permissions block autonomous action without overriding rules', async t => {
  for (const blocker of ['active', 'inbox', 'ask', 'deny']) {
    const f = await fixture(t);
    const original = f.dependencies.api.call;
    f.dependencies.api.call = async (method, path, body) => {
      if (blocker === 'active' && path === '/api/session/active') return { ses_background: {} };
      if (blocker === 'inbox' && path.endsWith('/inbox')) return [{ type: 'user' }];
      if (['ask', 'deny'].includes(blocker) && method === 'post' && path.endsWith('/permission')) return { effect: blocker };
      return original(method, path, body);
    };
    const automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
    automatic.handle(f.event); await automatic.settled();
    assert.equal(f.calls.filter(c => c.method === 'judge').length, 0);
    assert.equal(f.calls.filter(c => c.path?.endsWith('/compact')).length, 0);
    await automatic.stop();
  }
});

test('uncertain, unsafe or stale judgments never request compaction', async t => {
  for (const result of [
    { ...safe(), decision: false, assessment: 'uncertain' },
    { ...safe(), decision: false, assessment: 'unsafe' },
    { decision: null, error: 'stale-context', hostedCalls: 1 },
  ]) {
    const f = await fixture(t);
    f.dependencies.assess = async () => result;
    const automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
    automatic.handle(f.event); await automatic.settled();
    assert.equal(f.calls.filter(c => c.path?.endsWith('/compact')).length, 0);
    await automatic.stop();
  }
});

test('the final revision and compaction permission are rechecked after a positive assessment', async t => {
  for (const blocker of ['revision', 'permission', 'queued']) {
    const f = await fixture(t);
    const original = f.dependencies.assess;
    f.dependencies.assess = async (caller, trace) => {
      const result = await original(caller, trace);
      if (blocker === 'revision') f.changeRevision();
      if (blocker === 'permission') f.dependencies.api.call = async () => ({ effect: 'deny' });
      if (blocker === 'queued') f.dependencies.api.call = async (method, path) => path.endsWith('/inbox') ? [{}] : path.endsWith('/permission') ? { effect: 'allow' } : {};
      return result;
    };
    const automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
    automatic.handle(f.event); await automatic.settled();
    assert.equal(f.calls.filter(c => c.path?.endsWith('/compact')).length, 0);
    await automatic.stop();
  }
});

test('persistent pilot limits and deduplication survive reload and do not store session contents', async t => {
  const f = await fixture(t);
  f.options.maxChecks = 1; f.options.maxCompactions = 1;
  let automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
  automatic.handle(f.event); await automatic.settled(); await automatic.stop();
  automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
  f.event.created++; f.messages.at(-1).time.created++; f.session.time.idle++;
  automatic.handle(f.event); await automatic.settled();
  assert.equal(f.calls.filter(c => c.method === 'judge').length, 1);
  assert.equal(f.calls.filter(c => c.path?.endsWith('/compact')).length, 1);
  const saved = readdirSync(join(f.directory, 'automatic')).filter(name => name.endsWith('.json'))
    .map(name => readFileSync(join(f.directory, 'automatic', name), 'utf8')).join('');
  assert.ok(!saved.includes('PRIVATE'));
  assert.ok(!saved.includes('ses_test'));
  assert.equal(statSync(join(f.directory, 'automatic')).mode & 0o777, 0o700);
  for (const name of readdirSync(join(f.directory, 'automatic'))) assert.equal(statSync(join(f.directory, 'automatic', name)).mode & 0o777, 0o600);
  await automatic.stop();
});

test('unavailable telemetry and a malformed pilot ledger fail closed without spending again', async t => {
  const f = await fixture(t);
  let automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
  f.dependencies.telemetry.status = () => ({ state: 'unavailable' });
  automatic.handle(f.event); await automatic.settled();
  assert.equal(f.calls.length, 0);
  f.dependencies.telemetry.status = () => ({ state: 'active' });
  automatic.handle(f.event); await automatic.settled(); await automatic.stop();
  const name = readdirSync(join(f.directory, 'automatic')).find(n => n.endsWith('.json'));
  const path = join(f.directory, 'automatic', name), ledger = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...ledger, unexpected: 'PRIVATE MALFORMED FIELD' }));
  automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
  f.event.created += 10000; f.messages.at(-1).time.created += 10000; f.session.time.idle += 10000;
  automatic.handle(f.event); await automatic.settled();
  assert.equal(f.calls.filter(c => c.method === 'judge').length, 1);
  assert.equal(automatic.status().lastReason, 'automatic-ledger');
  await automatic.stop();
});

test('the native events from its own compaction admission do not cancel the acknowledgement', async t => {
  const f = await fixture(t);
  const original = f.dependencies.api.call;
  let automatic;
  f.dependencies.api.call = async (method, path, body, signal) => {
    if (path.endsWith('/compact')) {
      automatic.handle({ ...f.event, type: 'session.inbox.enqueued', data: { sessionID: f.session.id, inboxID: body.id } });
      automatic.handle({ ...f.event, type: 'session.execution.started' });
      automatic.handle({ ...f.event, type: 'session.compaction.started', data: { sessionID: f.session.id, inputID: body.id } });
      signal.throwIfAborted();
    }
    return original(method, path, body);
  };
  automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
  automatic.handle(f.event); await automatic.settled();
  assert.equal(f.records.at(-1).result.compactionStatus, 'admitted');
  assert.equal(f.records.at(-1).result.error, undefined);
  await automatic.stop();
});

test('new activity and shutdown cancel pending checks; expired pilots do nothing', async t => {
  const f = await fixture(t);
  let automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
  automatic.handle(f.event);
  automatic.handle({ ...f.event, type: 'session.inbox.enqueued' });
  await automatic.settled();
  assert.equal(f.calls.filter(c => c.method === 'judge').length, 0);
  automatic.handle(f.event); await automatic.stop();
  assert.equal(f.calls.filter(c => c.method === 'judge').length, 0);
  automatic = await startAutomatic(f.ctx, { ...f.options, expiresAt: new Date(Date.now() - 1).toISOString() }, f.dependencies);
  automatic.handle(f.event); await automatic.settled();
  assert.equal(f.calls.filter(c => c.method === 'judge').length, 0);
  await automatic.stop();
});

test('authenticated API bridge refuses a different server PID before any mutation and sanitizes errors', async () => {
  const calls = [];
  const api = createHostApi('/owned', async args => {
    calls.push(args);
    return JSON.stringify({ pid: process.pid + 1 });
  });
  await assert.rejects(api.call('post', '/api/session/ses_test/compact', {}), /host-api/);
  assert.equal(calls.length, 1);
  const broken = createHostApi('/owned', async () => { throw new Error('PRIVATE AUTH DIAGNOSTIC'); });
  await assert.rejects(broken.call('get', '/api/session/active'), error => error.message === 'host-api');
});

test('cooldowns and an exclusive pilot lease prevent duplicate spending across plugin instances', async t => {
  const f = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const original = f.dependencies.assess;
  f.dependencies.assess = async (...args) => { await gate; return original(...args); };
  const first = await startAutomatic(f.ctx, f.options, f.dependencies);
  const second = await startAutomatic(f.ctx, f.options, f.dependencies);
  first.handle(f.event); second.handle(f.event);
  await new Promise(resolve => setTimeout(resolve, 10));
  release(); await first.settled(); await second.settled();
  assert.equal(f.calls.filter(c => c.method === 'judge').length, 1);
  f.event.created++; f.messages.at(-1).time.created++; f.messages.at(-1).id = 'msg_new_idle'; f.session.time.idle++;
  first.handle(f.event); await first.settled();
  assert.equal(f.calls.filter(c => c.method === 'judge').length, 1, 'a new checkpoint inside the cooldown cannot spend again');
  await first.stop(); await second.stop();
});

test('compaction completion is reported only after reading back the exact admitted native message', async t => {
  for (const status of ['completed', 'failed', 'unknown']) {
    const f = await fixture(t);
    const original = f.dependencies.api.call;
    let id;
    f.dependencies.api.call = async (method, path, body) => {
      if (path.endsWith('/compact')) id = body.id;
      if (path.includes('/message/')) return { id: status === 'unknown' ? 'msg_other' : id, type: 'compaction', status,
        summary: 'PRIVATE SUMMARY', error: { message: 'PRIVATE FAILURE' }, cost: 0, model: { providerID: 'fixture', id: 'model' } };
      return original(method, path, body);
    };
    const automatic = await startAutomatic(f.ctx, f.options, f.dependencies);
    automatic.handle(f.event); await automatic.settled();
    automatic.handle({ ...f.event, type: status === 'failed' ? 'session.compaction.failed' : 'session.compaction.ended' });
    await automatic.settled();
    const event = f.records.at(-1);
    assert.equal(event.mode, 'automatic-compaction');
    assert.equal(event.result.compactionStatus, status);
    assert.ok(!JSON.stringify(event).includes('PRIVATE'));
    await automatic.stop();
  }
});

test('API bridge uses authenticated argument arrays and unwraps data only after matching this process', async () => {
  const calls = [];
  const api = createHostApi('/owned', async args => {
    calls.push(args);
    return JSON.stringify(args[2] === '/api/info' ? { pid: process.pid } : { data: { id: 'msg_test', type: 'compaction' } });
  });
  assert.deepEqual(await api.call('post', '/api/session/ses_test/compact', { id: 'msg_test', delivery: 'queue' }), { id: 'msg_test', type: 'compaction' });
  assert.deepEqual(calls[1], ['api', 'post', '/api/session/ses_test/compact', '--data', '{"id":"msg_test","delivery":"queue"}']);
});

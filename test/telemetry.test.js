import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, rmSync, chmodSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTelemetry } from '../src/telemetry.js';

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'defrag-telemetry-'));
  t.after(() => rmSync(root, { recursive: true }));
  return join(root, 'logs');
}

const input = () => ({ mode: 'hosted-check', sessionID: 'ses_PRIVATE_SESSION', durationMs: 12.345,
  stateVersion: 4, snapshot: { fingerprint: 'a'.repeat(64), encodedStateBytes: 1234, activeTools: 0,
    state: { latestRequest: { status: 'available', text: 'PRIVATE REQUEST', loss: { redacted: true, textClipped: false } },
      recent: [{ text: 'PRIVATE CONVERSATION' }], coverage: { omittedEntries: 2, textClippedEntries: 1,
        redactedEntries: 1, omittedToolStatuses: 0, sourceHistory: { startsAt: 'compaction-summary' } },
      retainedContext: { status: 'excluded', reason: 'structured-source-unavailable', sourceBytes: 456,
        entries: [{ text: 'PRIVATE RETAINED' }], loss: { rawTranscriptExcluded: true } } } },
  secret: 'fixture-key', result: { decision: false, assessment: 'uncertain', hostedCalls: 1, stateUnchanged: true,
    score: 0.42, floor: 0.9, recipe: 'checkpoint-v2', resolvedModel: 'jev-fixture', usage: { input: 100, output: 50 },
    blockedBy: ['scope'], axes: { scope: { choice: 'unclear', probabilities: { sufficient: 0.1, insufficient: 0.1, unclear: 0.8 } } },
    rawResponse: 'PRIVATE RESPONSE', warning: 'PRIVATE WARNING' } });

test('telemetry is disabled by default, performs no IO and rejects ambiguous configuration', async () => {
  const io = { open: () => { throw new Error('IO forbidden'); } };
  for (const options of [undefined, false]) {
    const log = await createTelemetry(options, io);
    assert.equal(log, null);
  }
  for (const options of [true, {}, { directory: 'relative' }, { directory: '/absolute', text: true }]) {
    await assert.rejects(createTelemetry(options, io), /telemetry/);
  }
});

test('telemetry writes private allowlisted JSONL, hashes session IDs, bounds records and isolates plugin instances', async t => {
  const path = directory(t);
  const log = await createTelemetry({ directory: path });
  const other = await createTelemetry({ directory: path });
  const receipt = log.record(input());
  other.record(input());
  assert.match(receipt.eventID, /^[a-f0-9-]{36}$/);
  assert.equal(receipt.accepted, true);
  await log.close(); await other.close();
  assert.equal(statSync(path).mode & 0o777, 0o700);
  const files = readdirSync(path);
  assert.equal(files.length, 2);
  for (const file of files) {
    assert.equal(statSync(join(path, file)).mode & 0o777, 0o600);
    const bytes = readFileSync(join(path, file), 'utf8');
    assert.ok(Buffer.byteLength(bytes) <= 4096);
    const event = JSON.parse(bytes);
    assert.equal(event.version, 1);
    assert.match(event.sessionHash, /^[a-f0-9]{64}$/);
    assert.equal(event.durationMs, 12.35);
    assert.equal(event.snapshot.encodedStateBytes, 1234);
    assert.equal(event.snapshot.loss.omittedEntries, 2);
    assert.equal(event.snapshot.latestRequest.status, 'available');
    assert.equal(event.snapshot.retainedContext.sourceBytes, 456);
    assert.deepEqual(event.result.axes.scope, input().result.axes.scope);
    assert.deepEqual(event.result.usage, { input: 100, output: 50 });
    for (const forbidden of ['PRIVATE', 'fixture-key', 'rawResponse', 'warning', 'recent', 'entries', 'secret']) {
      assert.ok(!bytes.includes(forbidden));
    }
  }
  assert.equal(log.status().written, 1);
});

test('telemetry never copies arbitrary strings or unknown probabilities into logs, including the known key in model IDs', async t => {
  const path = directory(t);
  const log = await createTelemetry({ directory: path });
  const value = input();
  value.result.resolvedModel = 'fixture-key';
  value.result.error = 'PRIVATE DIAGNOSTIC';
  value.result.axes.scope.choice = 'PRIVATE CHOICE';
  value.result.axes.scope.probabilities.PRIVATE = 0.5;
  value.result.blockedBy = ['scope', 'PRIVATE BLOCKER'];
  value.snapshot.state.retainedContext.reason = 'PRIVATE REASON';
  value.snapshot.state.latestRequest.status = 'PRIVATE STATUS';
  value.snapshot.state.coverage.omittedEntries = 'PRIVATE NUMBER';
  value.snapshot.fingerprint = { toString: () => 'a'.repeat(64), toJSON: () => 'PRIVATE FINGERPRINT OBJECT' };
  log.record(value);
  await log.close();
  const bytes = readFileSync(join(path, readdirSync(path)[0]), 'utf8');
  assert.ok(!bytes.includes('PRIVATE'));
  assert.ok(!bytes.includes('fixture-key'));
});

test('automatic telemetry separates admission, completion, failure and skips without copying native summary payloads', async t => {
  const path = directory(t), log = await createTelemetry({ directory: path });
  for (const compactionStatus of ['admitted', 'completed', 'failed', 'unknown']) {
    log.record({ ...input(), mode: compactionStatus === 'admitted' ? 'automatic-check' : 'automatic-compaction',
      target: compactionStatus === 'admitted' ? 'loopback-fixture' : 'native-host',
      result: { ...input().result, compactionRequested: true, compactionStatus },
      nativeCompaction: { modelHash: 'b'.repeat(64), cost: 0.1, tokens: { input: 5, output: 3, reasoning: 1, cache: { read: 2, write: 0 } },
        summary: 'PRIVATE SUMMARY', recent: 'PRIVATE TRANSCRIPT', error: 'PRIVATE DIAGNOSTIC' } });
  }
  log.record({ mode: 'automatic-check', result: { error: 'automatic-permission', hostedCalls: 0, compactionRequested: false } });
  log.record({ ...input(), result: { ...input().result, compactionRequested: true } });
  await log.close();
  const text = readFileSync(join(path, readdirSync(path)[0]), 'utf8'), events = text.trim().split('\n').map(JSON.parse);
  assert.ok(!text.includes('PRIVATE'));
  assert.deepEqual(events.slice(0, 4).map(e => e.compactionStatus), ['admitted', 'completed', 'failed', 'unknown']);
  assert.ok(events.slice(0, 4).every(e => e.compactionRequested && e.nativeCompaction.cost === 0.1));
  assert.equal(events[4].error, 'automatic-permission');
  assert.equal(events[4].compactionRequested, false);
  assert.equal(events[5].compactionRequested, false, 'manual results cannot claim compaction');
});

test('slow writes do not block record submission, queue is bounded and close has a bounded wait', async t => {
  const path = directory(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const log = await createTelemetry({ directory: path }, { open: async (...args) => {
    const handle = await open(...args);
    return { writeFile: async line => { await gate; return handle.writeFile(line); }, close: () => handle.close() };
  } });
  t.after(release);
  for (let i = 0; i < 200; i++) log.record(input());
  assert.ok(log.status().queued <= 64);
  assert.ok(log.status().dropped >= 135);
  assert.equal(log.status().written, 0, 'submissions must finish while disk write remains blocked');
  await log.close();
  assert.equal(log.status().state, 'closed');
  assert.equal(log.record(input()).accepted, false);
  release();
  await log.drained;
});

test('unsafe directories and symlinks disable logging without exposing filesystem diagnostics', async t => {
  for (const kind of ['public', 'symlink', 'file']) {
    const path = directory(t);
    if (kind === 'file') { const handle = await open(path, 'wx', 0o600); await handle.close(); }
    else if (kind === 'public') { mkdirSync(path); chmodSync(path, 0o755); }
    else { mkdirSync(path + '-target', { mode: 0o700 }); symlinkSync(path + '-target', path); }
    const log = await createTelemetry({ directory: path });
    assert.equal(log.status().state, 'unavailable');
    assert.equal(log.record(input()).accepted, false);
    assert.equal(log.status().errors, 1);
    assert.ok(!JSON.stringify(log.status()).includes(path));
    await log.close();
  }
});

test('hard-limit telemetry labels a policy override without fabricating a Jev recipe or judgment', async t => {
  const path = directory(t), log = await createTelemetry({ directory: path });
  log.record({ mode: 'automatic-check', target: 'native-host', sessionID: 'ses_PRIVATE', stateVersion: 3,
    pressure: { inputTokens: 34000, usedTokens: 35000, contextTokens: 100000, hardLimitRatio: 0.35, text: 'PRIVATE' },
    result: { trigger: 'hard-limit', hostedCalls: 0, decision: null, stateUnchanged: true, compactionRequested: true, compactionStatus: 'admitted' } });
  await log.close();
  const raw = readFileSync(join(path, readdirSync(path)[0]), 'utf8'), value = JSON.parse(raw);
  assert.equal(value.trigger, 'hard-limit');
  assert.equal(value.recipe, null);
  assert.equal(value.hostedCalls, 0);
  assert.equal(value.result.assessment, null);
  assert.deepEqual(value.pressure, { inputTokens: 34000, usedTokens: 35000, contextTokens: 100000, hardLimitRatio: 0.35 });
  assert.ok(!raw.includes('PRIVATE'));
});

test('ineligible telemetry retains only bounded guard reasons, never arbitrary diagnostics', async t => {
  const path = directory(t), log = await createTelemetry({ directory: path });
  for (const ineligibleReason of ['foreign-location', 'child-session', 'below-minimum-input', 'PRIVATE raw diagnostic']) {
    log.record({ mode: 'automatic-check', ineligibleReason, result: { error: 'automatic-ineligible', hostedCalls: 0 } });
  }
  await log.close();
  const raw = readFileSync(join(path, readdirSync(path)[0]), 'utf8');
  const events = raw.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(e => e.ineligibleReason), ['foreign-location', 'child-session', 'below-minimum-input', null]);
  assert.ok(!raw.includes('PRIVATE'));
});

test('write failures are contained, drop bounded work and never return raw errors', async t => {
  const log = await createTelemetry({ directory: directory(t) }, { open: async () => ({
    writeFile: async () => { throw new Error('PRIVATE DISK FAILURE'); }, close: async () => {},
  }) });
  log.record(input()); log.record(input());
  await log.close();
  assert.equal(log.status().errors, 1);
  assert.equal(log.status().written, 0);
  assert.equal(log.status().dropped, 2);
  assert.ok(!JSON.stringify(log.status()).includes('PRIVATE'));
});

test('each plugin instance has an 8 MiB disk cap and reports saturation rather than growing without bound', async t => {
  const path = directory(t);
  const log = await createTelemetry({ directory: path });
  const value = input();
  for (let i = 0; i < 30000 && log.status().state === 'active'; i++) {
    log.record(value);
    if (i % 32 === 0) await log.flush();
  }
  await log.close();
  assert.equal(log.status().state, 'full');
  assert.ok(log.status().dropped > 0);
  const size = statSync(join(path, readdirSync(path)[0])).size;
  assert.ok(size > 8 * 1024 * 1024 - 4096);
  assert.ok(size <= 8 * 1024 * 1024);
});

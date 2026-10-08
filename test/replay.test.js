import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fingerprint } from '../src/evaluation.js';

const cli = new URL('../src/cli.js', import.meta.url).pathname;
const temporary = [];
after(() => { for (const path of temporary) rmSync(path, { recursive: true }); });
function run(...args) { return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' }); }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'defrag-replay-'));
  temporary.push(dir);
  const corpus = join(dir, 'corpus.jsonl'), predictions = join(dir, 'predictions.jsonl');
  const record = { id: 'probe', group: 'family', state: { recent: [{ role: 'assistant', text: 'PRIVATE TRANSCRIPT' }] } };
  const prediction = { version: 1, id: record.id, fingerprint: fingerprint(record),
    judge: 'jev-v2:jev-latest:checkpoint-v2', decision: false, assessment: 'uncertain', score: 0.78, floor: 0.9,
    axes: {
      scope: { choice: 'sufficient', probabilities: { sufficient: 0.78, insufficient: 0.02, unclear: 0.2 } },
      obligation: { choice: 'settled', probabilities: { settled: 0.96, owed: 0.01, unclear: 0.03 } },
      preservation: { choice: 'recoverable', probabilities: { recoverable: 0.88, unrecoverable: 0.02, unclear: 0.1 } },
      consistency: { choice: 'current', probabilities: { current: 0.97, conflicting: 0.01, unclear: 0.02 } },
    }, latencyMs: 282, resolvedModel: 'jev-fixture', usage: { input: 100, output: 50 },
    settings: { recipe: 'checkpoint-v2' }, diagnostic: 'PRIVATE RESPONSE' };
  const write = () => {
    writeFileSync(corpus, JSON.stringify(record) + '\n');
    writeFileSync(predictions, JSON.stringify(prediction) + '\n');
  };
  write();
  return { dir, corpus, predictions, record, prediction, write };
}

test('offline replay compares a confidence floor without changing saved judgments or attributing new inference', () => {
  const { dir, corpus, predictions } = fixture();
  const before = readFileSync(predictions), corpusBefore = readFileSync(corpus);
  const out = join(dir, 'replay.jsonl');
  const result = run('replay', '--corpus', corpus, '--predictions', predictions, '--out', out, '--floor', '0.7');
  assert.equal(result.status, 0, result.stderr);
  const p = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(p.judge, 'offline-v1:jev-v2:jev-latest:checkpoint-v2:floor-0.7');
  assert.equal(p.decision, true);
  assert.equal(p.assessment, 'safe');
  assert.equal(p.score, 0.78);
  assert.equal(p.floor, 0.7);
  assert.deepEqual(p.blockedBy, []);
  assert.equal(p.source.judge, 'jev-v2:jev-latest:checkpoint-v2');
  assert.equal(p.source.decision, false);
  assert.equal(p.source.floor, 0.9);
  assert.equal(p.source.latencyMs, 282);
  assert.equal(p.settings.mode, 'offline-confidence-replay-v1');
  assert.ok(!Object.hasOwn(p, 'usage'), 'a replay has no new billed inference');
  for (const secret of ['PRIVATE TRANSCRIPT', 'PRIVATE RESPONSE']) assert.ok(!(result.stdout + result.stderr + readFileSync(out, 'utf8')).includes(secret));
  assert.deepEqual(readFileSync(predictions), before);
  assert.deepEqual(readFileSync(corpus), corpusBefore);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.notEqual(run('replay', '--corpus', corpus, '--predictions', predictions, '--out', out, '--floor', '0.7').status, 0);
});

test('choice-only replay is explicitly experimental and cannot turn unclear or negative choices into recommendations', () => {
  const { dir, corpus, predictions, prediction, write } = fixture();
  const args = ['replay', '--corpus', corpus, '--predictions', predictions, '--floor', 'choices'];
  const out = join(dir, 'choices.jsonl');
  assert.equal(run(...args, '--out', out).status, 0);
  const positive = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(positive.decision, true);
  assert.equal(positive.judge, 'offline-v1:jev-v2:jev-latest:checkpoint-v2:floor-choices');
  assert.equal(positive.settings.experimental, true);
  assert.equal(positive.floor, 0);
  for (const choice of ['unclear', 'insufficient']) {
    prediction.axes.scope = { choice, probabilities: { sufficient: 0.02, insufficient: choice === 'insufficient' ? 0.96 : 0.02, unclear: choice === 'unclear' ? 0.96 : 0.02 } };
    prediction.score = 0.02;
    prediction.assessment = choice === 'insufficient' ? 'unsafe' : 'uncertain';
    write();
    const blocked = join(dir, choice + '.jsonl');
    assert.equal(run(...args, '--out', blocked).status, 0);
    const p = JSON.parse(readFileSync(blocked, 'utf8'));
    assert.equal(p.decision, false);
    assert.equal(p.assessment, prediction.assessment);
    assert.deepEqual(p.blockedBy, ['scope']);
  }
});

test('replay refuses stale fingerprints, duplicate sources, unknown IDs and non-v2 judgments before writing output', () => {
  const { dir, corpus, predictions, record, prediction, write } = fixture();
  const original = JSON.stringify(prediction);
  const cases = [
    ['stale', /Stale prediction/, () => { prediction.fingerprint = 'stale'; }],
    ['unknown-id', /Unknown checkpoint/, () => { prediction.id = 'unknown'; }],
    ['wrong-recipe', /checkpoint-v2/, () => { prediction.settings.recipe = 'done-shape-v1'; }],
    ['private-judge', /checkpoint-v2/, () => { prediction.judge = 'PRIVATE PROVIDER ID'; }],
    ['duplicate', /Duplicate prediction/, () => { writeFileSync(predictions, JSON.stringify(prediction) + '\n' + JSON.stringify(prediction)); }],
    ['duplicate-corpus', /Duplicate corpus/, () => { writeFileSync(corpus, JSON.stringify(record) + '\n' + JSON.stringify(record)); }],
  ];
  for (const [name, message, mutate] of cases) {
    Object.assign(prediction, JSON.parse(original));
    write(); mutate();
    if (!name.startsWith('duplicate')) write();
    const out = join(dir, name + '.jsonl');
    const result = run('replay', '--corpus', corpus, '--predictions', predictions, '--out', out, '--floor', '0.7');
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, message);
    assert.ok(!result.stderr.includes('PRIVATE PROVIDER ID'));
    assert.throws(() => readFileSync(out), { code: 'ENOENT' });
  }
});

test('replay preserves failures and abstains on malformed or contradictory saved axes without leaking diagnostics', () => {
  const { dir, corpus, predictions, prediction, write } = fixture();
  const original = JSON.stringify(prediction);
  const cases = [
    ['failed', p => { p.decision = null; p.error = 'PRIVATE ERROR'; }],
    ['missing', p => { delete p.axes.scope; }],
    ['extra', p => { p.axes.injected = 'PRIVATE EXTRA'; }],
    ['null-probability', p => { p.axes.scope.probabilities.sufficient = null; }],
    ['bad-sum', p => { p.axes.scope.probabilities.sufficient = 0.99; }],
    ['unknown-option', p => { p.axes.scope.probabilities.injected = 0; }],
    ['wrong-choice', p => { p.axes.scope.choice = 'unclear'; }],
    ['private-choice', p => { p.axes.scope.choice = 'PRIVATE CHOICE'; }],
    ['wrong-decision', p => { p.decision = true; }],
    ['wrong-floor', p => { p.floor = 'PRIVATE FLOOR'; }],
    ['wrong-score', p => { p.score = 1; }],
  ];
  for (const [name, mutate] of cases) {
    Object.keys(prediction).forEach(key => delete prediction[key]);
    Object.assign(prediction, JSON.parse(original));
    mutate(prediction); write();
    const out = join(dir, name + '.jsonl');
    const r = run('replay', '--corpus', corpus, '--predictions', predictions, '--out', out, '--floor', 'choices');
    assert.equal(r.status, 0, r.stderr);
    const p = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(p.decision, null, name);
    assert.equal(p.error, name === 'failed' ? 'source-failure' : 'response');
    assert.ok(!Object.hasOwn(p, 'assessment'));
    assert.ok(!Object.hasOwn(p, 'axes'));
    assert.ok(!(r.stdout + r.stderr + readFileSync(out, 'utf8')).includes('PRIVATE'));
  }
});

test('a stricter replay floor withholds a previously positive judgment without claiming it is safe', () => {
  const { dir, corpus, predictions, prediction, write } = fixture();
  prediction.axes.scope.probabilities = { sufficient: 0.92, insufficient: 0.02, unclear: 0.06 };
  prediction.axes.preservation.probabilities = { recoverable: 0.94, unrecoverable: 0.02, unclear: 0.04 };
  prediction.decision = true; prediction.assessment = 'safe'; prediction.score = 0.92;
  write();
  const out = join(dir, 'strict.jsonl');
  assert.equal(run('replay', '--corpus', corpus, '--predictions', predictions, '--out', out, '--floor', '0.95').status, 0);
  const p = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(p.decision, false);
  assert.equal(p.assessment, 'uncertain');
  assert.deepEqual(p.blockedBy, ['scope', 'preservation']);
  assert.equal(p.source.decision, true);
});

test('replay distinguishes nonpositive choices from positive choices below the confidence floor', () => {
  const { dir, corpus, predictions, prediction, write } = fixture();
  prediction.axes.preservation = { choice: 'unclear', probabilities: { recoverable: 0.2, unrecoverable: 0.02, unclear: 0.78 } };
  prediction.score = 0.2; write();
  const out = join(dir, 'blocker-types.jsonl');
  assert.equal(run('replay', '--corpus', corpus, '--predictions', predictions, '--out', out, '--floor', '0.8').status, 0);
  const p = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(p.decision, false);
  assert.deepEqual(p.choiceBlockedBy, ['preservation']);
  assert.deepEqual(p.confidenceBlockedBy, ['scope']);
  assert.deepEqual(p.blockedBy, ['scope', 'preservation']);
});

test('replay requires an explicit bounded floor, rejects remote options and supports separate source providers', () => {
  const { dir, corpus, predictions, prediction } = fixture();
  const args = ['replay', '--corpus', corpus, '--predictions', predictions];
  for (const value of ['0', '-1', '1.1', 'NaN', 'Infinity', 'PRIVATE INVALID FLOOR']) {
    const r = run(...args, '--out', join(dir, `invalid-${value.replaceAll('/', '_')}.jsonl`), '--floor', value);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /floor must be/);
    assert.ok(!r.stderr.includes('PRIVATE INVALID FLOOR'));
  }
  assert.match(run(...args, '--out', join(dir, 'missing-floor.jsonl')).stderr, /requires/);
  assert.match(run(...args, '--out', join(dir, 'remote.jsonl'), '--floor', 'choices', '--endpoint', 'https://example.invalid').stderr, /Unknown option/);
  const second = { ...prediction, judge: 'decisions-v2:gpt-6-luna:checkpoint-v2' };
  writeFileSync(predictions, JSON.stringify(prediction) + '\n' + JSON.stringify(second));
  const out = join(dir, 'both.jsonl');
  assert.equal(run(...args, '--out', out, '--floor', '0.9').status, 0);
  const replayed = readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(replayed.length, 2);
  assert.equal(new Set(replayed.map(p => p.judge)).size, 2);
  assert.ok(replayed.every(p => p.decision === false && p.assessment === 'uncertain' && p.score === 0.78));
});

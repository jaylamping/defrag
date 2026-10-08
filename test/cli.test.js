import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';

const cli = new URL('../src/cli.js', import.meta.url).pathname;
const temporary = [];
after(() => { for (const path of temporary) rmSync(path, { recursive: true }); });
function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'defrag-test-'));
  temporary.push(dir);
  const path = join(dir, 'source.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE session_v2 (id TEXT, parent_id TEXT, directory TEXT);
    CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT);`);
  const session = db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?)');
  session.run('root', null, '/private/project');
  session.run('child', 'root', '/private/project');
  const insert = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)');
  const add = (id, seq, type, data) => insert.run(`${id}-${seq}`, id, type, seq, JSON.stringify(data));
  for (const id of ['root', 'child']) {
    add(id, 1, 'user', { text: 'Keep the compatibility contract. API_KEY=do-not-export-me' });
    add(id, 2, 'assistant', { time: { completed: 2 }, finish: 'stop', model: { providerID: 'test', id: 'test' },
      tokens: { input: 1000, output: 100, cache: { read: 40000, write: 0 } },
      content: [{ type: 'reasoning', text: 'HIDDEN REASONING' }, { type: 'text', text: 'Work verified and saved.' },
        { type: 'tool', name: 'shell', state: { status: 'completed', input: { command: 'PRIVATE COMMAND' }, content: [{ type: 'text', text: 'PRIVATE OUTPUT' }] } }] });
    add(id, 3, 'idle', { outcome: 'succeeded' });
    add(id, 4, 'user', { text: 'FUTURE TASK: change something else.' });
  }
  db.close();
  return { dir, path };
}

test('extract writes private, redacted root checkpoints without future leakage', () => {
  const { dir, path } = fixture();
  const before = readFileSync(path);
  const out = join(dir, 'corpus.jsonl');
  const result = run('extract', '--db', path, '--out', out, '--context-limit', '100000');
  assert.equal(result.status, 0, result.stderr);
  const records = readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 1);
  assert.equal(records[0].inputTokens, 41000);
  assert.equal(records[0].contextLimit, 100000);
  assert.equal(records[0].label, null);
  assert.match(records[0].review.nextUser, /FUTURE TASK/);
  const state = JSON.stringify(records[0].state);
  for (const secret of ['do-not-export-me', 'HIDDEN REASONING', 'PRIVATE COMMAND', 'PRIVATE OUTPUT', 'FUTURE TASK']) assert.ok(!state.includes(secret));
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(path), before);
  assert.notEqual(run('extract', '--db', path, '--out', out).status, 0, 'must not overwrite a corpus');
});

function runAsync(...args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cli, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

test('local prediction sends only checkpoint state and abstains on malformed responses', async () => {
  const { dir } = fixture();
  const corpus = join(dir, 'corpus.jsonl');
  const out = join(dir, 'predictions.jsonl');
  writeFileSync(corpus, JSON.stringify({ id: 'a', group: 'g', state: { recent: [{ role: 'assistant', text: 'Done.' }] }, review: { nextUser: 'FUTURE MUST NOT LEAK' } }) + '\n');
  const requests = [];
  let valid = true;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: valid ? '{"safe":true}' : '{"safe":"yes"}' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  try {
    const r = await runAsync('predict', '--corpus', corpus, '--out', out, '--judge', 'local', '--endpoint', endpoint, '--model', 'fixture');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).decision, true);
    const duplicate = await runAsync('predict', '--corpus', corpus, '--out', out, '--judge', 'local', '--endpoint', endpoint, '--model', 'fixture');
    assert.notEqual(duplicate.status, 0);
    assert.equal(requests.length, 1, 'existing output must be rejected before model work');
    assert.ok(!JSON.stringify(requests).includes('FUTURE MUST NOT LEAK'));
    assert.equal(requests[0].model, 'fixture');
    valid = false;
    const bad = join(dir, 'bad.jsonl');
    assert.equal((await runAsync('predict', '--corpus', corpus, '--out', bad, '--judge', 'local', '--endpoint', endpoint, '--model', 'fixture')).status, 0);
    assert.equal(JSON.parse(readFileSync(bad, 'utf8')).decision, null);
    assert.equal(JSON.parse(readFileSync(bad, 'utf8')).error, 'response');
    const remote = run('predict', '--corpus', corpus, '--out', join(dir, 'remote.jsonl'), '--judge', 'local', '--endpoint', 'https://example.com/v1/chat/completions', '--model', 'fixture');
    assert.notEqual(remote.status, 0);
    assert.match(remote.stderr, /loopback/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('label and score use only human-reviewed labels and count failures as abstentions', () => {
  const { dir } = fixture();
  const corpus = join(dir, 'corpus.jsonl');
  const labels = join(dir, 'labels.jsonl');
  const predictions = join(dir, 'predictions.jsonl');
  const report = join(dir, 'report.json');
  writeFileSync(corpus, ['a', 'b', 'c', 'd'].map(id => JSON.stringify({ version: 1, id, group: id, state: {}, label: null })).join('\n'));
  for (const [id, decision] of [['a', 'safe'], ['b', 'unsafe'], ['c', 'safe']]) {
    const r = run('label', '--corpus', corpus, '--out', labels, '--id', id, '--decision', decision, '--reviewer', 'human', '--note', 'Reviewed checkpoint and constraints.');
    assert.equal(r.status, 0, r.stderr);
  }
  const reviewed = readFileSync(labels, 'utf8').trim().split('\n').map(JSON.parse);
  writeFileSync(predictions, [
    { id: 'a', judge: 'rules-v1', decision: true, latencyMs: 0 },
    { id: 'b', judge: 'rules-v1', decision: true, latencyMs: 0 },
    { id: 'c', judge: 'rules-v1', decision: null, error: 'response', latencyMs: 5 },
  ].map(p => JSON.stringify({ ...p, fingerprint: reviewed.find(l => l.id === p.id)?.fingerprint ?? 'unused' })).join('\n'));
  const r = run('score', '--corpus', corpus, '--labels', labels, '--predictions', predictions, '--out', report);
  assert.equal(r.status, 0, r.stderr);
  const metrics = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(metrics.reviewed, 3);
  assert.equal(metrics.unreviewed, 1);
  assert.equal(metrics.judges['rules-v1'].precision, 0.5);
  assert.equal(metrics.judges['rules-v1'].recall, 0.5);
  assert.equal(metrics.judges['rules-v1'].abstentions, 1);
  assert.equal(metrics.judges['rules-v1'].falsePositive, 1);
  assert.equal(statSync(labels).mode & 0o777, 0o600);
});

test('rules and threshold predictions preserve unknown limits as abstentions', () => {
  const { dir, path } = fixture();
  const corpus = join(dir, 'corpus.jsonl');
  assert.equal(run('extract', '--db', path, '--out', corpus).status, 0);
  const rules = join(dir, 'rules.jsonl');
  assert.equal(run('predict', '--corpus', corpus, '--out', rules, '--judge', 'rules').status, 0);
  assert.equal(JSON.parse(readFileSync(rules, 'utf8')).decision, true);
  const threshold = join(dir, 'threshold.jsonl');
  assert.equal(run('predict', '--corpus', corpus, '--out', threshold, '--judge', 'threshold').status, 0);
  const p = JSON.parse(readFileSync(threshold, 'utf8'));
  assert.equal(p.decision, null);
  assert.equal(p.error, 'unknown-context-limit');
});

test('score refuses unreviewed corpora, stale labels and duplicate predictions', () => {
  const { dir, path } = fixture();
  const corpus = join(dir, 'corpus.jsonl'), labels = join(dir, 'labels.jsonl'), predictions = join(dir, 'predictions.jsonl');
  run('extract', '--db', path, '--out', corpus);
  writeFileSync(labels, '', { mode: 0o600 });
  run('predict', '--corpus', corpus, '--out', predictions, '--judge', 'rules');
  const scoreArgs = ['score', '--corpus', corpus, '--labels', labels, '--predictions', predictions, '--out', join(dir, 'report.json')];
  assert.match(run(...scoreArgs).stderr, /No reviewed/);
  const r = JSON.parse(readFileSync(corpus, 'utf8'));
  assert.equal(run('label', '--corpus', corpus, '--out', labels, '--id', r.id, '--decision', 'safe', '--reviewer', 'human', '--note', 'Verified').status, 0);
  const p = readFileSync(predictions, 'utf8');
  writeFileSync(predictions, p + p);
  assert.match(run(...scoreArgs).stderr, /Duplicate prediction/);
  writeFileSync(predictions, p);
  const unsigned = JSON.parse(p);
  delete unsigned.fingerprint;
  writeFileSync(predictions, JSON.stringify(unsigned));
  assert.match(run(...scoreArgs).stderr, /Stale prediction/);
  writeFileSync(predictions, p);
  r.state.recent[0].text = 'Changed after review';
  writeFileSync(corpus, JSON.stringify(r));
  assert.match(run(...scoreArgs).stderr, /Labels do not match/);
});

test('failed or interrupted turns are excluded and completed compactions reset old history', () => {
  const { dir, path } = fixture();
  const db = new DatabaseSync(path);
  db.prepare("UPDATE session_message SET data = ? WHERE id = 'root-3'").run(JSON.stringify({ outcome: 'interrupted' }));
  const add = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)');
  add.run('root-5', 'root', 'compaction', 5, JSON.stringify({ status: 'completed', summary: 'Durable summary' }));
  add.run('root-6', 'root', 'user', 6, JSON.stringify({ text: 'New work' }));
  add.run('root-7', 'root', 'assistant', 7, JSON.stringify({ finish: 'stop', time: { completed: 7 }, tokens: { input: 41000, cache: { read: 0, write: 0 } }, content: [{ type: 'text', text: 'Verified' }] }));
  add.run('root-8', 'root', 'idle', 8, JSON.stringify({ outcome: 'succeeded' }));
  db.close();
  const out = join(dir, 'corpus.jsonl');
  const result = run('extract', '--db', path, '--out', out);
  assert.equal(result.status, 0, result.stderr);
  const records = readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 1);
  assert.equal(records[0].state.recent[0].role, 'summary');
  assert.equal(records[0].state.recent[0].text, 'Durable summary');
  assert.ok(!JSON.stringify(records[0].state).includes('compatibility contract'));
});

test('extract uses per-model limits and review samples span session groups without changing labels', () => {
  const { dir, path } = fixture();
  const limits = join(dir, 'limits.json'), out = join(dir, 'corpus.jsonl'), review = join(dir, 'review.md');
  writeFileSync(limits, JSON.stringify({ 'test/test': 80000 }));
  const r = run('extract', '--db', path, '--out', out, '--limits', limits);
  assert.equal(r.status, 0, r.stderr);
  const checkpoint = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(checkpoint.contextLimit, 80000);
  const corpusBefore = readFileSync(out);
  assert.equal(run('review', '--corpus', out, '--out', review, '--count', '10').status, 0);
  const text = readFileSync(review, 'utf8');
  assert.match(text, /FUTURE TASK/);
  assert.match(text, /safe.*unsafe.*uncertain/);
  assert.ok(text.includes(checkpoint.id));
  assert.deepEqual(readFileSync(out), corpusBefore);
  assert.equal(statSync(review).mode & 0o777, 0o600);
});

test('CLI refuses unknown options and malformed private data without echoing it', () => {
  const { dir } = fixture();
  const path = join(dir, 'broken.jsonl');
  writeFileSync(path, '{"private":"PRIVATE PAYLOAD", malformed}');
  const r = run('review', '--corpus', path, '--out', join(dir, 'review.md'));
  assert.notEqual(r.status, 0);
  assert.ok(!r.stderr.includes('PRIVATE PAYLOAD'));
  const unknown = run('extract', '--db', 'unused', '--out', join(dir, 'out.jsonl'), '--typo', 'yes');
  assert.match(unknown.stderr, /Unknown option/);
});

test('forks share a session group so copies cannot leak across eval splits', () => {
  const { dir, path } = fixture();
  const db = new DatabaseSync(path);
  db.exec('ALTER TABLE session_v2 ADD COLUMN fork_session_id TEXT;');
  db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?)').run('fork', null, '/private/project', 'root');
  db.exec("INSERT INTO session_message SELECT 'fork-' || seq, 'fork', type, seq, data FROM session_message WHERE session_id = 'root';");
  db.close();
  const out = join(dir, 'corpus.jsonl');
  assert.equal(run('extract', '--db', path, '--out', out).status, 0);
  const records = readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 2);
  assert.equal(new Set(records.map(r => r.group)).size, 1);
});

test('local judge cannot follow redirects or retain arbitrary response contents', async () => {
  const { dir } = fixture();
  const corpus = join(dir, 'corpus.jsonl');
  writeFileSync(corpus, JSON.stringify({ id: 'a', state: { recent: [] } }));
  let mode = 'redirect';
  const server = createServer((req, res) => {
    if (mode === 'redirect') { res.writeHead(302, { location: 'https://example.com/private' }); res.end(); }
    else { res.end('PRIVATE RESPONSE'.repeat(10000)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
    for (const scenario of ['redirect', 'oversize']) {
      mode = scenario;
      const out = join(dir, scenario + '.jsonl');
      const r = await runAsync('predict', '--corpus', corpus, '--out', out, '--judge', 'local', '--endpoint', endpoint, '--model', 'fixture');
      assert.equal(r.status, 0, r.stderr);
      const p = JSON.parse(readFileSync(out, 'utf8'));
      assert.equal(p.decision, null);
      assert.equal(p.error, scenario === 'redirect' ? 'network' : 'response');
      assert.ok(!readFileSync(out, 'utf8').includes('PRIVATE RESPONSE'));
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Jev requires explicit remote consent, scrubs its key and validates atomic judgments', async () => {
  const { dir } = fixture();
  const corpus = join(dir, 'corpus.jsonl'), keyFile = join(dir, 'jev.key');
  const secret = 'fixture-jev-key-do-not-log';
  writeFileSync(keyFile, secret, { mode: 0o600 });
  writeFileSync(corpus, JSON.stringify({ id: 'a', group: 'g', inputTokens: 60000, contextLimit: 200000,
    state: { recent: [{ role: 'assistant', text: 'Verified and saved. ' + secret }] }, review: { nextUser: 'FUTURE PRIVATE FOLLOWUP' } }));
  const requests = [];
  let malformed = false;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ auth: req.headers.authorization, path: req.url, body: JSON.parse(body) });
    const probabilities = malformed ? { finished: 1, not_finished: 1, unclear: 0 } : { finished: 0.99, not_finished: 0.005, unclear: 0.005 };
    res.end(JSON.stringify({ model: 'jev-fixture', usage: { input_tokens: 123, output_tokens: 45 }, answers: {
      done: { type: 'choice', choice: 'finished', confidence: 0.99, probabilities },
      shape: { type: 'choice', choice: 'hands_on', confidence: 0.99, probabilities: { hands_on: 0.99, coordinating: 0.005, unclear: 0.005 } },
    } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/systemone`;
  const args = ['predict', '--corpus', corpus, '--judge', 'jev', '--endpoint', endpoint, '--key-file', keyFile];
  try {
    const refusal = await runAsync(...args, '--out', join(dir, 'refused.jsonl'));
    assert.notEqual(refusal.status, 0);
    assert.match(refusal.stderr, /consent/);
    assert.equal(requests.length, 0);
    const out = join(dir, 'jev.jsonl');
    const r = await runAsync(...args, '--out', out, '--allow-remote', 'yes');
    assert.equal(r.status, 0, r.stderr);
    const p = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(p.decision, true);
    assert.equal(p.judge, 'jev-v1:jev-latest');
    assert.equal(p.score, 0.98505);
    assert.equal(p.floor, 0.8);
    assert.equal(p.usage.input, 123);
    assert.equal(requests[0].auth, 'Bearer ' + secret);
    assert.equal(requests[0].path, '/v1/systemone');
    assert.equal(requests[0].body.model, 'jev-latest');
    assert.ok(requests[0].body.questions.done);
    assert.ok(requests[0].body.questions.shape);
    assert.ok(!JSON.stringify(requests[0].body).includes(secret));
    assert.ok(!JSON.stringify(requests[0].body).includes('FUTURE PRIVATE FOLLOWUP'));
    assert.ok(!(r.stdout + r.stderr + readFileSync(out, 'utf8')).includes(secret));
    malformed = true;
    const bad = join(dir, 'bad-jev.jsonl');
    assert.equal((await runAsync(...args, '--out', bad, '--allow-remote', 'yes')).status, 0);
    assert.equal(JSON.parse(readFileSync(bad, 'utf8')).decision, null);
    assert.equal(JSON.parse(readFileSync(bad, 'utf8')).error, 'response');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Jev classifies HTTP failures and never falls back to another judge', async () => {
  const { dir } = fixture();
  const corpus = join(dir, 'corpus.jsonl'), keyFile = join(dir, 'key');
  writeFileSync(corpus, JSON.stringify({ id: 'a', state: { recent: [] } }));
  writeFileSync(keyFile, 'fixture-key', { mode: 0o600 });
  let status = 401;
  let calls = 0;
  const server = createServer((req, res) => { calls++; res.writeHead(status); res.end('PRIVATE API ERROR'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/systemone`;
  try {
    for (const [code, kind] of [[401, 'authentication'], [422, 'input'], [429, 'rate-limit'], [503, 'server']]) {
      status = code;
      const out = join(dir, code + '.jsonl');
      const r = await runAsync('predict', '--corpus', corpus, '--out', out, '--judge', 'jev', '--allow-remote', 'yes', '--endpoint', endpoint, '--key-file', keyFile);
      assert.equal(r.status, 0, r.stderr);
      const p = JSON.parse(readFileSync(out, 'utf8'));
      assert.equal(p.decision, null);
      assert.equal(p.error, kind);
      assert.equal(p.httpStatus, code);
      assert.equal(p.judge, 'jev-v1:jev-latest');
      assert.ok(!readFileSync(out, 'utf8').includes('PRIVATE API ERROR'));
    }
    assert.equal(calls, 4);
    const rejected = run('predict', '--corpus', corpus, '--out', join(dir, 'unsafe-endpoint.jsonl'), '--judge', 'jev', '--allow-remote', 'yes', '--endpoint', 'https://example.com/v1/systemone', '--key-file', keyFile);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /official/);
    assert.equal(calls, 4);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Decisions compares the Jev recipe with explicit consent, private credentials and named typed answers', async () => {
  const { dir } = fixture();
  const corpus = join(dir, 'corpus.jsonl'), keyFile = join(dir, 'openai.key');
  const secret = 'fixture-openai-key-do-not-log';
  writeFileSync(keyFile, secret, { mode: 0o600 });
  writeFileSync(corpus, JSON.stringify({ id: 'a', group: 'g', inputTokens: 60000, contextLimit: 200000,
    state: { recent: [{ role: 'assistant', text: 'Verified and saved. ' + secret }] }, review: { nextUser: 'PRIVATE FUTURE FOLLOWUP' } }));
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ auth: req.headers.authorization, path: req.url, body: JSON.parse(body) });
    // Reverse answer order; confidence is not necessarily the chosen probability.
    res.end(JSON.stringify({ model: 'gpt-6-luna', usage: { input_tokens: 123, output_tokens: 0, total_tokens: 123 }, answers: [
      { name: 'shape', type: 'choice', choice: 'hands_on', confidence: 0.7,
        probabilities: [{ value: 'hands_on', probability: 0.99 }, { value: 'coordinating', probability: 0.005 }, { value: 'unclear', probability: 0.005 }] },
      { name: 'done', type: 'choice', choice: 'finished', confidence: 0.8,
        probabilities: [{ value: 'finished', probability: 0.99 }, { value: 'not_finished', probability: 0.005 }, { value: 'unclear', probability: 0.005 }] },
    ] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/decisions`;
  const args = ['predict', '--corpus', corpus, '--judge', 'decisions', '--endpoint', endpoint, '--key-file', keyFile];
  try {
    const refused = await runAsync(...args, '--out', join(dir, 'refused.jsonl'));
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /consent/);
    assert.equal(requests.length, 0);
    const out = join(dir, 'decisions.jsonl');
    const r = await runAsync(...args, '--out', out, '--allow-remote', 'yes');
    assert.equal(r.status, 0, r.stderr);
    const p = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(p.decision, true);
    assert.equal(p.score, 0.98505);
    assert.equal(p.floor, 0.8);
    assert.equal(p.judge, 'decisions-v1:gpt-6-luna:done-shape-v1');
    assert.equal(p.resolvedModel, 'gpt-6-luna');
    assert.deepEqual(p.usage, { input: 123, output: 0 });
    assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.equal(requests[0].path, '/v1/decisions');
    assert.equal(requests[0].auth, 'Bearer ' + secret);
    assert.equal(requests[0].body.model, 'gpt-6-luna');
    assert.equal(typeof requests[0].body.input, 'string');
    assert.deepEqual(requests[0].body.questions.map(q => q.name), ['done', 'shape']);
    assert.deepEqual(requests[0].body.questions[0].choices.map(c => c.value), ['finished', 'not_finished', 'unclear']);
    assert.ok(!JSON.stringify(requests[0].body).includes(secret));
    assert.ok(!JSON.stringify(requests[0].body).includes('PRIVATE FUTURE FOLLOWUP'));
    assert.ok(!(r.stdout + r.stderr + readFileSync(out, 'utf8')).includes(secret));
    assert.notEqual((await runAsync(...args, '--out', out, '--allow-remote', 'yes')).status, 0);
    assert.equal(requests.length, 1, 'existing output prevents extra calls');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Decisions abstains on refusals and malformed distributions without retaining raw responses', async () => {
  const { dir } = fixture();
  const corpus = join(dir, 'corpus.jsonl'), keyFile = join(dir, 'key');
  writeFileSync(corpus, JSON.stringify({ id: 'a', state: { recent: [] } }));
  writeFileSync(keyFile, 'fixture-key', { mode: 0o600 });
  let mode;
  const server = createServer((req, res) => {
    req.resume();
    const result = { model: 'gpt-6-luna', usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 }, answers: [
      { name: 'done', type: 'choice', choice: 'finished', confidence: 0.99,
        probabilities: [{ value: 'finished', probability: 0.99 }, { value: 'not_finished', probability: 0.005 }, { value: 'unclear', probability: 0.005 }] },
      { name: 'shape', type: 'choice', choice: 'hands_on', confidence: 0.99,
        probabilities: [{ value: 'hands_on', probability: 0.99 }, { value: 'coordinating', probability: 0.005 }, { value: 'unclear', probability: 0.005 }] },
    ], diagnostic: 'PRIVATE RESPONSE' };
    const done = result.answers[0];
    if (mode === 'refusal') result.answers[0] = { name: 'done', type: 'refusal' };
    if (mode === 'missing') result.answers.pop();
    if (mode === 'duplicate-name') result.answers[1].name = 'done';
    if (mode === 'unknown-name') result.answers[1].name = 'unknown';
    if (mode === 'wrong-type') done.type = 'predicate';
    if (mode === 'duplicate-option') done.probabilities[1].value = 'finished';
    if (mode === 'unknown-option') done.probabilities[1].value = 'other';
    if (mode === 'boolean-option') done.probabilities[0].value = true;
    if (mode === 'bad-sum') done.probabilities[1].probability = 0.5;
    if (mode === 'null-probability') done.probabilities[0].probability = null;
    if (mode === 'out-of-range') done.probabilities[0].probability = 1.1;
    if (mode === 'wrong-choice') done.choice = 'not_finished';
    if (mode === 'bad-confidence') done.confidence = -0.1;
    if (mode === 'bad-usage') result.usage.total_tokens = 101;
    if (mode === 'missing-usage') delete result.usage;
    res.end(mode === 'bad-json' ? 'PRIVATE RESPONSE NOT JSON' : mode === 'oversize' ? 'PRIVATE RESPONSE'.repeat(3000) : JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/v1/decisions`;
    for (mode of ['refusal', 'missing', 'duplicate-name', 'unknown-name', 'wrong-type', 'duplicate-option', 'unknown-option',
      'boolean-option', 'bad-sum', 'null-probability', 'out-of-range', 'wrong-choice', 'bad-confidence', 'bad-usage', 'missing-usage', 'bad-json', 'oversize']) {
      const out = join(dir, mode + '.jsonl');
      const r = await runAsync('predict', '--corpus', corpus, '--out', out, '--judge', 'decisions', '--allow-remote', 'yes', '--endpoint', endpoint, '--key-file', keyFile);
      assert.equal(r.status, 0, r.stderr);
      const p = JSON.parse(readFileSync(out, 'utf8'));
      assert.equal(p.decision, null, mode);
      assert.equal(p.error, mode === 'refusal' ? 'refusal' : 'response', mode);
      assert.equal(p.judge, 'decisions-v1:gpt-6-luna:done-shape-v1');
      assert.ok(!(r.stdout + r.stderr + readFileSync(out, 'utf8')).includes('PRIVATE RESPONSE'));
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Decisions bounds requests, forbids redirects and classifies transport errors without fallback', async () => {
  const { dir } = fixture();
  const corpus = join(dir, 'corpus.jsonl'), keyFile = join(dir, 'key');
  writeFileSync(corpus, JSON.stringify({ id: 'a', state: { recent: [] } }));
  writeFileSync(keyFile, 'fixture-key', { mode: 0o600 });
  let status = 401, calls = 0, redirectDestinationCalls = 0;
  const destination = createServer((req, res) => { req.resume(); redirectDestinationCalls++; res.end('{}'); });
  await new Promise(resolve => destination.listen(0, '127.0.0.1', resolve));
  const server = createServer((req, res) => {
    req.resume();
    calls++;
    if (status === 'timeout') return;
    res.writeHead(status, status === 302 ? { location: `http://127.0.0.1:${destination.address().port}/v1/decisions` } : {});
    res.end('PRIVATE API ERROR');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/decisions`;
  const args = ['predict', '--corpus', corpus, '--judge', 'decisions', '--allow-remote', 'yes', '--endpoint', endpoint, '--key-file', keyFile];
  try {
    for (const [code, kind] of [[401, 'authentication'], [403, 'authentication'], [413, 'input'], [429, 'rate-limit'], [503, 'server'], [404, 'http'], [302, 'network'], ['timeout', 'timeout']]) {
      status = code;
      const out = join(dir, code + '.jsonl');
      const r = await runAsync(...args, '--out', out, '--timeout', code === 'timeout' ? '100' : '5000');
      assert.equal(r.status, 0, r.stderr);
      const p = JSON.parse(readFileSync(out, 'utf8'));
      assert.equal(p.decision, null);
      assert.equal(p.error, kind);
      if (typeof code === 'number' && code !== 302) assert.equal(p.httpStatus, code);
      assert.ok(!(r.stdout + r.stderr + readFileSync(out, 'utf8')).includes('PRIVATE API ERROR'));
    }
    assert.equal(calls, 8);
    assert.equal(redirectDestinationCalls, 0);
    writeFileSync(corpus, JSON.stringify({ id: 'a', state: { recent: [{ role: 'assistant', text: 'x'.repeat(32000) }] } }));
    const oversized = join(dir, 'oversized-input.jsonl');
    assert.equal((await runAsync(...args, '--out', oversized)).status, 0);
    assert.equal(JSON.parse(readFileSync(oversized, 'utf8')).error, 'input');
    assert.equal(calls, 8, 'oversized payload rejected before any request');
    for (const badEndpoint of ['https://example.com/v1/decisions', 'http://api.openai.com/v1/decisions',
      'https://api.openai.com/v1/decisions?key=private', 'https://api.openai.com/v1/responses']) {
      const rejected = run('predict', '--corpus', corpus, '--out', join(dir, 'rejected.jsonl'), '--judge', 'decisions',
        '--allow-remote', 'yes', '--endpoint', badEndpoint, '--key-file', keyFile);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /official/);
    }
    assert.notEqual(run(...args, '--out', join(dir, 'unsupported-model.jsonl'), '--model', 'different-model').status, 0);
    assert.equal(calls, 8);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => destination.close(resolve));
  }
});

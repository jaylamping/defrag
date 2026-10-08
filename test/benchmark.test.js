import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const cli = new URL('../src/cli.js', import.meta.url).pathname;
test('benchmark runs a resident offline worker, excludes future text and separates timing from accuracy', t => {
  const dir = mkdtempSync(join(tmpdir(), 'defrag-benchmark-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const corpus = join(dir, 'corpus.jsonl'), manifest = join(dir, 'manifest.json'), out = join(dir, 'report.json');
  const worker = join(dir, 'worker.cjs');
  writeFileSync(corpus, [
    { id: 'a', group: 'a', state: { recent: [{ role: 'assistant', text: 'Work saved.' }] }, review: { nextUser: 'PRIVATE FUTURE' } },
    { id: 'b', group: 'b', state: { recent: [{ role: 'assistant', text: 'Continue work.' }] }, review: { nextUser: 'PRIVATE FUTURE' } },
  ].map(JSON.stringify).join('\n'));
  writeFileSync(manifest, JSON.stringify({ fixture: { revision: 'a'.repeat(40), path: '/fixture' } }));
  writeFileSync(worker, `const readline = require('node:readline');
    if (process.env.HF_HUB_OFFLINE !== '1' || process.env.HF_HUB_DISABLE_TELEMETRY !== '1') process.exit(2);
    console.log(JSON.stringify({type:'ready', loadMs:1, device:'fixture'}));
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const r=JSON.parse(line);
      if (line.includes('PRIVATE FUTURE')) process.exit(3);
      console.log(JSON.stringify({type:'prediction', decision:r.state.recent[0].text==='Work saved.',
        score:r.state.recent[0].text==='Work saved.'?0.95:0.05, inputTokens:12, inferenceMs:2,
        memory:{rssPeakMiB:100}, truncated:false}));
    });`);
  const r = spawnSync(process.execPath, [cli, 'bench', '--corpus', corpus, '--out', out, '--manifest', manifest,
    '--candidate', 'fixture', '--runtime', process.execPath, '--worker', worker, '--repeats', '2'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(report.checkpoints, 2);
  assert.equal(report.samples.length, 6);
  assert.equal(report.warm.samples, 4);
  assert.equal(report.warm.medianInferenceMs, 2);
  assert.equal(report.memory.rssPeakMiB, 100);
  assert.equal(report.accuracy, null);
  assert.equal(report.predictions.length, 2);
  assert.ok(report.predictions[0].fingerprint);
  assert.ok(!readFileSync(out, 'utf8').includes('PRIVATE FUTURE'));
  assert.equal(statSync(out).mode & 0o777, 0o600);
});

test('benchmark refuses invalid probability outputs without retaining private diagnostics', t => {
  const dir = mkdtempSync(join(tmpdir(), 'defrag-benchmark-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const corpus = join(dir, 'corpus.jsonl'), manifest = join(dir, 'manifest.json');
  writeFileSync(corpus, JSON.stringify({ id: 'a', group: 'a', state: { recent: [] } }));
  writeFileSync(manifest, JSON.stringify({ fixture: { revision: 'a'.repeat(40), path: '/fixture' } }));
  for (const score of [null, -0.1, 1.1, '0.9']) {
    const out = join(dir, `report-${score}.json`), worker = join(dir, 'worker.cjs');
    writeFileSync(worker, `const readline = require('node:readline');
      console.error('PRIVATE DIAGNOSTIC');
      console.log(JSON.stringify({type:'ready', loadMs:1, device:'fixture'}));
      readline.createInterface({input:process.stdin}).on('line',()=>console.log(JSON.stringify({
        type:'prediction', decision:true, score:${JSON.stringify(score)}, inputTokens:12,
        inferenceMs:2, memory:{rssPeakMiB:100}, truncated:false})));`);
    const r = spawnSync(process.execPath, [cli, 'bench', '--corpus', corpus, '--out', out, '--manifest', manifest,
      '--candidate', 'fixture', '--runtime', process.execPath, '--worker', worker, '--repeats', '1'], { encoding: 'utf8' });
    assert.equal(r.status, 1, `score ${score} must be rejected`);
    assert.ok(!existsSync(out));
    assert.ok(!r.stderr.includes('PRIVATE DIAGNOSTIC'));
    assert.ok(!r.stdout.includes('PRIVATE DIAGNOSTIC'));
  }
});

test('benchmark preserves over-limit abstentions and fails closed on truncated, dead or stalled workers', t => {
  const dir = mkdtempSync(join(tmpdir(), 'defrag-benchmark-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const corpus = join(dir, 'corpus.jsonl'), manifest = join(dir, 'manifest.json'), worker = join(dir, 'worker.cjs');
  writeFileSync(corpus, JSON.stringify({ id: 'a', group: 'a', state: { recent: [] } }));
  writeFileSync(manifest, JSON.stringify({ fixture: { revision: 'a'.repeat(40), path: '/fixture' } }));
  for (const mode of ['limit', 'truncated', 'dead', 'stalled']) {
    const out = join(dir, `${mode}.json`);
    writeFileSync(worker, `const readline = require('node:readline');
      console.log(JSON.stringify({type:'ready', loadMs:1, device:'fixture'}));
      readline.createInterface({input:process.stdin}).on('line',()=>{
        if ('${mode}' === 'dead') process.exit(1);
        if ('${mode}' === 'stalled') return;
        console.log(JSON.stringify({type:'prediction', decision:null, error:'input-limit',
          inputTokens:10000, inferenceMs:2, truncated:'${mode}' === 'truncated'}));
      });`);
    const r = spawnSync(process.execPath, [cli, 'bench', '--corpus', corpus, '--out', out, '--manifest', manifest,
      '--candidate', 'fixture', '--runtime', process.execPath, '--worker', worker, '--repeats', '1', '--timeout', '500'],
      { encoding: 'utf8', timeout: 5000 });
    if (mode === 'limit') {
      assert.equal(r.status, 0, r.stderr);
      const report = JSON.parse(readFileSync(out, 'utf8'));
      assert.equal(report.abstentions, 2);
      assert.equal(report.warm.samples, 0);
      assert.equal(report.warm.medianInferenceMs, null);
      assert.equal(report.predictions[0].decision, null);
      assert.equal(report.predictions[0].error, 'input-limit');
    } else {
      assert.equal(r.status, 1, `${mode} must fail closed: ${r.stderr}`);
      assert.ok(!existsSync(out));
    }
  }
});

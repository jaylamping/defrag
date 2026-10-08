import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { availableParallelism, platform, arch } from 'node:os';
import { fingerprint } from './evaluation.js';
import { positiveInteger } from './io.js';
import { sample } from './review.js';
import { questions } from './jev.js';

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

function probability(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export async function benchmark(records, manifest, options) {
  const candidate = manifest[options.candidate];
  if (!candidate || !candidate.path || !/^[a-f0-9]{40}$/.test(candidate.revision)) throw new Error('Candidate needs a pinned model manifest');
  const count = positiveInteger(options.count, 3), repeats = positiveInteger(options.repeats, 5);
  if (count > 10 || repeats > 20) throw new Error('Bounded benchmark allows at most 10 checkpoints and 20 warm repeats');
  const selected = sample(records, count);
  if (!selected.length) throw new Error('No checkpoints to benchmark');
  const timeout = positiveInteger(options.timeout, 180000);
  if (timeout > 300000) throw new Error('Benchmark timeout must not exceed 300000 ms');
  const worker = options.worker ?? new URL('../bench/worker.py', import.meta.url).pathname;
  const runtime = options.runtime ?? new URL('../.venv/bin/python', import.meta.url).pathname;
  const started = performance.now();
  const child = spawn(runtime, [worker, '--manifest', options.manifest, '--candidate', options.candidate,
    '--device', options.device ?? 'auto'], { env: {
    PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'en_US.UTF-8',
    HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
    TOKENIZERS_PARALLELISM: 'false', PYTHONUNBUFFERED: '1',
  }, stdio: ['pipe', 'pipe', 'pipe'] });
  // Worker/library diagnostics may contain private input. Drain, never relay them.
  child.stderr.resume();
  child.stdin.on('error', () => {});
  const reader = createInterface({ input: child.stdout });
  const queued = [];
  let waiting, failed, timer;
  const reject = error => {
    failed = error;
    if (waiting) { clearTimeout(timer); waiting.reject(error); waiting = undefined; }
  };
  const next = () => {
    if (failed) return Promise.reject(failed);
    if (queued.length) return Promise.resolve(queued.shift());
    return new Promise((resolve, deny) => {
      waiting = { resolve, reject: deny };
      timer = setTimeout(() => reject(new Error('Benchmark worker timed out')), timeout);
    });
  };
  reader.on('line', line => {
    let message;
    try {
      if (Buffer.byteLength(line) > 32768) throw new Error();
      message = JSON.parse(line);
    } catch { reject(new Error('Invalid benchmark worker response')); return; }
    if (waiting) { clearTimeout(timer); waiting.resolve(message); waiting = undefined; }
    else queued.push(message);
  });
  child.on('error', () => reject(new Error('Benchmark runtime could not start')));
  child.on('exit', () => reject(new Error('Benchmark worker exited')));
  const samples = [], predictions = [], memory = {};
  try {
    const ready = await next();
    if (ready.type !== 'ready') throw new Error('Benchmark model failed to load; no predictions made');
    const startupMs = Math.round(performance.now() - started);
    for (let pass = 0; pass <= repeats; pass++) {
      for (const record of selected) {
        const begin = performance.now();
        const response = next();
        child.stdin.write(JSON.stringify({ state: record.state, inputTokens: record.inputTokens, contextLimit: record.contextLimit,
          ...(options.candidate === 'openjev' ? { questions } : {}) }) + '\n');
        const result = await response;
        if (result.type !== 'prediction' || ![true, false, null].includes(result.decision)
          || !Number.isFinite(result.inferenceMs) || result.inferenceMs < 0 || result.truncated !== false
          || (result.decision !== null && !probability(result.score))
          || ['score', 'floor', 'margin'].some(key => Object.hasOwn(result, key) && !probability(result[key]))) throw new Error('Invalid benchmark prediction');
        const entry = { id: record.id, pass, phase: pass === 0 ? 'first-pass' : 'warm', decision: result.decision,
          inferenceMs: result.inferenceMs, roundTripMs: Math.round((performance.now() - begin) * 1000) / 1000 };
        if (typeof result.error === 'string' && /^[a-z-]{1,40}$/.test(result.error)) entry.error = result.error;
        for (const key of ['inputTokens', 'score', 'floor', 'margin']) if (Number.isFinite(result[key])) entry[key] = result[key];
        samples.push(entry);
        for (const key of ['rssPeakMiB', 'acceleratorPeakMiB', 'mpsDriverMiB']) {
          if (Number.isFinite(result.memory?.[key])) memory[key] = Math.max(memory[key] ?? 0, result.memory[key]);
        }
        if (pass === 0) predictions.push({ version: 1, id: record.id, fingerprint: fingerprint(record),
          judge: `bench-v1:${options.candidate}:${candidate.revision}`, decision: result.decision,
          ...(entry.error ? { error: entry.error } : {}), ...(Number.isFinite(entry.score) ? { score: entry.score } : {}), latencyMs: entry.roundTripMs });
      }
    }
    const warm = samples.filter(s => s.phase === 'warm' && s.decision !== null);
    return { version: 1, candidate: options.candidate, model: { id: candidate.model, revision: candidate.revision },
      runtime: { device: ready.device, policy: ready.policy, versions: ready.versions, platform: platform(), arch: arch(), availableParallelism: availableParallelism() },
      checkpoints: selected.length, repeats, startupMs, loadMs: Number.isFinite(ready.loadMs) ? ready.loadMs : null,
      warm: { samples: warm.length, medianInferenceMs: percentile(warm.map(s => s.inferenceMs), 0.5),
        p95InferenceMs: percentile(warm.map(s => s.inferenceMs), 0.95), medianRoundTripMs: percentile(warm.map(s => s.roundTripMs), 0.5),
        p95RoundTripMs: percentile(warm.map(s => s.roundTripMs), 0.95) },
      abstentions: samples.filter(s => s.decision === null).length, memory, accuracy: null, predictions, samples,
      caveats: ['Offline resident-process timing; startup includes imports/loading, not download time.',
        'First-pass timings are not cold disk-cache measurements; OS cache was not flushed.',
        'Accelerator allocator/driver memory and process RSS overlap; do not add them.',
        'No human labels used here. Scores are not calibrated correctness probabilities.',
        'Small bounded workload; no claim of general p95 latency or production accuracy.'] };
  } finally {
    clearTimeout(timer);
    reader.close();
    child.stdin.end();
    child.kill('SIGTERM');
  }
}

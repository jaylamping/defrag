#!/usr/bin/env node
import { lstatSync } from 'node:fs';
import { extract } from './corpus.js';
import { positiveInteger, writeLines, readLines, readJSON, writePrivate } from './io.js';
import { label, score } from './evaluation.js';
import { predict } from './predict.js';
import { sample, review } from './review.js';
import { benchmark } from './benchmark.js';
import { replay } from './replay.js';

const [command, ...args] = process.argv.slice(2);
const options = {};
const allowed = {
  extract: ['db', 'out', 'minimum', 'context-limit', 'limits', 'state-version'],
  review: ['corpus', 'out', 'count'],
  label: ['corpus', 'out', 'id', 'decision', 'reviewer', 'note'],
  score: ['corpus', 'labels', 'predictions', 'out'],
  predict: ['corpus', 'out', 'judge', 'endpoint', 'model', 'threshold', 'timeout', 'count', 'allow-remote', 'key-file', 'recipe'],
  replay: ['corpus', 'predictions', 'out', 'floor'],
  bench: ['corpus', 'out', 'manifest', 'candidate', 'runtime', 'worker', 'repeats', 'count', 'timeout', 'device'],
};
try {
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || args[i + 1] === undefined || args[i + 1].startsWith('--')) throw new Error('Options need --name value');
    const key = args[i].slice(2);
    if (!allowed[command]?.includes(key)) throw new Error('Unknown option for command');
    if (Object.hasOwn(options, key)) throw new Error('Duplicate option');
    options[key] = args[i + 1];
  }
  if (options.out && command !== 'label') {
    try {
      lstatSync(options.out);
      throw Object.assign(new Error('Output exists'), { code: 'EEXIST' });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (command === 'extract') {
    if (!options.db || !options.out) throw new Error('extract requires --db and --out');
    const records = extract(options.db, { minimum: positiveInteger(options.minimum, 40000), contextLimit: positiveInteger(options['context-limit'], null), limits: options.limits ? readJSON(options.limits) : {}, stateVersion: options['state-version'] ?? '1' });
    writeLines(options.out, records);
    console.log(JSON.stringify({ checkpoints: records.length, reviewed: 0, output: options.out }));
  } else if (command === 'label') {
    if (!options.corpus || !options.out) throw new Error('label requires --corpus and --out');
    label(readLines(options.corpus), options);
    console.log('Label recorded.');
  } else if (command === 'score') {
    if (!options.corpus || !options.labels || !options.predictions || !options.out) throw new Error('score requires --corpus, --labels, --predictions and --out');
    const report = score(readLines(options.corpus), readLines(options.labels), readLines(options.predictions));
    writePrivate(options.out, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } else if (command === 'predict') {
    if (!options.corpus || !options.out) throw new Error('predict requires --corpus and --out');
    const records = readLines(options.corpus);
    const selected = options.count ? sample(records, positiveInteger(options.count)) : records;
    const predictions = await predict(selected, options);
    writeLines(options.out, predictions);
    console.log(JSON.stringify({ predictions: predictions.length, abstentions: predictions.filter(p => p.decision === null).length, output: options.out }));
  } else if (command === 'replay') {
    if (!options.corpus || !options.predictions || !options.out || !options.floor) throw new Error('replay requires --corpus, --predictions, --out and --floor');
    const predictions = replay(readLines(options.corpus), readLines(options.predictions), options);
    writeLines(options.out, predictions);
    console.log(JSON.stringify({ predictions: predictions.length, recommendations: predictions.filter(p => p.decision === true).length,
      abstentions: predictions.filter(p => p.decision === null).length, hostedCalls: 0, accuracy: null, output: options.out }));
  } else if (command === 'review') {
    if (!options.corpus || !options.out) throw new Error('review requires --corpus and --out');
    const records = sample(readLines(options.corpus), positiveInteger(options.count, 20));
    writePrivate(options.out, review(records));
    console.log(JSON.stringify({ checkpoints: records.length, output: options.out }));
  } else if (command === 'bench') {
    if (!options.corpus || !options.out || !options.manifest || !options.candidate) throw new Error('bench requires --corpus, --out, --manifest and --candidate');
    const report = await benchmark(readLines(options.corpus), readJSON(options.manifest), options);
    writePrivate(options.out, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ candidate: report.candidate, checkpoints: report.checkpoints, startupMs: report.startupMs, warm: report.warm,
      abstentions: report.abstentions, memory: report.memory, accuracy: null, output: options.out }));
  } else throw new Error('Usage: defrag extract|review|label|score|predict|replay|bench (see README for options)');
} catch (error) {
  // Never dump stack traces or source transcript contents into shared output.
  console.error(error.code === 'EEXIST' ? 'Output exists; choose a new path.' : error.message);
  process.exitCode = 1;
}

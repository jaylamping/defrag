import { readFileSync, mkdirSync, writeFileSync, appendFileSync, existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';

export function readLines(path) {
  const text = readFileSync(path, 'utf8');
  try { return text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)); }
  catch { throw new Error('Invalid JSONL file; source contents withheld.'); }
}

export function readJSON(path) {
  const text = readFileSync(path, 'utf8');
  try { return JSON.parse(text); } catch { throw new Error('Invalid JSON file; source contents withheld.'); }
}

// Exclusive creation prevents accidentally replacing human labels or old runs.
export function writePrivate(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode: 0o600, flag: 'wx' });
}

export function writeLines(path, records) {
  writePrivate(path, records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''));
}

export function appendPrivate(path, record) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Label file must be a regular private file (chmod 600)');
  }
  appendFileSync(path, JSON.stringify(record) + '\n', { mode: 0o600 });
}

export function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Expected a positive integer');
  return n;
}

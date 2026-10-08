import { createHash } from 'node:crypto';
import { appendPrivate } from './io.js';

export function fingerprint(record) {
  return createHash('sha256').update(JSON.stringify({ id: record.id, group: record.group, model: record.model, state: record.state,
    inputTokens: record.inputTokens, contextLimit: record.contextLimit, review: record.review })).digest('hex');
}

export function label(records, { out, id, decision, reviewer, note }) {
  const record = records.find(r => r.id === id);
  if (!record) throw new Error('Unknown checkpoint ID');
  if (!['safe', 'unsafe', 'uncertain'].includes(decision) || !reviewer || !note) throw new Error('label requires --decision safe|unsafe|uncertain, --reviewer and --note');
  appendPrivate(out, { version: 1, id, fingerprint: fingerprint(record), decision, reviewer, note, reviewedAt: new Date().toISOString() });
}

export function score(records, labels, predictions) {
  const corpus = new Map(records.map(r => [r.id, r]));
  if (corpus.size !== records.length) throw new Error('Duplicate corpus IDs');
  const reviewed = new Map();
  for (const l of labels) {
    if (!corpus.has(l.id) || l.fingerprint !== fingerprint(corpus.get(l.id))) throw new Error('Labels do not match this corpus');
    if (!l.reviewer || !l.note || !l.reviewedAt || !['safe', 'unsafe', 'uncertain'].includes(l.decision)) throw new Error('Invalid reviewed label');
    reviewed.set(l.id, l); // Append-only label corrections: last review wins.
  }
  const gold = [...reviewed.values()].filter(l => l.decision !== 'uncertain');
  if (!gold.length) throw new Error('No reviewed safe/unsafe labels. Accuracy cannot be measured yet.');
  const judges = {};
  const groups = new Map();
  for (const p of predictions) {
    if (!corpus.has(p.id) || !p.judge || ![true, false, null].includes(p.decision)) throw new Error('Invalid prediction');
    if (p.fingerprint !== fingerprint(corpus.get(p.id))) throw new Error('Stale prediction');
    if (!groups.has(p.judge)) groups.set(p.judge, new Map());
    if (groups.get(p.judge).has(p.id)) throw new Error('Duplicate prediction for checkpoint/judge');
    groups.get(p.judge).set(p.id, p);
  }
  for (const [name, run] of groups) {
    const m = { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0, abstentions: 0, missing: 0 };
    const latencies = [];
    for (const l of gold) {
      const p = run.get(l.id);
      if (!p) m.missing++;
      if (p?.decision === null || !p) m.abstentions++;
      // An abstention never recommends compaction. Safe abstentions count as misses.
      if (p?.decision === true) l.decision === 'safe' ? m.truePositive++ : m.falsePositive++;
      else l.decision === 'safe' ? m.falseNegative++ : m.trueNegative++;
      if (Number.isFinite(p?.latencyMs)) latencies.push(p.latencyMs);
    }
    const divide = (a, b) => b ? a / b : null;
    judges[name] = { ...m, precision: divide(m.truePositive, m.truePositive + m.falsePositive),
      recall: divide(m.truePositive, m.truePositive + m.falseNegative),
      coverage: divide(gold.length - m.abstentions, gold.length),
      meanLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null };
  }
  return { version: 1, reviewed: gold.length, uncertain: reviewed.size - gold.length, unreviewed: records.length - reviewed.size,
    sessionGroups: new Set(gold.map(l => corpus.get(l.id).group)).size, judges,
    caveats: ['Retrospective human labels, not proof of post-compaction task success.',
      'Checkpoints from the same session are correlated; split by session before tuning.',
      'No model selection claim without a held-out reviewed set.',
      'Threshold policy is a proxy, not a replay of actual host compaction.'] };
}

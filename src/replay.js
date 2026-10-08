import { fingerprint } from './evaluation.js';
import { checkpointQuestions, scoreCheckpoint } from './checkpoint.js';

const positive = { scope: 'sufficient', obligation: 'settled', preservation: 'recoverable', consistency: 'current' };
const sourceJudges = ['jev-v2:jev-latest:checkpoint-v2', 'decisions-v2:gpt-6-luna:checkpoint-v2'];

function validateAxes(axes) {
  const probability = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  if (!axes || Object.keys(axes).sort().join() !== Object.keys(checkpointQuestions).sort().join()) throw new Error('response');
  return Object.fromEntries(Object.entries(checkpointQuestions).map(([name, question]) => {
    const axis = axes[name], names = Object.keys(question.criteria), p = axis?.probabilities;
    if (!names.includes(axis?.choice) || !p || Object.keys(p).sort().join() !== names.toSorted().join()
      || !Object.values(p).every(probability) || Math.abs(Object.values(p).reduce((a, b) => a + b, 0) - 1) > 0.01
      || p[axis.choice] < Math.max(...Object.values(p))) throw new Error('response');
    return [name, { choice: axis.choice, probabilities: Object.fromEntries(names.map(n => [n, p[n]])) }];
  }));
}

export function replay(records, predictions, options) {
  const floor = options.floor === 'choices' ? 0 : Number(options.floor);
  if (options.floor !== 'choices' && !(floor > 0 && floor <= 1)) throw new Error('floor must be in (0, 1] or choices');
  const corpus = new Map(records.map(r => [r.id, r]));
  if (corpus.size !== records.length) throw new Error('Duplicate corpus IDs');
  const seen = new Set();
  for (const p of predictions) {
    if (!p || !corpus.has(p.id)) throw new Error('Unknown checkpoint ID');
    if (!sourceJudges.includes(p.judge) || p.settings?.recipe !== 'checkpoint-v2') throw new Error('Replay requires original hosted checkpoint-v2 predictions');
    if (p.fingerprint !== fingerprint(corpus.get(p.id))) throw new Error('Stale prediction');
    const key = `${p.id}:${p.judge}`;
    if (seen.has(key)) throw new Error('Duplicate prediction for checkpoint/judge');
    seen.add(key);
  }
  return predictions.map(p => {
    const started = performance.now();
    const record = corpus.get(p.id);
    let result;
    if (p.decision === null || Object.hasOwn(p, 'error')) result = { decision: null, error: 'source-failure' };
    else {
      try {
        const axes = validateAxes(p.axes), baseline = scoreCheckpoint(axes);
        if (p.version !== 1 || p.floor !== 0.9 || p.decision !== baseline.decision || p.score !== baseline.score) throw new Error('response');
        const blockedBy = Object.entries(positive).filter(([name, choice]) =>
          axes[name].choice !== choice || axes[name].probabilities[choice] < floor).map(([name]) => name);
        const choiceBlockedBy = blockedBy.filter(name => axes[name].choice !== positive[name]);
        const confidenceBlockedBy = blockedBy.filter(name => axes[name].choice === positive[name]);
        const decision = blockedBy.length === 0;
        result = { decision, assessment: decision ? 'safe' : baseline.assessment === 'unsafe' ? 'unsafe' : 'uncertain',
          score: baseline.score, floor, blockedBy, choiceBlockedBy, confidenceBlockedBy, axes };
      } catch { result = { decision: null, error: 'response' }; }
    }
    return { version: 1, id: record.id, fingerprint: fingerprint(record), judge: `offline-v1:${p.judge}:floor-${floor === 0 ? 'choices' : floor}`,
      ...result, latencyMs: Math.round(performance.now() - started),
      source: { judge: p.judge, decision: [true, false, null].includes(p.decision) ? p.decision : null,
        ...(p.floor === 0.9 ? { floor: 0.9 } : {}), ...(Number.isFinite(p.latencyMs) && p.latencyMs >= 0 ? { latencyMs: p.latencyMs } : {}) },
      settings: { mode: 'offline-confidence-replay-v1', recipe: 'checkpoint-v2', floor, experimental: true } };
  });
}

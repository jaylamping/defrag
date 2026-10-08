import { readFileSync, lstatSync } from 'node:fs';
import { questions } from './jev.js';

// Keep the question recipe fixed for the first provider comparison.
const decisionQuestions = Object.entries(questions).map(([name, question]) => ({
  name, type: 'choice', instructions: question.instructions,
  choices: Object.entries(question.criteria).map(([value, description]) => ({ value, description })),
}));

function failure(kind, httpStatus) { return Object.assign(new Error(kind), { kind, httpStatus }); }
function probability(n) { return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1; }

export function configureDecisions(options) {
  if (options['allow-remote'] !== 'yes') throw new Error('Decisions requires explicit consent: --allow-remote yes. Checkpoint snapshots leave your machine.');
  if (options.model && options.model !== 'gpt-6-luna') throw new Error('Decisions currently supports only gpt-6-luna');
  const endpoint = new URL(options.endpoint ?? 'https://api.openai.com/v1/decisions');
  const official = endpoint.protocol === 'https:' && endpoint.hostname === 'api.openai.com' && !endpoint.port;
  const localFixture = endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if ((!official && !localFixture) || endpoint.pathname !== '/v1/decisions' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Decisions endpoint must be the official HTTPS endpoint or a loopback test fixture');
  }
  let key;
  if (options['key-file']) {
    const info = lstatSync(options['key-file']);
    if (!info.isFile() || info.size > 8192 || (info.mode & 0o077) !== 0) throw new Error('OpenAI key file must be a regular private file (chmod 600)');
    key = readFileSync(options['key-file'], 'utf8').trim();
  } else key = process.env.OPENAI_API_KEY?.trim();
  if (!key || /\s/.test(key)) throw new Error('Decisions needs OPENAI_API_KEY or --key-file; never put a key on the command line');
  return { endpoint: endpoint.href, key, model: 'gpt-6-luna' };
}

function choice(answer, names) {
  if (answer?.type === 'refusal') throw failure('refusal');
  if (answer?.type !== 'choice' || !names.includes(answer.choice) || !probability(answer.confidence)
    || !Array.isArray(answer.probabilities) || answer.probabilities.length !== names.length) throw failure('response');
  const values = new Map();
  for (const option of answer.probabilities) {
    if (!option || !names.includes(option.value) || values.has(option.value) || !probability(option.probability)) throw failure('response');
    values.set(option.value, option.probability);
  }
  if (Math.abs([...values.values()].reduce((a, b) => a + b, 0) - 1) > 0.01
    || values.get(answer.choice) < Math.max(...values.values())) throw failure('response');
  // confidence is a separate API field, not necessarily P(chosen option).
  return Object.fromEntries(values);
}

export async function judgeDecisions(record, configuration, timeout) {
  const signal = AbortSignal.timeout(timeout);
  try {
    const input = JSON.stringify(record.state, (_, value) => typeof value === 'string'
      ? value.split(configuration.key).join('[REDACTED]') : value);
    if (typeof input !== 'string') throw failure('input');
    const body = JSON.stringify({ model: configuration.model, input, questions: decisionQuestions });
    if (Buffer.byteLength(body) > 32000) throw failure('input');
    const response = await fetch(configuration.endpoint, { method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${configuration.key}` }, body });
    if (!response.ok) {
      await response.body?.cancel();
      const status = response.status;
      throw failure([401, 403].includes(status) ? 'authentication' : status === 429 ? 'rate-limit'
        : [400, 413, 422].includes(status) ? 'input' : status >= 500 ? 'server' : 'http', status);
    }
    const reader = response.body?.getReader();
    if (!reader) throw failure('response');
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 32768) throw failure('response');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    let judgment;
    try { judgment = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('response'); }
    if (!judgment || typeof judgment.model !== 'string' || !/^[\w.:/-]{1,100}$/.test(judgment.model)
      || !['input_tokens', 'output_tokens', 'total_tokens'].every(key => Number.isSafeInteger(judgment.usage?.[key]) && judgment.usage[key] >= 0)
      || judgment.usage.total_tokens !== judgment.usage.input_tokens + judgment.usage.output_tokens
      || !Array.isArray(judgment.answers) || judgment.answers.length !== decisionQuestions.length) throw failure('response');
    const answers = new Map();
    for (const answer of judgment.answers) {
      if (!answer || !Object.hasOwn(questions, answer.name) || answers.has(answer.name)) throw failure('response');
      answers.set(answer.name, answer);
    }
    const done = choice(answers.get('done'), Object.keys(questions.done.criteria));
    const shape = choice(answers.get('shape'), Object.keys(questions.shape.criteria));
    const score = done.finished * (0.5 + 0.5 * shape.hands_on);
    const pressure = record.contextLimit > 0 ? record.inputTokens / record.contextLimit : NaN;
    const floor = !Number.isFinite(pressure) || pressure <= 0.1 ? 0.9 : pressure >= 0.9 ? 0.5
      : Math.round((0.9 - 0.4 * ((pressure - 0.1) / 0.8)) * 1000) / 1000;
    return { decision: score >= floor, score, floor, resolvedModel: judgment.model,
      usage: { input: judgment.usage.input_tokens, output: judgment.usage.output_tokens } };
  } catch (error) {
    if (error.kind) throw error;
    throw failure(signal.aborted ? 'timeout' : 'network');
  }
}

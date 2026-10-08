import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export function redact(text) {
  return String(text ?? '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{15,}|Bearer\s+\S+)/gi, '[REDACTED]')
    .replace(/\b([A-Z_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))\s*[=:]\s*["']?[^\s"',}]+/g, '$1=[REDACTED]');
}

function snapshot(messages, stateVersion, startsAt) {
  const exposeLoss = stateVersion !== '1';
  // Text only. Tool input/output and hidden reasoning are deliberately excluded.
  const entries = messages.filter(m => ['user', 'assistant', 'compaction'].includes(m.type)).map(m => {
    const original = String(m.type === 'user' ? m.text ?? '' : m.type === 'compaction' ? m.summary ?? ''
      : (m.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n'));
    const text = redact(original), limit = m.type === 'assistant' ? 6000 : 3000;
    const tools = (m.content ?? []).filter(p => p.type === 'tool');
    return { role: m.type === 'compaction' ? 'summary' : m.type, text: text.slice(0, limit),
      ...(m.type === 'assistant' ? { tools: tools.slice(-12).map(p => ({ name: redact(p.name).slice(0, 80), status: p.state?.status })) } : {}),
      ...(exposeLoss ? { loss: { textClipped: text.length > limit, redacted: text !== original,
        omittedToolStatuses: m.type === 'assistant' ? Math.max(0, tools.length - 12) : 0 } } : {}) };
  });
  const recent = [];
  let bytes = 0;
  for (const entry of entries.toReversed()) {
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (bytes + size > 22000) break;
    recent.unshift(entry);
    bytes += size;
  }
  const requestIndex = entries.findLastIndex(e => e.role === 'user');
  const request = entries[requestIndex];
  const buildState = () => ({ ...(exposeLoss ? { version: Number(stateVersion) } : {}), recent,
    ...(stateVersion === '3' ? { latestRequest: request ? {
      status: 'available', text: request.text,
      loss: { textClipped: request.loss.textClipped, redacted: request.loss.redacted },
      provenance: { source: 'user-message', sourceEntryIndex: requestIndex, startsAt,
        retainedInRecent: recent.includes(request), authority: 'not-verified' },
    } : { status: 'unavailable', reason: 'no-user-message-within-source-boundary',
      provenance: { startsAt, authority: 'not-verified' } } } : {}),
    coverage: { omittedEntries: entries.length - recent.length, toolContentsExcluded: true,
      historicalContextReconstructed: true, ...(exposeLoss ? {
        textClippedEntries: recent.filter(e => e.loss.textClipped).length,
        redactedEntries: recent.filter(e => e.loss.redacted).length,
        omittedToolStatuses: recent.reduce((n, e) => n + e.loss.omittedToolStatuses, 0),
        sourceHistory: { startsAt, originalTaskScope: 'not-verified', providerContext: 'approximation' },
      } : {}) }, compaction: { description: 'Host-native compaction is lossy; preserve active work and constraints.',
        ...(exposeLoss ? { persistence: 'unknown' } : {}) } });
  let state = buildState();
  // V3 pins the request without growing the payload budget, including the extra
  // escaping for string-input providers. Coverage describes only the rolling tail;
  // the pin carries its own loss/provenance.
  if (stateVersion === '3') {
    while (Buffer.byteLength(JSON.stringify(JSON.stringify(state))) > 22000) {
      if (!recent.length) throw new Error('State v3 exceeds payload bound');
      recent.shift();
      state = buildState();
    }
  }
  return state;
}

export function extract(path, { minimum = 40000, contextLimit = null, limits = {}, stateVersion = '1' } = {}) {
  if (!['1', '2', '3'].includes(stateVersion)) throw new Error('state-version must be 1, 2 or 3');
  const db = new DatabaseSync(path, { readOnly: true });
  const records = [];
  try {
    // A consistent read transaction, including any committed WAL data. No source writes.
    db.exec('BEGIN');
    const hasForks = db.prepare('PRAGMA table_info(session_v2)').all().some(c => c.name === 'fork_session_id');
    const allSessions = db.prepare(`SELECT id, parent_id, ${hasForks ? 'fork_session_id' : 'NULL AS fork_session_id'} FROM session_v2 ORDER BY id`).all();
    const sessions = allSessions.filter(s => s.parent_id === null);
    const forks = new Map(allSessions.map(s => [s.id, s.fork_session_id]));
    const groupRoot = id => {
      const seen = new Set();
      while (forks.get(id)) {
        if (seen.has(id)) throw new Error('Invalid cyclic session fork ancestry');
        seen.add(id);
        id = forks.get(id);
      }
      return id;
    };
    const query = db.prepare('SELECT id, type, seq, data FROM session_message WHERE session_id = ? ORDER BY seq');
    for (const session of sessions) {
      const messages = query.all(session.id).map(row => {
        try { return { ...JSON.parse(row.data), id: row.id, type: row.type, seq: row.seq }; }
        catch { throw new Error('Invalid OpenCode message JSON; source contents withheld.'); }
      });
      let boundary = 0;
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.type === 'compaction' && m.status === 'completed') boundary = i;
        if (m.type !== 'idle' || m.outcome !== 'succeeded') continue;
        const prior = messages.slice(boundary, i);
        const last = prior.findLast(p => ['user', 'assistant', 'compaction'].includes(p.type));
        if (last?.type !== 'assistant' || last.finish !== 'stop' || !last.time?.completed || last.error) continue;
        const t = last.tokens;
        const counts = [t?.input, t?.cache?.read, t?.cache?.write];
        if (!counts.every(n => Number.isSafeInteger(n) && n >= 0)) continue;
        const inputTokens = counts.reduce((a, b) => a + b, 0);
        if (inputTokens < minimum) continue;
        const id = createHash('sha256').update(`opencode:${session.id}:${last.id}`).digest('hex').slice(0, 24);
        if (records.some(r => r.id === id)) continue;
        const next = messages.slice(i + 1).find(p => p.type === 'user');
        const limit = limits[`${last.model?.providerID}/${last.model?.id}`] ?? contextLimit;
        if (limit !== null && (!Number.isSafeInteger(limit) || limit <= 0)) throw new Error('Invalid model context limit');
        records.push({ version: 1, id, group: createHash('sha256').update(groupRoot(session.id)).digest('hex').slice(0, 16),
          host: 'opencode-v2', model: last.model, inputTokens, contextLimit: limit,
          contextLimitSource: limit === null ? 'unknown' : 'user-supplied-not-historical', state: snapshot(prior, stateVersion, messages[boundary]?.type === 'compaction' ? 'compaction-summary' : 'session-start'), label: null,
          review: { nextUser: next ? redact(next.text).slice(0, 6000) : null,
            suggestion: next ? 'needs-review' : 'no-follow-up', note: 'Future text is review-only, never judge input. No follow-up is not a safe label.' } });
      }
    }
    db.exec('COMMIT');
    return records;
  } finally { db.close(); }
}

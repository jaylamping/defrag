// Native transcript formatting adapted from OpenCode's session/compaction.ts.
// See THIRD_PARTY_NOTICES.md. This is a matcher, never a transcript role parser.
const byteLimit = 128000, historyLimit = 128;

function truncate(text) {
  if (text.length <= 1250) return text;
  let end = 0, count = 0;
  for (const char of text) {
    if (count === 1250) break;
    end += char.length; count++;
  }
  return end === text.length ? text : text.slice(0, end) + '\n[truncated]';
}

function toolContent(content) {
  return content.map(p => p.type === 'text' ? p.text
    : `[Attached ${p.mime}${p.name === undefined ? '' : ': ' + p.name}]`).join('\n');
}

// Reproduce complete source records, including excluded parts, ONLY to verify
// the match locally. Nothing from this serialization is returned to a judge.
function render(message) {
  switch (message.type) {
    case 'user': return [
      ...(message.skills ?? []).flatMap(s => s.text === undefined ? [] : [`[Skill activated: ${s.name}]\n${s.text}`]),
      `[User]: ${message.text}`,
      ...(message.files ?? []).map(f => `[Attached ${f.mime}: ${f.name ?? (f.source.type === 'uri' ? f.source.uri : 'inline attachment')}]`),
    ].join('\n');
    case 'assistant': return message.content.flatMap(p => {
      if (p.type === 'text') return [`[Assistant]: ${p.text}`];
      if (p.type === 'reasoning') return p.text ? [`[Assistant reasoning]: ${p.text}`] : [];
      if (p.type !== 'tool') throw new Error('Unsupported content');
      const input = typeof p.state.input === 'string' ? p.state.input : JSON.stringify(p.state.input);
      const call = `[Assistant tool call]: ${p.name}(${input})`;
      if (p.state.status === 'completed') return [call, `[Tool result]: ${truncate(toolContent(p.state.content))}`];
      if (p.state.status === 'error') return [call, `[Tool error]: ${p.state.error.message}`];
      return [call];
    }).join('\n');
    case 'location-switched': return `[User]: The working directory has been changed to ${message.location.directory}.`;
    case 'synthetic': return `[Synthetic context]: ${message.text}`;
    case 'skill': return `[Skill activated: ${message.name}]\n${message.text}`;
    case 'shell': return message.metadata?.background === true ? '' : `[Shell]: ${message.command}\n${truncate(message.output?.output ?? '')}`;
    default: return '';
  }
}

export function retainedContext(compaction, history, encodeEntry) {
  const result = { status: 'excluded', sourceBytes: null, entries: [],
    provenance: { source: 'compaction.recent', authority: 'not-verified' },
    providerContextExcluded: compaction?.providerContext !== undefined,
    loss: { rawTranscriptExcluded: true, contentExcluded: true, omittedEntries: null,
      excludedToolParts: null, excludedReasoningParts: null, excludedMessages: null, textClippedEntries: null, redactedEntries: null } };
  const exclude = (status, reason) => ({ ...result, status, reason });
  if (!compaction) return exclude('not-applicable', 'no-completed-compaction');
  if (compaction.recent === undefined) return exclude('unavailable', 'retained-field-not-present');
  if (typeof compaction.recent !== 'string') return exclude('excluded', 'unsupported-source-format');
  const raw = compaction.recent;
  result.sourceBytes = Buffer.byteLength(raw);
  if (!raw) return exclude('empty', 'empty-retained-field');
  if (result.sourceBytes > byteLimit) return exclude('excluded', 'source-byte-limit');
  if (!Array.isArray(history)) return exclude('excluded', 'structured-source-unavailable');
  const start = Math.max(0, history.length - historyLimit);
  result.sourceHistory = { scannedEntries: 0, windowLimited: start > 0, maximumEntries: historyLimit };
  let serialized = '', matched = [];
  for (let i = history.length - 1; i >= start; i--) {
    result.sourceHistory.scannedEntries++;
    let text;
    try { text = render(history[i]); } catch { return exclude('excluded', 'no-exact-source-match'); }
    if (!text) continue;
    if (Buffer.byteLength(text) > byteLimit) return exclude('excluded', 'structured-source-byte-limit');
    serialized = text + (serialized ? '\n\n' + serialized : '');
    matched.unshift({ message: history[i], index: i });
    if (serialized === raw) break;
    if (serialized.length >= raw.length) return exclude('excluded', 'no-exact-source-match');
  }
  if (serialized !== raw) return exclude('excluded', start ? 'structured-source-window-limit' : 'no-exact-source-match');
  result.status = 'recovered';
  result.provenance.matching = 'exact-structured-history-suffix';
  result.loss.contentExcluded = false;
  result.loss.omittedEntries = 0;
  result.loss.excludedToolParts = matched.reduce((n, x) => n + (x.message.content ?? []).filter(p => p.type === 'tool').length, 0);
  result.loss.excludedReasoningParts = matched.reduce((n, x) => n + (x.message.content ?? []).filter(p => p.type === 'reasoning').length, 0);
  result.loss.excludedMessages = matched.filter(x => !['user', 'assistant'].includes(x.message.type)).length;
  result.loss.excludedAttachments = matched.reduce((n, x) => n + (x.message.files ?? []).length, 0);
  result.loss.excludedSkillTexts = matched.reduce((n, x) => n + (x.message.skills ?? []).filter(s => s.text !== undefined).length, 0);
  result.entries = matched.filter(x => ['user', 'assistant'].includes(x.message.type)).map(x => ({ ...encodeEntry(x.message),
    provenance: { source: 'structured-precompaction-history', sourceEntryIndex: x.index, authority: 'not-verified' } }));
  const user = result.entries.findLast(e => e.role === 'user');
  result.latestUser = user ? { status: 'available', text: user.text, loss: { ...user.loss }, provenance: { ...user.provenance } }
    : { status: 'unavailable', reason: 'no-user-message-in-matched-source' };
  return result;
}

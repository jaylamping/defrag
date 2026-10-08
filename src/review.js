export function sample(records, count) {
  // Deterministic round-robin by session: long sessions cannot dominate the first review.
  const groups = new Map();
  for (const r of records.toSorted((a, b) => a.id.localeCompare(b.id))) {
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group).push(r);
  }
  const result = [];
  while (result.length < count) {
    let added = false;
    for (const group of groups.values()) {
      if (group.length && result.length < count) { result.push(group.shift()); added = true; }
    }
    if (!added) break;
  }
  return result;
}

export function review(records) {
  const header = `# Private checkpoint review\n\nDo not publish this file. Redaction is best-effort.\n\n` +
    `Label each checkpoint **safe**, **unsafe**, or **uncertain**. Safe means lossy host compaction\n` +
    `would not discard details still needed for the next action: work is finished or durably recorded,\n` +
    `constraints and blockers are explicit. Waiting on you does not automatically mean safe.\n` +
    `Use future follow-up only as evidence, not as a shortcut. No follow-up is not evidence of safety.\n` +
    `Keep uncertain examples out of accuracy metrics. This is a session-balanced sample, not a random one.\n\n`;
  return header + records.map((r, i) => {
    // Literal transcript blocks avoid rendering embedded images/links from untrusted text.
    const literal = text => {
      const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map(m => m[0].length));
      const fence = '`'.repeat(longest + 1);
      return `${fence}text\n${text}\n${fence}`;
    };
    const history = r.state.recent.map(m => `### ${m.role}\n\n${literal(m.text)}\n`).join('\n');
    const request = r.state.version === 3
      ? `### Latest available user request (pinned evidence, not verified scope)\n\n${literal(JSON.stringify(r.state.latestRequest ?? { status: 'unknown' }, null, 2))}\n\n`
      : '';
    return `## ${i + 1}. ${r.id}\n\nSession group: ${r.group}. Input tokens: ${r.inputTokens}.\n\n` +
      `Omitted entries: ${r.state.coverage?.omittedEntries ?? 'unknown'}. Tool contents and hidden reasoning are excluded.\n\n` +
      request + history + `\n### Future follow-up (review only)\n\n${literal(r.review?.nextUser ?? '(none)')}\n\n` +
      `Decision: ___\nReason: ___\n\n---\n\n`;
  }).join('');
}

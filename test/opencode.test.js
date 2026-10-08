import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';

const temporary = [];
after(() => { for (const path of temporary) rmSync(path, { recursive: true }); });

async function load(options = {}, overrides = {}) {
  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const { default: plugin } = await import(new URL('../' + pkg.main, import.meta.url));
  assert.equal(plugin.id, 'defrag');
  const tools = new Map(), hooks = new Map(), reads = [];
  const messages = [
    { id: 'msg_request', type: 'user', text: 'Answer the diagnostic question. API_KEY=fictional-secret', time: { created: 1 } },
    { id: 'msg_done', type: 'assistant', finish: 'stop', time: { completed: 2 },
      content: [{ type: 'text', text: 'Diagnosis reported; awaiting permission before making changes.' },
        { type: 'reasoning', text: 'PRIVATE REASONING' },
        { type: 'tool', name: 'read', state: { status: 'completed', input: { path: 'PRIVATE PATH' }, content: [{ text: 'PRIVATE OUTPUT' }] } }] },
    { id: 'msg_idle', type: 'idle', outcome: 'succeeded' },
    { id: 'msg_new', type: 'user', text: 'Check compaction safety; do not implement anything.', time: { created: 3 } },
    { id: 'msg_check', type: 'assistant', content: [{ type: 'tool', id: 'call_check', name: 'defrag_preview', state: { status: 'running' } }] },
  ];
  const forbidden = () => { throw new Error('Host mutation or cross-session operation forbidden'); };
  const registration = { dispose: async () => {} };
  const ctx = {
    options, location: { directory: '/fictional/project' },
    tool: { transform: async callback => { callback({ add: tool => tools.set(tool.name, tool) }); return registration; } },
    permission: { hook: async (name, callback) => { hooks.set(name, callback); return registration; } },
    session: {
      get: async input => { reads.push(['get', input.sessionID]); return { id: input.sessionID, location: { directory: '/fictional/project' } }; },
      context: async input => { reads.push(['context', input.sessionID]); return structuredClone(messages); },
      compact: forbidden, prompt: forbidden, synthetic: forbidden, create: forbidden, remove: forbidden,
      ...overrides,
    },
    storage: { set: forbidden }, event: { subscribe: forbidden },
  };
  const cleanup = await plugin.setup(ctx);
  const invocation = { sessionID: 'ses_test', messageID: 'msg_check', id: 'call_check', signal: new AbortController().signal };
  return { tools, hooks, reads, messages, invocation, cleanup };
}

test('local plugin import registers a current-session preview without credentials, network or host mutations', async () => {
  const { tools, reads, invocation, cleanup } = await load();
  assert.ok(tools.has('defrag_preview'));
  assert.ok(!tools.has('defrag_check'), 'remote checks must require installation-time opt-in');
  const result = await tools.get('defrag_preview').execute({}, invocation);
  const p = JSON.parse(result.content);
  assert.equal(p.mode, 'local-preview');
  assert.equal(p.hostedCalls, 0);
  assert.equal(p.advisoryOnly, true);
  assert.equal(p.compactionRequested, false);
  assert.equal(p.stateVersion, 3);
  assert.equal(p.latestRequest.status, 'available');
  assert.equal(p.observerToolExcluded, true);
  assert.equal(p.activeTools, 0);
  assert.match(p.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(p.encodedStateBytes <= 22000);
  assert.ok(reads.every(([, sessionID]) => sessionID === invocation.sessionID));
  for (const secret of ['fictional-secret', 'PRIVATE REASONING', 'PRIVATE PATH', 'PRIVATE OUTPUT', 'diagnostic question']) assert.ok(!result.content.includes(secret));
  if (cleanup) await cleanup();
});

test('adviser tools bypass Code Mode so the recorded caller is the observer, not an execute wrapper', async () => {
  const preview = await load();
  assert.equal(preview.tools.get('defrag_preview').options?.codemode, false);
  await hostedFixture(async ({ options, requests }) => {
    const { tools } = await load(options);
    assert.equal(tools.get('defrag_check').options.codemode, false);
    assert.equal(tools.get('defrag_check').options.permission, 'defrag.remote');
    assert.equal(requests.length, 0);
  });
});

async function hostedFixture(callback) {
  const dir = mkdtempSync(join(tmpdir(), 'defrag-plugin-'));
  temporary.push(dir);
  const keyFile = join(dir, 'key'), key = 'fixture-plugin-key';
  writeFileSync(keyFile, key, { mode: 0o600 });
  const requests = [];
  const control = {};
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    requests.push(input);
    await control.onRequest?.(req, res);
    if (control.status) { res.statusCode = control.status; res.end('PRIVATE PROVIDER DIAGNOSTIC'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'jev-fixture', usage: { input_tokens: 100, output_tokens: 50 },
      answers: Object.fromEntries(Object.entries(input.questions).map(([name, q]) => {
        const names = Object.keys(q.criteria);
        return [name, { type: 'choice', choice: names[0], confidence: 0.99,
          probabilities: Object.fromEntries(names.map((n, i) => [n, i === 0 ? 0.99 : 0.005])) }];
      })) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await callback({ options: { remoteEnabled: true, keyFile, endpoint: `http://127.0.0.1:${server.address().port}/v1/systemone` }, requests, key, control });
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test('hosted plugin checks do not override host permission decisions and use bounded, current-session v3 evidence', async () => {
  await hostedFixture(async ({ options, requests, key }) => {
    const { tools, hooks, messages, invocation } = await load(options);
    const check = tools.get('defrag_check');
    assert.ok(check);
    assert.equal(check.options.permission, 'defrag.remote');
    const hook = hooks.get('evaluate');
    for (const effect of ['allow', 'ask', 'deny']) {
      const event = { action: 'defrag.remote', effect };
      await hook?.(event);
      assert.equal(event.effect, effect, 'Allow All must not be escalated to a prompt; preserve the host policy');
    }
    const other = { action: 'read', effect: 'allow' };
    await hook?.(other);
    assert.equal(other.effect, 'allow');
    messages.at(-1).content[0].name = 'defrag_check';
    messages.at(-2).text += ' ' + key;
    assert.equal(requests.length, 0, 'loading and permission evaluation must not make inference requests');
    const result = JSON.parse((await check.execute({}, invocation)).content);
    assert.equal(requests.length, 1);
    assert.equal(result.hostedCalls, 1);
    assert.equal(result.decision, true);
    assert.equal(result.assessment, 'safe');
    assert.equal(result.floor, 0.9);
    assert.equal(result.recipe, 'checkpoint-v2');
    assert.equal(result.advisoryOnly, true);
    assert.equal(result.compactionRequested, false);
    assert.equal(result.stateUnchanged, true);
    assert.match(result.warning, /not.*authorization/i);
    const input = requests[0];
    assert.equal(input.state.version, 3);
    assert.equal(input.state.coverage.historicalContextReconstructed, false);
    assert.equal(input.state.coverage.source, 'opencode-session-context-api');
    assert.equal(input.state.latestRequest.text, 'Check compaction safety; do not implement anything. [REDACTED]');
    assert.equal(input.state.latestRequest.loss.redacted, true);
    assert.ok(input.state.recent.some(e => e.text.includes('awaiting permission')));
    assert.ok(!input.state.recent.some(e => e.tools?.some(t => t.name === 'defrag_check')));
    assert.ok(Buffer.byteLength(JSON.stringify(input)) <= 32000);
    for (const secret of [key, 'fictional-secret', 'PRIVATE REASONING', 'PRIVATE PATH', 'PRIVATE OUTPUT']) assert.ok(!JSON.stringify(input).includes(secret));
    assert.ok(!JSON.stringify(result).includes('diagnostic question'));
  });
});

test('a hosted recommendation becomes an abstention if session evidence changes during inference', async () => {
  await hostedFixture(async ({ options, requests, control }) => {
    const { tools, messages, invocation } = await load(options);
    messages.at(-1).content[0].name = 'defrag_check';
    control.onRequest = () => { messages.push({ type: 'user', id: 'msg_changed', text: 'Implement the fix now.' }); };
    const p = JSON.parse((await tools.get('defrag_check').execute({}, invocation)).content);
    assert.equal(requests.length, 1);
    assert.equal(p.decision, null);
    assert.equal(p.error, 'stale-context');
    assert.equal(p.stateUnchanged, false);
    assert.ok(!Object.hasOwn(p, 'axes'));
    assert.ok(!Object.hasOwn(p, 'assessment'));
    assert.equal(p.compactionRequested, false);
    assert.ok(!JSON.stringify(p).includes('Implement the fix'));
  });
});

test('stopping the calling session cancels the outstanding judge request without retries', async () => {
  await hostedFixture(async ({ options, requests, control }) => {
    const { tools, messages, invocation } = await load(options);
    messages.at(-1).content[0].name = 'defrag_check';
    const controller = new AbortController();
    control.onRequest = async (_, response) => {
      const closed = new Promise(resolve => response.once('close', resolve));
      controller.abort();
      await closed;
    };
    const started = performance.now();
    const p = JSON.parse((await tools.get('defrag_check').execute({}, { ...invocation, signal: controller.signal })).content);
    assert.equal(p.decision, null);
    assert.equal(p.error, 'cancelled');
    assert.equal(requests.length, 1);
    assert.ok(performance.now() - started < 1000, 'cancellation must abort transport, not wait for its 5-second timeout');
    assert.equal(p.compactionRequested, false);
  });
});

test('plugin unload cancels inference and duplicate checks cannot spend concurrently on the same session', async () => {
  await hostedFixture(async ({ options, requests, control }) => {
    const { tools, messages, invocation, cleanup } = await load(options);
    assert.equal(typeof cleanup, 'function');
    messages.at(-1).content[0].name = 'defrag_check';
    let duplicate;
    const check = tools.get('defrag_check');
    control.onRequest = async (_, response) => {
      if (requests.length !== 1) return;
      duplicate = JSON.parse((await check.execute({}, invocation)).content);
      const closed = new Promise(resolve => response.once('close', resolve));
      await cleanup();
      await closed;
    };
    const started = performance.now();
    const p = JSON.parse((await check.execute({}, invocation)).content);
    assert.equal(duplicate.error, 'busy');
    assert.equal(duplicate.decision, null);
    assert.equal(duplicate.hostedCalls, 0);
    assert.equal(p.error, 'cancelled');
    assert.equal(p.decision, null);
    assert.equal(requests.length, 1);
    assert.ok(performance.now() - started < 1000);
    const after = JSON.parse((await check.execute({}, invocation)).content);
    assert.equal(after.error, 'cancelled');
    assert.equal(after.hostedCalls, 0);
    await cleanup();
  });
});

test('hosted failures abstain without retries or exposing provider diagnostics', async () => {
  await hostedFixture(async ({ options, requests, control }) => {
    const { tools, messages, invocation } = await load(options);
    messages.at(-1).content[0].name = 'defrag_check';
    for (const [status, kind] of [[429, 'rate-limit'], [500, 'server'], [401, 'authentication']]) {
      control.status = status;
      const before = requests.length;
      const p = JSON.parse((await tools.get('defrag_check').execute({}, invocation)).content);
      assert.equal(requests.length - before, 1);
      assert.equal(p.decision, null);
      assert.equal(p.error, kind);
      assert.equal(p.compactionRequested, false);
      assert.ok(!Object.hasOwn(p, 'axes'));
      assert.ok(!JSON.stringify(p).includes('PRIVATE'));
    }
  });
});

test('plugin configuration and cross-location checks fail closed before any hosted work', async () => {
  for (const options of [{ remoteEnabled: 'yes' }, { remoteEnabled: true }, { remoteEnabled: true, keyFile: './relative.key' }, { timeoutMs: 0 }]) {
    await assert.rejects(load(options));
  }
  await hostedFixture(async ({ options, requests }) => {
    const { tools, invocation } = await load(options, {
      get: async () => ({ location: { directory: '/PRIVATE OTHER LOCATION' } }),
    });
    for (const name of ['defrag_preview', 'defrag_check']) {
      assert.deepEqual(tools.get(name).input, { type: 'object', properties: {}, additionalProperties: false });
      const p = JSON.parse((await tools.get(name).execute({}, invocation)).content);
      assert.equal(p.decision, null);
      assert.equal(p.hostedCalls, 0);
      assert.equal(p.error, 'context');
      assert.ok(!JSON.stringify(p).includes('PRIVATE'));
    }
    assert.equal(requests.length, 0);
    const missing = await load({ ...options, keyFile: join(tmpdir(), 'PRIVATE-MISSING-DEFRAG-KEY') });
    const p = JSON.parse((await missing.tools.get('defrag_check').execute({}, invocation)).content);
    assert.equal(p.decision, null);
    assert.equal(p.hostedCalls, 0);
    assert.ok(!JSON.stringify(p).includes('PRIVATE'));
  });
});

test('changes in excluded tool contents still invalidate an outstanding judgment', async () => {
  await hostedFixture(async ({ options, control }) => {
    const { tools, messages, invocation } = await load(options);
    messages.at(-1).content[0].name = 'defrag_check';
    control.onRequest = () => { messages[1].content[2].state.content[0].text = 'CHANGED PRIVATE OUTPUT'; };
    const p = JSON.parse((await tools.get('defrag_check').execute({}, invocation)).content);
    assert.equal(p.decision, null);
    assert.equal(p.error, 'stale-context');
    assert.ok(!JSON.stringify(p).includes('PRIVATE'));
  });
});

test('package import contents include the plugin entrypoint and exclude private evaluation artifacts', () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: new URL('../', import.meta.url).pathname, encoding: 'utf8',
  });
  assert.equal(result.status, 0, 'package dry-run must succeed');
  const files = JSON.parse(result.stdout)[0].files.map(f => f.path);
  for (const required of ['index.js', 'src/opencode.js', 'src/corpus.js', 'src/jev.js', 'package.json', 'LICENSE']) assert.ok(files.includes(required));
  assert.ok(files.every(path => ['index.js', 'package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'].includes(path)
    || /^src\/[^/]+\.js$/.test(path)), 'only public runtime source and package documentation may be packed');
});

test('known active tools other than the observer block hosted judging before it can spend', async () => {
  await hostedFixture(async ({ options, requests }) => {
    const { tools, messages, invocation } = await load(options);
    messages.at(-1).content[0].name = 'defrag_check';
    for (const status of ['running', 'streaming']) {
      messages.at(-1).content[1] = { type: 'tool', id: 'other_call', name: 'shell', state: { status } };
      const p = JSON.parse((await tools.get('defrag_check').execute({}, invocation)).content);
      assert.equal(p.decision, null);
      assert.equal(p.error, 'busy');
      assert.equal(p.hostedCalls, 0);
    }
    assert.equal(requests.length, 0);
  });
});

test('an arbitrary execute wrapper remains active work, even if its input mentions the adviser', async () => {
  await hostedFixture(async ({ options, requests }) => {
    const { tools, messages, invocation } = await load(options);
    messages.at(-1).content[0] = { type: 'tool', id: invocation.id, name: 'execute',
      state: { status: 'running', input: { code: 'await tools.defrag_check(); await tools.shell({command: "real work"});' } } };
    const preview = JSON.parse((await tools.get('defrag_preview').execute({}, invocation)).content);
    assert.equal(preview.activeTools, 1);
    const check = JSON.parse((await tools.get('defrag_check').execute({}, invocation)).content);
    assert.equal(check.error, 'busy');
    assert.equal(check.decision, null);
    assert.equal(check.hostedCalls, 0);
    assert.equal(requests.length, 0);
  });
});

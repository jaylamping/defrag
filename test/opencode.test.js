import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
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
  assert.ok(!Object.hasOwn(p, 'telemetry'), 'default preview must not enable logging');
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

test('persisting the calling observer message stream timestamp does not invalidate unchanged evidence', async () => {
  for (const stateVersion of [3, 4]) {
    for (const streamed of [undefined, 4]) {
      await hostedFixture(async ({ options, requests, control }) => {
        const { tools, messages, invocation, cleanup } = await load({ ...options, stateVersion });
        messages.at(-1).content[0].name = 'defrag_check';
        messages.at(-1).time = { created: 4, ...(streamed === undefined ? {} : { streamed }) };
        control.onRequest = () => { messages.at(-1).time.streamed = 5; };
        const result = JSON.parse((await tools.get('defrag_check').execute({}, invocation)).content);
        assert.equal(requests.length, 1);
        assert.equal(result.error, undefined);
        assert.equal(result.stateUnchanged, true);
        assert.equal(result.decision, true, 'loopback fixture recommendation must survive observer-only stream bookkeeping');
        assert.equal(result.compactionRequested, false);
        assert.equal(messages.at(-1).time.streamed, 5, 'capture must not mutate host data');
        await cleanup();
      });
    }
  }
});

test('stream timestamp normalization does not hide other message or observer lifecycle changes', async () => {
  for (const mutate of [
    messages => { messages[1].time.streamed = 5; },
    messages => { messages.at(-1).time.created = 5; },
    messages => { messages.at(-1).time.completed = 5; },
    messages => { messages.at(-1).finish = 'stop'; },
    messages => { messages.at(-1).content.push({ type: 'text', text: 'A new unresolved obligation.' }); },
    messages => { messages.at(-1).content.push({ type: 'reasoning', text: 'CHANGED PRIVATE REASONING' }); },
    messages => { messages.at(-1).content.push({ type: 'tool', id: 'other_call', name: 'shell', state: { status: 'running' } }); },
    messages => { messages.at(-1).metadata = { newWorkflowState: true }; },
  ]) {
    await hostedFixture(async ({ options, requests, control }) => {
      const { tools, messages, invocation, cleanup } = await load(options);
      messages.at(-1).content[0].name = 'defrag_check';
      messages.at(-1).time = { created: 4 };
      control.onRequest = () => { messages.at(-1).time.streamed = 5; mutate(messages); };
      const result = JSON.parse((await tools.get('defrag_check').execute({}, invocation)).content);
      assert.equal(requests.length, 1);
      assert.equal(result.decision, null);
      assert.equal(result.error, 'stale-context');
      assert.equal(result.stateUnchanged, false);
      assert.ok(!Object.hasOwn(result, 'axes'));
      assert.equal(result.compactionRequested, false);
      await cleanup();
    });
  }
});

test('observer stream bookkeeping does not hide session agent, model or revert changes', async () => {
  for (const [field, changed] of [
    ['agent', 'plan'], ['model', { providerID: 'fixture', id: 'different' }], ['revert', { messageID: 'msg_request' }],
  ]) {
    await hostedFixture(async ({ options, requests, control }) => {
      const session = { agent: 'build', model: { providerID: 'fixture', id: 'original' } };
      const { tools, messages, invocation, cleanup } = await load(options, {
        get: async () => ({ location: { directory: '/fictional/project' }, ...structuredClone(session) }),
      });
      messages.at(-1).content[0].name = 'defrag_check';
      messages.at(-1).time = { created: 4 };
      control.onRequest = () => { messages.at(-1).time.streamed = 5; session[field] = changed; };
      const result = JSON.parse((await tools.get('defrag_check').execute({}, invocation)).content);
      assert.equal(requests.length, 1);
      assert.equal(result.decision, null);
      assert.equal(result.error, 'stale-context');
      assert.equal(result.stateUnchanged, false);
      assert.equal(result.compactionRequested, false);
      await cleanup();
    });
  }
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
  for (const required of ['index.js', 'src/opencode.js', 'src/corpus.js', 'src/jev.js', 'src/telemetry.js', 'package.json', 'LICENSE']) assert.ok(files.includes(required));
  assert.ok(files.every(path => ['index.js', 'package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'].includes(path)
    || /^src\/[^/]+\.js$/.test(path)), 'only public runtime source and package documentation may be packed');
});

test('repository test scripts cannot discover executable tests inside private evaluation artifacts', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test test/*.test.js');
  assert.equal(pkg.scripts.check, 'node --check src/cli.js && node --test test/*.test.js');
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

test('opt-in v4 preview reports opaque retained context without returning transcript text or accessing history', async () => {
  const { tools, messages, invocation, reads } = await load({ stateVersion: 4 });
  messages[0] = { type: 'compaction', status: 'completed', summary: 'Checkpoint.', recent: '[User]: PRIVATE RETAINED TEXT' };
  const p = JSON.parse((await tools.get('defrag_preview').execute({}, invocation)).content);
  assert.equal(p.stateVersion, 4);
  assert.equal(p.retainedContext.status, 'excluded');
  assert.equal(p.retainedContext.reason, 'structured-source-unavailable');
  assert.ok(!Object.hasOwn(p.retainedContext, 'entries'));
  assert.ok(!Object.hasOwn(p.retainedContext, 'latestUser'));
  assert.ok(!JSON.stringify(p).includes('PRIVATE RETAINED TEXT'));
  assert.equal(reads.length, 2);
  for (const stateVersion of [2, 5, '4']) await assert.rejects(load({ stateVersion }));
});

test('v4 hosted fixtures omit opaque retained bodies but still invalidate changes to them during judging', async () => {
  await hostedFixture(async ({ options, requests, control }) => {
    const { tools, messages, invocation } = await load({ ...options, stateVersion: 4 });
    messages[0] = { type: 'compaction', status: 'completed', summary: 'Checkpoint.', recent: '[Tool result]: PRIVATE RETAINED TEXT' };
    messages.at(-1).content[0].name = 'defrag_check';
    const check = tools.get('defrag_check');
    const result = JSON.parse((await check.execute({}, invocation)).content);
    assert.equal(result.stateVersion, 4);
    assert.equal(requests[0].state.retainedContext.status, 'excluded');
    assert.ok(!JSON.stringify(requests).includes('PRIVATE RETAINED TEXT'));
    control.onRequest = () => { messages[0].recent = '[Tool result]: CHANGED RETAINED TEXT'; };
    const changed = JSON.parse((await check.execute({}, invocation)).content);
    assert.equal(changed.error, 'stale-context');
    assert.equal(changed.decision, null);
  });
});

function telemetryDirectory() {
  const root = mkdtempSync(join(tmpdir(), 'defrag-plugin-telemetry-'));
  temporary.push(root);
  return join(root, 'logs');
}

const telemetryEvents = directory => readdirSync(directory).flatMap(file =>
  readFileSync(join(directory, file), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));

test('opt-in plugin preview telemetry logs metadata without extra session reads, credentials or raw state', async () => {
  const directory = telemetryDirectory();
  const { tools, reads, invocation, cleanup } = await load({ telemetry: { directory }, stateVersion: 4 });
  const result = JSON.parse((await tools.get('defrag_preview').execute({}, invocation)).content);
  assert.equal(result.telemetry.accepted, true);
  assert.equal(result.telemetry.state, 'active');
  assert.equal(result.hostedCalls, 0);
  assert.equal(reads.length, 2);
  await cleanup();
  const [event] = telemetryEvents(directory);
  assert.equal(event.eventID, result.telemetry.eventID);
  assert.equal(event.target, 'none');
  assert.equal(event.snapshot.fingerprint, result.fingerprint);
  assert.equal(event.snapshot.encodedStateBytes, result.encodedStateBytes);
  assert.equal(event.snapshot.latestRequest.status, 'available');
  assert.ok(event.durationMs >= 0);
  assert.ok(event.timings.captureMs >= 0);
  for (const forbidden of ['PRIVATE', 'fictional-secret', 'diagnostic question', invocation.sessionID, directory]) {
    assert.ok(!JSON.stringify(event).includes(forbidden));
  }
});

test('plugin telemetry records accepted, stale, failed and busy checks without new inference or exposing discarded judgments as accepted', async () => {
  await hostedFixture(async ({ options, requests, key, control }) => {
    const directory = telemetryDirectory();
    const { tools, messages, reads, invocation, cleanup } = await load({ ...options, telemetry: { directory } });
    messages.at(-1).content[0].name = 'defrag_check';
    const check = tools.get('defrag_check');
    const accepted = JSON.parse((await check.execute({}, invocation)).content);
    assert.equal(accepted.decision, true);
    assert.equal(reads.length, 4, 'telemetry must not recapture the session');
    control.onRequest = () => { messages.at(-2).text = 'PRIVATE NEW REQUEST'; };
    const stale = JSON.parse((await check.execute({}, invocation)).content);
    assert.equal(stale.error, 'stale-context');
    assert.ok(!Object.hasOwn(stale, 'axes'));
    control.onRequest = undefined;
    control.status = 429;
    const failed = JSON.parse((await check.execute({}, invocation)).content);
    assert.equal(failed.error, 'rate-limit');
    messages.at(-1).content.push({ type: 'tool', id: 'another', name: 'shell', state: { status: 'running' } });
    const busy = JSON.parse((await check.execute({}, invocation)).content);
    assert.equal(busy.error, 'busy');
    assert.equal(requests.length, 3, 'no telemetry request, retry or fallback');
    await cleanup();
    const events = telemetryEvents(directory);
    assert.equal(events.length, 4);
    assert.equal(events[0].result.decision, true);
    assert.equal(events[0].target, 'loopback-fixture');
    assert.equal(events[0].hostedCalls, 1);
    assert.deepEqual(events[0].result.usage, { input: 100, output: 50 });
    assert.ok(events[0].snapshot.encodedStateBytes > 0);
    assert.ok(events[0].timings.judgeMs >= 0);
    assert.equal(events[1].error, 'stale-context');
    assert.equal(events[1].result.decision, null);
    assert.equal(events[1].discardedJudgment.decision, true);
    assert.deepEqual(events[1].discardedJudgment.usage, { input: 100, output: 50 });
    assert.equal(events[2].error, 'rate-limit');
    assert.equal(events[2].httpStatus, 429);
    assert.equal(events[3].hostedCalls, 0);
    assert.equal(events[3].error, 'busy');
    for (const forbidden of ['PRIVATE', key, 'fictional-secret', invocation.sessionID, directory]) {
      assert.ok(!JSON.stringify(events).includes(forbidden));
    }
  });
});

test('failed telemetry initialization never changes preview decisions or returns private filesystem diagnostics', async () => {
  const directory = telemetryDirectory();
  mkdirSync(directory); chmodSync(directory, 0o755);
  const { tools, invocation, cleanup } = await load({ telemetry: { directory } });
  const result = JSON.parse((await tools.get('defrag_preview').execute({}, invocation)).content);
  assert.equal(result.mode, 'local-preview');
  assert.ok(!Object.hasOwn(result, 'error'));
  assert.equal(result.telemetry.state, 'unavailable');
  assert.equal(result.telemetry.accepted, false);
  assert.ok(!JSON.stringify(result).includes(directory));
  assert.equal(readdirSync(directory).length, 0);
  await cleanup();
});

test('telemetry records caller cancellation without retrying or copying diagnostics', async () => {
  await hostedFixture(async ({ options, requests, control }) => {
    const directory = telemetryDirectory();
    const { tools, messages, invocation, cleanup } = await load({ ...options, telemetry: { directory } });
    messages.at(-1).content[0].name = 'defrag_check';
    const controller = new AbortController();
    control.onRequest = async (_, response) => {
      const closed = new Promise(resolve => response.once('close', resolve));
      controller.abort();
      await closed;
    };
    const result = JSON.parse((await tools.get('defrag_check').execute({}, { ...invocation, signal: controller.signal })).content);
    assert.equal(result.error, 'cancelled');
    assert.equal(requests.length, 1);
    await cleanup();
    const [event] = telemetryEvents(directory);
    assert.equal(event.error, 'cancelled');
    assert.equal(event.result.decision, null);
    assert.ok(event.timings.judgeMs >= 0);
  });
});

test('a blocked telemetry file write cannot hold up the actual preview tool result', { timeout: 2000 }, async t => {
  const { open } = await import('node:fs/promises');
  const directory = telemetryDirectory();
  const probe = await open(join(directory, '..', 'prototype-probe'), 'wx', 0o600);
  const prototype = Object.getPrototypeOf(probe), originalWrite = prototype.writeFile;
  await probe.close();
  let release, started, finished;
  const gate = new Promise(resolve => { release = resolve; });
  const writing = new Promise(resolve => { started = resolve; });
  const written = new Promise(resolve => { finished = resolve; });
  t.after(() => { prototype.writeFile = originalWrite; release(); });
  prototype.writeFile = async function (...args) {
    started();
    await gate;
    const result = await originalWrite.apply(this, args);
    finished();
    return result;
  };
  const { tools, invocation, cleanup } = await load({ telemetry: { directory } });
  const result = JSON.parse((await tools.get('defrag_preview').execute({}, invocation)).content);
  assert.equal(result.telemetry.accepted, true, 'tool must return before the blocked write is released');
  await writing;
  await cleanup();
  release();
  await written;
  assert.equal(telemetryEvents(directory).length, 1);
});

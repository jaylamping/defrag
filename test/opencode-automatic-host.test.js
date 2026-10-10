import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

for (const effect of ['allow', 'ask', 'deny', 'stream', 'hard-limit', 'hard-ask', 'hard-deny', 'child-stream', 'child-hard-limit']) test(`isolated V2 automatic ${effect} policy respects host permissions without prompts or external model calls`,
  { skip: !process.env.DEFRAG_OPENCODE_BIN, timeout: 30000 }, async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'defrag-auto-host-')));
    for (const name of ['config', 'data', 'cache', 'state', 'probe', 'logs']) mkdirSync(join(dir, name), { mode: 0o700 });
    const root = new URL('../', import.meta.url).pathname;
    const at = Date.now();
    let sessionID = 'ses_defrag_auto_host';
    const childSession = effect.startsWith('child-');
    const nativeStream = effect === 'stream' || effect.startsWith('hard-') || childSession;
    const forced = effect.includes('hard-');
    const allowed = ['allow', 'stream', 'hard-limit', 'child-stream', 'child-hard-limit'].includes(effect);
    writeFileSync(join(dir, 'key'), 'synthetic-local-key', { mode: 0o600 });
    writeFileSync(join(dir, 'protocol.json'), JSON.stringify({ directory: dir, at, sessionID }), { mode: 0o600 });
    let requests = 0, modelRequests = 0;
    const judge = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      if (req.url === '/model/chat/completions') {
        modelRequests++;
        res.setHeader('content-type', 'text/event-stream');
        for (const chunk of [
          { choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic work complete.' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: forced ? 35000 : 40000, completion_tokens: 4, total_tokens: forced ? 35004 : 40004 } },
        ]) res.write('data: ' + JSON.stringify({ id: 'chatcmpl_fixture', object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000), model: 'fixture', ...chunk }) + '\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      requests++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'jev-fixture', usage: { input_tokens: 0, output_tokens: 0 },
        answers: Object.fromEntries(Object.entries(input.questions).map(([name, q]) => {
          const names = Object.keys(q.criteria);
          return [name, { type: 'choice', choice: names[0], confidence: 0.99,
            probabilities: Object.fromEntries(names.map((n, i) => [n, i === 0 ? 0.99 : 0.005])) }];
        })) }));
    });
    await new Promise(resolve => judge.listen(0, '127.0.0.1', resolve));
    writeFileSync(join(dir, 'probe/package.json'), JSON.stringify({ type: 'module', main: './index.js' }), { mode: 0o600 });
    // The stream case uses real execution and unmodified native events with a
    // loopback model; other cases fabricate only the trigger and checkpoint.
    // Permissions, API admission and native completion always use the real host.
    writeFileSync(join(dir, 'probe/index.js'), `
      import defrag from ${JSON.stringify(root + 'src/opencode.js')};
      import { readFileSync, writeFileSync, readdirSync, watch } from 'node:fs';
      const protocol = JSON.parse(readFileSync(new URL('../protocol.json', import.meta.url), 'utf8'));
      const directory = protocol.directory;
      export default { id: 'defrag-auto-host-probe', async setup(ctx) {
        let modelRequests = 0;
        await ctx.session.hook('http.request', event => {
          if (${nativeStream} && event.kind === 'primary'
              && event.request.url === ${JSON.stringify(`http://127.0.0.1:${judge.address().port}/model/chat/completions`)}) return;
          modelRequests++;
          writeFileSync(directory + '/model-requests.json', JSON.stringify({ modelRequests }), { mode: 0o600 });
          throw new Error('External model requests forbidden in synthetic automation test');
        });
        await ctx.session.hook('experimental.ws.handshake', () => { throw new Error('External WebSocket requests forbidden'); });
        await ctx.session.hook('title', event => { event.result = { title: 'Synthetic automation fixture' }; });
        await ctx.session.hook('compaction', event => { event.result = { summary: '## Objective\\nSynthetic fixture complete.\\n## Next Move\\nNone.' }; });
        let activate;
        const ready = new Promise(resolve => { activate = resolve; });
        const trigger = watch(directory, (kind, filename) => {
          if (String(filename) === 'go') { activate(); trigger.close(); }
        });
        const cleanup = await defrag.setup({ ...ctx, options: {
          remoteEnabled: true, keyFile: directory + '/key', endpoint: ${JSON.stringify(`http://127.0.0.1:${judge.address().port}/v1/systemone`)},
          telemetry: { directory: directory + '/logs' }, automatic: {
            expiresAt: ${JSON.stringify(new Date(at + 7 * 86400000 - 1000).toISOString())}, maxChecks: null, maxCompactions: null,
            hardLimitRatio: ${forced ? '0.35' : 'null'},
          },
        }, event: ${nativeStream ? 'ctx.event' : `{ subscribe: async function* ({ signal }) {
          await ready;
          yield { id: 'evt_synthetic', type: 'session.execution.succeeded', created: protocol.at,
            location: { directory }, data: { sessionID: protocol.sessionID } };
          for await (const event of ctx.event.subscribe({ signal })) yield event;
        } }`} });
        return async () => { trigger.close(); activate(); await cleanup(); };
      } };`, { mode: 0o600 });
    writeFileSync(join(dir, 'opencode.json'), JSON.stringify({
      plugins: [join(dir, 'probe')], permissions: [{ action: '*', resource: '*', effect: allowed ? 'allow' : effect.replace('hard-', '') }],
      warming: false, compaction: { auto: false },
      ...(nativeStream ? { model: 'defrag-fixture/fixture', providers: { 'defrag-fixture': {
        name: 'Loopback fixture', package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: `http://127.0.0.1:${judge.address().port}/model`, apiKey: 'synthetic-local-key' },
        models: { fixture: { limit: { context: forced ? 100000 : 200000, output: 1000 } } },
      } } } : {}),
    }), { mode: 0o600 });
    const env = { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: join(dir, 'config'),
      XDG_DATA_HOME: join(dir, 'data'), XDG_CACHE_HOME: join(dir, 'cache'), XDG_STATE_HOME: join(dir, 'state'), TMPDIR: dir };
    const child = spawn(process.env.DEFRAG_OPENCODE_BIN, ['serve', '--service', '--hostname', '127.0.0.1', '--port', '0'],
      { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise(resolve => child.once('close', resolve));
    try {
      await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('Isolated automation host startup timed out')), 10000);
        const inspect = chunk => { output += chunk; if (/http:\/\/127\.0\.0\.1:\d+/.test(output)) { clearTimeout(timer); resolve(); } };
        child.stdout.on('data', inspect); child.stderr.on('data', inspect);
        child.once('error', () => { clearTimeout(timer); reject(new Error('Isolated automation host startup failed')); });
      });
      const request = (path, body) => {
        const r = spawnSync(process.env.DEFRAG_OPENCODE_BIN, ['api', body ? 'post' : 'get', path,
          ...(body ? ['--data', JSON.stringify(body)] : [])], { cwd: dir, env, encoding: 'utf8', timeout: 5000 });
        assert.equal(r.status, 0, 'Isolated authenticated request failed; diagnostics withheld');
        return JSON.parse(r.stdout);
      };
      assert.equal(request('/api/info').pid, child.pid, 'Never reach the user server');
      request('/api/command');
      const { data: template } = request('/api/session', { title: 'Synthetic automation fixture', location: { directory: dir } });
      const { data: model } = request('/api/model/default');
      if (childSession) {
        sessionID = 'ses_defrag_auto_host_child';
        request('/api/experimental/session/import', { info: { ...template, id: sessionID, parentID: template.id, model, agent: 'general' },
          location: { directory: dir }, messages: [] });
        assert.equal(request(`/api/session/${sessionID}`).data.parentID, template.id);
      }
      else if (nativeStream) sessionID = template.id;
      else request('/api/experimental/session/import', { info: { ...template, id: sessionID, model, agent: 'build', outcome: 'succeeded',
        time: { ...template.time, created: at - 10, updated: at, idle: at } }, location: { directory: dir }, messages: [
        { type: 'user', id: 'msg_auto_request', time: { created: at - 5 }, text: 'Synthetic fixture: report completion; no remaining work.' },
        { type: 'assistant', id: 'msg_auto_done', time: { created: at - 4, completed: at - 1 }, agent: 'build', model,
          content: [{ type: 'text', text: 'Synthetic work complete.' }], finish: 'stop',
          tokens: { input: 40000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
        { type: 'idle', id: 'msg_auto_idle', time: { created: at }, outcome: 'succeeded' },
      ] });
      if (nativeStream) request(`/api/session/${sessionID}/prompt`, { text: 'Synthetic fixture: report completion; no remaining work.', delivery: 'queue' });
      else writeFileSync(join(dir, 'go'), 'synthetic trigger', { mode: 0o600 });
      const readEvents = () => readdirSync(join(dir, 'logs')).filter(n => n.endsWith('.jsonl')).flatMap(n =>
        readFileSync(join(dir, 'logs', n), 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }));
      let events = [];
      for (let attempt = 0; attempt < 100; attempt++) {
        events = readEvents();
        if (events.some(e => allowed ? e.mode === 'automatic-compaction' && e.compactionStatus === 'completed'
          : e.mode === 'automatic-check' && e.error === 'automatic-permission')) break;
        await delay(100);
      }
      assert.equal(request(`/api/session/${sessionID}/permission`).data.length, 0, 'No pending automatic permission prompt');
      assert.equal(existsSync(join(dir, 'model-requests.json')), false);
      if (nativeStream) {
        assert.equal(modelRequests, 1, 'One real agent turn against the loopback model');
      }
      if (!allowed) {
        assert.equal(requests, 0);
        assert.ok(events.some(e => e.error === 'automatic-permission'));
        assert.ok(!events.some(e => e.compactionRequested));
        return;
      }
      assert.ok(events.some(e => e.mode === 'automatic-compaction' && e.compactionStatus === 'completed'), JSON.stringify({ diagnostic: 'Native completion not observed',
        modes: events.map(e => ({ mode: e.mode, error: e.error, pressure: e.pressure, compactionStatus: e.compactionStatus, decision: e.result.decision })) }));
      assert.equal(requests, forced ? 0 : 1);
      const admission = events.filter(e => e.mode === 'automatic-check' && e.compactionStatus === 'admitted');
      assert.equal(admission.length, 1);
      assert.equal(admission[0].target, forced ? 'native-host' : 'loopback-fixture');
      assert.equal(admission[0].result.decision, forced ? null : true);
      assert.equal(admission[0].trigger, forced ? 'hard-limit' : 'jev');
      if (forced) {
        assert.equal(admission[0].recipe, null);
        assert.equal(admission[0].pressure.contextTokens, 100000);
        assert.equal(admission[0].pressure.hardLimitRatio, 0.35);
      }
      const completed = events.filter(e => e.mode === 'automatic-compaction' && e.compactionStatus === 'completed');
      assert.equal(completed.length, 1);
      assert.equal(completed[0].target, 'native-host');
      const { data: context } = request(`/api/session/${sessionID}/context`);
      assert.ok(context.some(m => m.type === 'compaction' && m.status === 'completed' && m.summary.includes('Synthetic fixture complete.')));
      if (childSession) assert.ok(!request(`/api/session/${template.id}/context`).data.some(m => m.type === 'compaction'), 'Parent remains untouched');
    } finally {
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 2000);
      await closed; clearTimeout(force);
      await new Promise(resolve => judge.close(resolve));
      rmSync(dir, { recursive: true });
    }
  });

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

for (const remoteEnabled of [false, true]) {
  test(`OpenCode V2 loads the local plugin with remoteEnabled=${remoteEnabled} in an isolated server`,
    { skip: !process.env.DEFRAG_OPENCODE_BIN, timeout: 30000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'defrag-host-'));
      const root = new URL('../', import.meta.url).pathname;
      for (const name of ['config', 'data', 'cache', 'state']) mkdirSync(join(dir, name), { mode: 0o700 });
      const keyFile = join(dir, 'key');
      writeFileSync(keyFile, 'fixture-loading-key', { mode: 0o600 });
      const probe = join(dir, 'probe');
      mkdirSync(probe, { mode: 0o700 });
      writeFileSync(join(probe, 'package.json'), JSON.stringify({ type: 'module', main: './index.js' }), { mode: 0o600 });
      writeFileSync(join(probe, 'index.js'), `export default { id: 'defrag-routing-probe', async setup(ctx) {
        const tools = await ctx.tool.list();
        for (const id of ${JSON.stringify(remoteEnabled ? ['defrag_preview', 'defrag_check'] : ['defrag_preview'])}) {
          if (tools.find(t => t.id === id)?.options?.codemode !== false) throw new Error('Observer must be a direct tool');
        }
      } };`, { mode: 0o600 });
      writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json',
        plugins: [{ package: root, options: { remoteEnabled, keyFile } }, probe],
        permissions: [{ action: '*', resource: '*', effect: 'allow' }],
        warming: false, compaction: { auto: false } }), { mode: 0o600 });
      // No inherited provider credentials or real configuration/service paths.
      const env = { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: join(dir, 'config'),
        XDG_DATA_HOME: join(dir, 'data'), XDG_CACHE_HOME: join(dir, 'cache'), XDG_STATE_HOME: join(dir, 'state'), TMPDIR: dir };
      const child = spawn(process.env.DEFRAG_OPENCODE_BIN, ['serve', '--service', '--hostname', '127.0.0.1', '--port', '0'],
        { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const closed = new Promise(resolve => child.once('close', resolve));
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Isolated OpenCode startup timed out')), 10000);
          let output = '';
          const inspect = chunk => { output += chunk.toString(); if (/http:\/\/127\.0\.0\.1:\d+/.test(output)) { clearTimeout(timer); resolve(); } };
          child.stdout.on('data', inspect); child.stderr.on('data', inspect);
          child.once('error', () => { clearTimeout(timer); reject(new Error('Cannot start isolated OpenCode')); });
          child.once('exit', () => { clearTimeout(timer); reject(new Error('Isolated OpenCode exited before startup')); });
        });
        const request = (path, body) => {
          const result = spawnSync(process.env.DEFRAG_OPENCODE_BIN, ['api', body ? 'post' : 'get', path,
            ...(body ? ['--data', JSON.stringify(body)] : [])], { cwd: dir, env, encoding: 'utf8', timeout: 5000 });
          assert.equal(result.status, 0, 'isolated authenticated API command must succeed');
          return JSON.parse(result.stdout);
        };
        assert.equal(request('/api/info').pid, child.pid, 'requests must reach the test server, never the user service');
        request('/api/command');
        let plugin, routing;
        // Loading is asynchronous. Bound readiness checks; do not start a model.
        for (let attempt = 0; attempt < 20 && (!plugin || !routing); attempt++) {
          const { data, location } = request(`/api/plugin?location[directory]=${encodeURIComponent(dir)}`);
          assert.equal(location.directory, dir);
          plugin = data.find(p => p.id === 'defrag' || p.state.status === 'failed');
          routing = data.find(p => p.id === 'defrag-routing-probe' || p.state.status === 'failed');
          if (!plugin || !routing) await delay(100);
        }
        assert.ok(plugin, 'the actual host must discover the package entrypoint');
        assert.equal(plugin.state.status, 'active', 'the actual host must run plugin setup successfully');
        assert.equal(plugin.id, 'defrag');
        assert.equal(plugin.features.server, true);
        assert.equal(routing?.id, 'defrag-routing-probe');
        assert.equal(routing.state.status, 'active', 'actual host registrations must keep the observers outside Code Mode');
        const { data: session } = request('/api/session', { title: 'Local permission fixture', location: { directory: dir } });
        assert.match(session.id, /^ses/);
        const permission = request(`/api/session/${session.id}/permission`, { action: 'defrag.remote', resources: ['*'] });
        assert.equal(permission.data.effect, 'allow', 'Allow All must not become a prompt in the actual host permission service');
      } finally {
        if (child.pid && child.exitCode === null) child.kill('SIGTERM');
        const force = setTimeout(() => child.kill('SIGKILL'), 2000);
        await closed;
        clearTimeout(force);
        rmSync(dir, { recursive: true });
      }
    });
}

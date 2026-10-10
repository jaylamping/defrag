import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const failure = () => Object.assign(new Error('host-api'), { kind: 'host-api' });

// Older V2 plugin contexts lack compact/inbox/active/permission-create methods.
// Use the host's authenticated CLI, asynchronously, and bind every operation to
// this exact server process. Never read, print or forward its auth credentials.
export function createHostApi(directory, execute) {
  const command = execute ?? (async (args, signal) => {
    const { stdout } = await run('opencode', args, { cwd: directory, signal, timeout: 2000,
      maxBuffer: 1024 * 1024, encoding: 'utf8' });
    return stdout;
  });
  return { async call(method, path, body, signal) {
    try {
      signal?.throwIfAborted();
      if (!['get', 'post'].includes(method) || !/^\/api\/(?:info|session(?:\/[^?]*)?)$/.test(path)) throw failure();
      const info = JSON.parse(await command(['api', 'get', '/api/info'], signal));
      if (info.pid !== process.pid) throw failure();
      signal?.throwIfAborted();
      const output = await command(['api', method, path, ...(body ? ['--data', JSON.stringify(body)] : [])], signal);
      const value = JSON.parse(output);
      return Object.hasOwn(value, 'data') ? value.data : value;
    } catch { throw failure(); }
  } };
}

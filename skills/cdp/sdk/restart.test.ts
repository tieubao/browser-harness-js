// Regression test for the restart-leaves-the-old-daemon-running bug
// (2026-09-17): `--restart` used to free the port and report a "fresh"
// health response while the OLD repl.ts process kept running underneath (a
// hung extension/CDP socket held its event loop open past server.close(),
// and the wrapper never confirmed the old pid actually exited before
// starting a new one). Symptom in the field: three rounds of edits to a
// learning-module tool never loaded because the stale process was still the
// one serving /eval.
//
// Drives the real CLI as a subprocess against a scratch port + pidfile so
// this never touches a daemon someone else is using.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const CLI = new URL('./browser-harness-js', import.meta.url).pathname;
const PORT = String(process.env.CDP_REPL_PORT_TEST ?? 9879);

function env(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CDP_REPL_PORT: PORT,
    CDP_REPL_LOG: join(dir, 'repl.log'),
    CDP_REPL_PID_FILE: join(dir, 'repl.pid'),
  };
}

async function health(dir: string): Promise<{ pid: number }> {
  const { stdout } = await execFileAsync(CLI, ['--status'], { env: env(dir) });
  return JSON.parse(stdout);
}

// Scoped to the scratch PORT (not a bare `pgrep -f repl.ts`, which would also
// match any unrelated daemon a developer already has running on the default
// port) via lsof, which sees the real listening pid regardless of env vars.
function pidsOnPort(port: string): Promise<number[]> {
  return execFileAsync('bash', ['-c', `lsof -ti tcp:${port} -sTCP:LISTEN || true`])
    .then(({ stdout }) => stdout.split('\n').map(s => s.trim()).filter(Boolean).map(Number))
    .catch(() => []);
}

test('--restart replaces the old daemon pid; exactly one repl.ts process survives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-harness-js-restart-test-'));
  try {
    await execFileAsync(CLI, ['--start'], { env: env(dir) });
    const before = await health(dir);
    assert.ok(Number.isInteger(before.pid), 'expected --start to report a pid');

    await execFileAsync(CLI, ['--restart'], { env: env(dir) });
    const after = await health(dir);
    assert.ok(Number.isInteger(after.pid), 'expected --restart to report a pid');
    assert.notEqual(after.pid, before.pid, '--restart must not keep serving the old pid');

    assert.throws(() => process.kill(before.pid, 0), 'the old daemon pid must have exited');

    const holders = await pidsOnPort(PORT);
    assert.deepEqual(holders, [after.pid], `expected only the new pid holding the port, found ${JSON.stringify(holders)}`);
  } finally {
    await execFileAsync(CLI, ['--stop'], { env: env(dir) }).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('./browser-cdp', import.meta.url));
const expr = `document.querySelector('a[href="x"]').textContent + "it's"`;

// Fake CDP endpoint: /json lists one target; its websocket echoes the Runtime.evaluate
// expression back as the result, so the CLI's stdout shows exactly what it sent.
function fakeCdp(): Promise<http.Server> {
  const server = http.createServer((_req, res) => {
    const { port } = server.address() as { port: number };
    res.end(JSON.stringify([{ id: 'T1', type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/ws` }]));
  });
  server.on('upgrade', (req, sock) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sock.on('data', (b: Buffer) => {
      if (b[0] !== 0x81) return void sock.end();
      let len = b[1] & 127, off = 2;
      if (len === 126) { len = b.readUInt16BE(2); off = 4; }
      const mask = b.subarray(off, off + 4);
      const body = Buffer.from(b.subarray(off + 4, off + 4 + len).map((x, i) => x ^ mask[i % 4]));
      const msg = JSON.parse(body.toString());
      const out = Buffer.from(JSON.stringify({ id: msg.id, result: { result: { value: msg.params.expression } } }));
      const head = out.length < 126 ? Buffer.from([0x81, out.length]) : Buffer.from([0x81, 126, out.length >> 8, out.length & 255]);
      sock.write(Buffer.concat([head, out]));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function run(port: number, args: string[], stdin?: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', bin, ...args], { env: { ...process.env, BROWSER_CDP_PORT: String(port) } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(stdin ?? '');
  });
}

test('eval <id> - sends the stdin text, nested quotes intact', async () => {
  const server = await fakeCdp();
  try {
    const r = await run((server.address() as { port: number }).port, ['eval', 'T1', '-'], expr);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), JSON.stringify(expr, null, 1));
  } finally { server.close(); }
});

test('eval <id> <js> still sends the argv string', async () => {
  const server = await fakeCdp();
  try {
    const r = await run((server.address() as { port: number }).port, ['eval', 'T1', '1 + 1']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), JSON.stringify('1 + 1', null, 1));
  } finally { server.close(); }
});

test('eval <id> - against an unreachable port fails on connection, not argument parsing', async () => {
  const r = await run(1, ['eval', 'T1', '-'], 'x');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /fetch failed/);
});

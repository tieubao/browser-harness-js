import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('./browser-cdp', import.meta.url));
const expr = `document.querySelector('mat-option[value="a"]')`;

// Fake CDP endpoint: Runtime.evaluate answers with the queued values in order and records the
// expressions; Input.dispatchMouseEvent calls are recorded as "type x y".
function fakeCdp(values: unknown[]): Promise<{ server: http.Server; evals: string[]; mouse: string[] }> {
  const evals: string[] = [], mouse: string[] = [];
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
      let result: unknown = {};
      if (msg.method === 'Runtime.evaluate') { evals.push(msg.params.expression); result = { result: { value: values.shift() } }; }
      else mouse.push(`${msg.params.type} ${msg.params.x} ${msg.params.y}`);
      const out = Buffer.from(JSON.stringify({ id: msg.id, result }));
      const head = out.length < 126 ? Buffer.from([0x81, out.length]) : Buffer.from([0x81, 126, out.length >> 8, out.length & 255]);
      sock.write(Buffer.concat([head, out]));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, evals, mouse })));
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

test('click-el scrolls, re-reads the centre, then real-clicks it', async () => {
  const { server, evals, mouse } = await fakeCdp(['10 20', '11 22']);
  try {
    const r = await run((server.address() as { port: number }).port, ['click-el', 'T1', expr]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'clicked 11 22');
    assert.equal(evals.length, 2);
    assert.ok(evals[0].includes(expr) && evals[0].includes('scrollIntoView({block:"center"})'));
    assert.ok(evals[1].includes(expr) && !evals[1].includes('scrollIntoView'));
    assert.deepEqual(mouse, ['mouseMoved 11 22', 'mousePressed 11 22', 'mouseReleased 11 22']);
  } finally { server.close(); }
});

test('click-el <id> - reads the expression from stdin', async () => {
  const { server, evals } = await fakeCdp(['5 6', '5 6']);
  try {
    const r = await run((server.address() as { port: number }).port, ['click-el', 'T1', '-'], expr);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'clicked 5 6');
    assert.ok(evals[0].includes(expr));
  } finally { server.close(); }
});

test('click-el prints none, exits 1 and sends no mouse event when the expression returns null', async () => {
  const { server, evals, mouse } = await fakeCdp(['none']);
  try {
    const r = await run((server.address() as { port: number }).port, ['click-el', 'T1', 'null']);
    assert.equal(r.code, 1);
    assert.equal(r.stdout.trim(), 'none');
    assert.equal(evals.length, 1);
    assert.deepEqual(mouse, []);
  } finally { server.close(); }
});

test('click-el without an expression prints its usage and exits 1', async () => {
  const r = await run(1, ['click-el', 'T1']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: browser-cdp click-el <targetId>/);
});

test('unknown command usage line lists click-el', async () => {
  const r = await run(1, ['nope']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /click-el <targetId> <js\|->/);
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { idError, listLearningIds, scaffoldLearning } from './learn-scaffold.ts';

test('idError accepts [a-z0-9-]{2,40}', () => {
  assert.equal(idError('zz-test'), null);
  assert.equal(idError('ab'), null);
  assert.equal(idError('a'.repeat(40)), null);
});

test('idError refuses too short, bad chars, and too long', () => {
  assert.match(idError('a')!, /invalid id/);
  assert.match(idError('Bad_ID!')!, /invalid id/);
  assert.match(idError('a'.repeat(41))!, /invalid id/);
});

test('scaffoldLearning refuses missing --domains', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-scaffold-'));
  try {
    await assert.rejects(
      scaffoldLearning({ id: 'zz-test', domains: [], dir }),
      /--domains/,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scaffoldLearning refuses a bad id before touching disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-scaffold-'));
  try {
    await assert.rejects(
      scaffoldLearning({ id: 'Bad_ID!', domains: ['zz.example'], dir }),
      /invalid id/,
    );
    assert.equal(existsSync(join(dir, 'Bad_ID!')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scaffoldLearning refuses an id that already exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-scaffold-'));
  try {
    await scaffoldLearning({ id: 'zz-test', domains: ['zz.example'], dir });
    await assert.rejects(
      scaffoldLearning({ id: 'zz-test', domains: ['zz.example'], dir }),
      /already exists/,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scaffoldLearning writes manifest.json, notes/overview.md, tools/<id>.mjs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-scaffold-'));
  try {
    const root = await scaffoldLearning({ id: 'zz-test', domains: ['zz.example'], name: 'ZZ Test', dir });
    assert.equal(root, join(dir, 'zz-test'));
    assert.ok(existsSync(join(root, 'manifest.json')));
    assert.ok(existsSync(join(root, 'notes', 'overview.md')));
    assert.ok(existsSync(join(root, 'tools', 'zz-test.mjs')));

    const ids = await listLearningIds(dir);
    assert.deepEqual(ids, ['zz-test']);

    const manifestText = await (await import('node:fs/promises')).readFile(join(root, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.id, 'zz-test');
    assert.equal(manifest.name, 'ZZ Test');
    assert.deepEqual(manifest.domains, ['zz.example']);
    assert.equal(manifest.nodeTools.status.path, 'tools/zz-test.mjs');
    assert.equal(manifest.nodeTools.status.callable, 'status');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

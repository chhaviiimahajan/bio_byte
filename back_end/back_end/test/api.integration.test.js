'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

let child;
let baseUrl;
let tempDir;
let port;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close(err => err ? reject(err) : resolve(value));
    });
  });
}
async function startServer() {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: tempDir, FRONTEND_ORIGIN: '*' },
    stdio: 'ignore'
  });
  baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode != null) throw new Error(`SafeUPI server exited with ${child.exitCode}`);
    try {
      const r = await fetch(baseUrl + '/api/health');
      if (r.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('SafeUPI server did not become ready.');
}
async function stopServer() {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 6000))
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}
async function post(pathname, payload) {
  const response = await fetch(baseUrl + pathname, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  return { status: response.status, body: await response.json() };
}

test.before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safeupi-test-'));
  port = await freePort();
  await startServer();
});
test.after(async () => {
  await stopServer();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test('API persists checks, handles idempotency, accepts reviewer labels, and builds mule-pattern evidence', async () => {
  const payload = {
    eventId: 'integration-persist-001', amount: 700, paymentType: 'upi',
    recipientName: 'Synthetic Grocery', recipientId: 'grocery@synthetic'
  };
  const first = await post('/api/check', payload);
  assert.equal(first.status, 201);
  const second = await post('/api/check', payload);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(first.body.transaction.id, second.body.transaction.id);

  const label = await post(`/api/transactions/${first.body.transaction.id}/label`, { label: 'legitimate' });
  assert.equal(label.status, 200);

  const now = Date.now();
  const ts = minutes => new Date(now - minutes * 60000).toISOString();
  const transactions = [
    { eventId: 'graph-in-1', timestamp: ts(10), amount: 1000, paymentType: 'upi', recipientName: 'Hub', recipientId: 'hub-ref', senderRef: 'sender-1' },
    { eventId: 'graph-in-2', timestamp: ts(9), amount: 1000, paymentType: 'upi', recipientName: 'Hub', recipientId: 'hub-ref', senderRef: 'sender-2' },
    { eventId: 'graph-in-3', timestamp: ts(8), amount: 1000, paymentType: 'upi', recipientName: 'Hub', recipientId: 'hub-ref', senderRef: 'sender-3' },
    { eventId: 'graph-out-1', timestamp: ts(6), amount: 800, paymentType: 'upi', recipientName: 'Out A', recipientId: 'out-a', senderRef: 'hub-ref' },
    { eventId: 'graph-out-2', timestamp: ts(5), amount: 800, paymentType: 'upi', recipientName: 'Out B', recipientId: 'out-b', senderRef: 'hub-ref' },
    { eventId: 'graph-out-3', timestamp: ts(4), amount: 900, paymentType: 'upi', recipientName: 'Out C', recipientId: 'out-c', senderRef: 'hub-ref' }
  ];
  const stream = await post('/api/stream/transactions', { transactions });
  assert.equal(stream.status, 202);
  assert.equal(stream.body.accepted, 6);
  const last = stream.body.results[5].transaction;
  const ids = last.result.signals.map(s => s.id);
  assert.ok(ids.includes('graphSharedReceiver'));
  assert.ok(ids.includes('graphRapidPassThrough'));
  assert.ok(ids.includes('graphFanOut'));

  const network = await fetch(baseUrl + '/api/network').then(r => r.json());
  assert.ok(network.nodes.length >= 11);
  assert.ok(network.edges.length >= 16);

  const stored = await fetch(baseUrl + '/api/transactions').then(r => r.json());
  assert.equal(stored.count, 7); // 1 direct check + 6 streamed events; duplicate did not create a row
  assert.equal(stored.transactions.find(t => t.id === first.body.transaction.id).reviewLabel, 'legitimate');
});

test('SQLite history remains available after an API restart', async () => {
  await stopServer();
  await startServer();
  const response = await fetch(baseUrl + '/api/transactions').then(r => r.json());
  assert.equal(response.count, 7);
});

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { db, DB_PATH, getConfig, setConfig, nowIso } = require('./src/db');
const { processPayment, publicRow } = require('./src/service');
const { snapshot } = require('./src/graph');
const { CATALOG, GROUPS, PROFILE } = require('./src/scoring');
const { getMetrics, getDrift, rebaseline, getCalibration, applyCalibration, getFairness } = require('./src/metrics');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 256 * 1024;
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60 * 1000;
const allowedOrigins = (process.env.FRONTEND_ORIGIN || '*').split(',').map(x => x.trim());
const rateBuckets = new Map();
const sseClients = new Set();

function corsHeaders(req) {
  const origin = req.headers.origin || '';
  const allow = allowedOrigins.includes('*') ? '*' : (allowedOrigins.includes(origin) ? origin : allowedOrigins[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
    'Access-Control-Max-Age': '600'
  };
}
function sendJson(res, status, data, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(data));
}
function sendError(res, status, error, details) {
  sendJson(res, status, { ok: false, error, ...(details ? { details } : {}) });
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > MAX_BODY) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function limited(req) {
  const key = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let item = rateBuckets.get(key);
  if (!item || now - item.start >= RATE_WINDOW_MS) item = { start: now, count: 0 };
  item.count++;
  rateBuckets.set(key, item);
  return item.count > RATE_LIMIT;
}
function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of [...sseClients]) {
    try { client.write(frame); } catch { sseClients.delete(client); }
  }
}
function transactionView(rows) { return rows.map(publicRow); }
function dashboard() {
  const rows = db.prepare('SELECT t.*,l.label AS review_label FROM transactions t LEFT JOIN labels l ON l.transaction_id=t.id ORDER BY t.created_at DESC').all();
  const view = transactionView(rows);
  const totalValue = view.reduce((s, t) => s + t.amount, 0);
  const by = { High: 0, Review: 0, Low: 0 };
  for (const t of view) by[t.result.category] = (by[t.result.category] || 0) + 1;
  const metrics = getMetrics(db);
  const falseAlertRate = metrics.metrics?.falsePositiveRate ?? null;
  return {
    totalTransactions: view.length,
    totalAmount: Math.round(totalValue * 100) / 100,
    highRisk: by.High, review: by.Review, lowRisk: by.Low,
    falseAlertRate,
    labelledTransactions: metrics.labelledTransactions,
    recentTransactions: view.slice(0, 10),
    profile: { name: 'Ananya Rao (fictional)', ...PROFILE }
  };
}
function listAlerts(url) {
  let category = url.searchParams.get('category');
  if (category === 'all') category = null;
  const status = String(url.searchParams.get('status') || 'OPEN').toUpperCase();
  const rows = db.prepare(`SELECT a.*,t.recipient_name,t.amount,t.payment_type,t.result_json,t.created_at AS tx_created_at
    FROM alerts a LEFT JOIN transactions t ON t.id=a.transaction_id
    WHERE (?='ALL' OR a.status=?) AND (? IS NULL OR a.category=?)
    ORDER BY a.created_at DESC LIMIT 200`)
    .all(status, status, category, category);
  return rows.map(a => ({
    id: a.id, transactionId: a.transaction_id, type: a.alert_type,
    category: a.category, score: a.score, status: a.status,
    createdAt: a.created_at, updatedAt: a.updated_at,
    recipientName: a.recipient_name || 'System drift monitor',
    amount: a.amount == null ? null : Number(a.amount),
    paymentType: a.payment_type || null,
    result: a.result_json ? JSON.parse(a.result_json) : null,
    details: JSON.parse(a.details_json || '{}')
  }));
}
function staticFile(req, res, pathname, cors) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { return sendError(res, 400, 'Invalid URL path.'); }
  const relative = decoded === '/' ? '/index.html' : decoded;
  const file = path.resolve(PUBLIC_DIR, `.${relative}`);
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== path.join(PUBLIC_DIR, 'index.html')) return sendError(res, 403, 'Forbidden.');
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return sendError(res, 404, 'File not found.');
    const ext = path.extname(file).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
      '.ico': 'image/x-icon', '.woff2': 'font/woff2'
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600', ...cors });
    fs.createReadStream(file).pipe(res);
  });
}

async function handle(req, res) {
  const cors = corsHeaders(req);
  for (const [key, value] of Object.entries(cors)) res.setHeader(key, value);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/$/, '') || '/';
  if (!pathname.startsWith('/api/')) return staticFile(req, res, pathname, cors);
  if (limited(req) && pathname !== '/api/health') return sendError(res, 429, 'Rate limit exceeded. Try again shortly.');

  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'SafeUPI Check API', storage: 'SQLite', database: path.basename(DB_PATH), uptimeSeconds: Math.round(process.uptime()) }, cors);
  }
  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...cors });
    res.write(`event: connected\ndata: ${JSON.stringify({ connected: true, time: nowIso() })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (req.method === 'POST' && (pathname === '/api/check' || pathname === '/api/stream/transactions')) {
    const body = await readJson(req);
    if (pathname === '/api/check') {
      if (req.headers['idempotency-key'] && !body.eventId) body.eventId = req.headers['idempotency-key'];
      const result = processPayment(db, body, 'ui');
      if (!result.ok) return sendJson(res, result.status || 400, { ok: false, error: 'Transaction validation failed.', details: result.errors }, cors);
      broadcast('transaction', result.transaction);
      if (result.transaction.result.category !== 'Low') broadcast('alert', { transactionId: result.transaction.id, category: result.transaction.result.category });
      const drift = getDrift(db);
      if (drift.status === 'watch' || drift.status === 'drift') broadcast('drift', drift);
      return sendJson(res, result.duplicate ? 200 : 201, { ok: true, duplicate: result.duplicate, transaction: result.transaction,
        notice: 'Demo estimate only. It is not proof of fraud and does not block a payment.' }, cors);
    }
    const events = Array.isArray(body.transactions) ? body.transactions : null;
    if (!events || events.length === 0 || events.length > 100) return sendError(res, 400, 'Send a transactions array containing 1 to 100 events.');
    const results = [];
    const created = [];
    for (const event of events) {
      const result = processPayment(db, event, 'stream');
      results.push(result.ok ? { ok: true, duplicate: result.duplicate, transaction: result.transaction } : { ok: false, errors: result.errors });
      if (result.ok && !result.duplicate) created.push(result.transaction);
    }
    const accepted = results.filter(r => r.ok).length;
    const drift = getDrift(db);
    if (created.length) broadcast('batch', { count: created.length, flagged: created.filter(t => t.result.category !== 'Low').length });
    if (created.some(t => t.result.category !== 'Low')) broadcast('alert', { count: created.filter(t => t.result.category !== 'Low').length });
    if (drift.status === 'watch' || drift.status === 'drift') broadcast('drift', drift);
    return sendJson(res, accepted === events.length ? 202 : 207, { ok: accepted === events.length, accepted, rejected: events.length - accepted, results, drift }, cors);
  }
  if (req.method === 'GET' && pathname === '/api/dashboard') return sendJson(res, 200, dashboard(), cors);
  if (req.method === 'GET' && pathname === '/api/transactions') {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 100)));
    const rows = db.prepare('SELECT t.*,l.label AS review_label FROM transactions t LEFT JOIN labels l ON l.transaction_id=t.id ORDER BY t.created_at DESC LIMIT ?').all(limit);
    return sendJson(res, 200, { count: rows.length, transactions: transactionView(rows) }, cors);
  }
  if (req.method === 'GET' && pathname === '/api/alerts') {
    const alerts = listAlerts(url);
    return sendJson(res, 200, { count: alerts.length, alerts }, cors);
  }
  if (req.method === 'GET' && pathname === '/api/network') return sendJson(res, 200, snapshot(db), cors);
  if (req.method === 'GET' && pathname === '/api/explainability') {
    return sendJson(res, 200, {
      catalogue: CATALOG, groups: GROUPS,
      thresholds: { review: getConfig('reviewThreshold', 35), high: getConfig('highThreshold', 70) },
      principles: [
        'Age, caste, religion, gender, disability, race and ethnicity are not scoring inputs.',
        'Context signals are weak and cannot produce High by themselves.',
        'High requires at least two independent signal groups beyond context.',
        'QR payments are normal; only a clear displayed-name / actual-recipient mismatch is counted.',
        'Graph patterns are heuristics for human review, not proof of a mule account.',
        'No OTP value, PIN, password, or banking credential is accepted or stored.',
        'Nothing is automatically blocked by this demo.'
      ]
    }, cors);
  }
  if (req.method === 'GET' && pathname === '/api/metrics') return sendJson(res, 200, getMetrics(db), cors);
  if (req.method === 'GET' && pathname === '/api/drift') return sendJson(res, 200, getDrift(db), cors);
  if (req.method === 'GET' && pathname === '/api/calibration') return sendJson(res, 200, getCalibration(db), cors);
  if (req.method === 'GET' && pathname === '/api/fairness') return sendJson(res, 200, getFairness(db), cors);

  if (req.method === 'POST' && pathname === '/api/drift/rebaseline') {
    const result = rebaseline(db);
    return sendJson(res, result.status || (result.ok ? 201 : 400), result, cors);
  }
  if (req.method === 'POST' && pathname === '/api/calibration/apply') {
    const result = applyCalibration(db);
    return sendJson(res, result.status || (result.ok ? 200 : 409), result, cors);
  }

  if (req.method === 'POST' && pathname === '/api/feedback/labels') {
    const body = await readJson(req);
    const labels = Array.isArray(body.labels) ? body.labels : null;
    if (!labels || labels.length === 0 || labels.length > 100) return sendError(res, 400, 'Send a labels array containing 1 to 100 reviewer labels.');
    const prepared = [];
    for (const item of labels) {
      const value = item && item.label === 'fraud' ? 1 : item && item.label === 'legitimate' ? 0 : null;
      const transactionId = item && String(item.transactionId || '').slice(0, 80);
      if (value == null || !transactionId || !db.prepare('SELECT id FROM transactions WHERE id=?').get(transactionId))
        return sendError(res, 400, 'Each label needs an existing transactionId and label fraud or legitimate.');
      prepared.push({ transactionId, value, notes: String(item.notes || '').slice(0, 300) });
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const statement = db.prepare(`INSERT INTO labels(transaction_id,label,labeled_at,notes,reviewer_ref) VALUES(?,?,?,?,?)
        ON CONFLICT(transaction_id) DO UPDATE SET label=excluded.label,labeled_at=excluded.labeled_at,notes=excluded.notes,reviewer_ref=excluded.reviewer_ref`);
      const labeledAt = nowIso();
      for (const item of prepared) statement.run(item.transactionId, item.value, labeledAt, item.notes, 'synthetic-reviewer');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    broadcast('labels', { count: prepared.length });
    return sendJson(res, 200, { ok: true, count: prepared.length, message: 'Batch reviewer labels recorded.' }, cors);
  }

  let match = pathname.match(/^\/api\/transactions\/([^/]+)\/label$/);
  if (req.method === 'POST' && match) {
    const id = decodeURIComponent(match[1]);
    const body = await readJson(req);
    const label = body.label === 'fraud' ? 1 : body.label === 'legitimate' ? 0 : null;
    if (label == null) return sendError(res, 400, "label must be 'fraud' or 'legitimate'.");
    const exists = db.prepare('SELECT id FROM transactions WHERE id=?').get(id);
    if (!exists) return sendError(res, 404, 'Transaction not found.');
    db.prepare(`INSERT INTO labels(transaction_id,label,labeled_at,notes,reviewer_ref) VALUES(?,?,?,?,?)
      ON CONFLICT(transaction_id) DO UPDATE SET label=excluded.label,labeled_at=excluded.labeled_at,notes=excluded.notes,reviewer_ref=excluded.reviewer_ref`)
      .run(id, label, nowIso(), String(body.notes || '').slice(0, 300), String(body.reviewerRef || 'local-reviewer').slice(0, 60));
    broadcast('label', { transactionId: id, label: body.label });
    return sendJson(res, 200, { ok: true, transactionId: id, label: body.label, message: 'Label recorded as reviewer feedback, not as an automatic truth source.' }, cors);
  }
  match = pathname.match(/^\/api\/alerts\/([^/]+)\/status$/);
  if (req.method === 'PATCH' && match) {
    const id = decodeURIComponent(match[1]);
    const body = await readJson(req);
    const status = ['OPEN', 'ACKNOWLEDGED', 'CLOSED'].includes(body.status) ? body.status : null;
    if (!status) return sendError(res, 400, 'status must be OPEN, ACKNOWLEDGED, or CLOSED.');
    const result = db.prepare('UPDATE alerts SET status=?,updated_at=? WHERE id=?').run(status, nowIso(), id);
    if (!result.changes) return sendError(res, 404, 'Alert not found.');
    broadcast('alert-status', { id, status });
    return sendJson(res, 200, { ok: true, id, status }, cors);
  }

  return sendError(res, 404, 'API endpoint not found.');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    console.error(`[${new Date().toISOString()}] ${error.message}`);
    if (!res.headersSent) sendError(res, error.status || 500, error.status ? error.message : 'Internal server error.');
    else res.end();
  });
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
const heartbeat = setInterval(() => {
  for (const client of sseClients) {
    try { client.write(': keep-alive\n\n'); } catch { sseClients.delete(client); }
  }
}, 25000);

server.listen(PORT, HOST, () => {
  console.log(`SafeUPI Check running at http://${HOST}:${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
  console.log('Demo mode: synthetic/authorized data only; no payments are processed or blocked.');
});

function shutdown() {
  clearInterval(heartbeat);
  for (const client of sseClients) { try { client.end(); } catch {} }
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

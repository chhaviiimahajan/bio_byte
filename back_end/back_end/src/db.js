'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'safeupi.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    amount REAL NOT NULL CHECK(amount > 0),
    payment_type TEXT NOT NULL,
    recipient_name TEXT NOT NULL,
    recipient_ref TEXT NOT NULL,
    sender_ref TEXT NOT NULL,
    flags_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    audit_json TEXT NOT NULL DEFAULT '{}',
    source TEXT NOT NULL DEFAULT 'ui'
  );
  CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_transactions_occurred ON transactions(occurred_at DESC);
  CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(json_extract(result_json, '$.category'));

  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    transaction_id TEXT UNIQUE,
    alert_type TEXT NOT NULL DEFAULT 'risk',
    category TEXT NOT NULL,
    score INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status, created_at DESC);

  CREATE TABLE IF NOT EXISTS labels (
    transaction_id TEXT PRIMARY KEY,
    label INTEGER NOT NULL CHECK(label IN (0,1)),
    labeled_at TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    reviewer_ref TEXT NOT NULL DEFAULT 'local-reviewer',
    FOREIGN KEY(transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS graph_nodes (
    ref TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    role TEXT NOT NULL,
    description TEXT NOT NULL,
    x REAL,
    y REAL,
    demo_seed INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS graph_edges (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    occurred_at TEXT NOT NULL,
    sender_ref TEXT NOT NULL,
    recipient_ref TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    demo_seed INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_graph_sender_time ON graph_edges(sender_ref, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_graph_recipient_time ON graph_edges(recipient_ref, occurred_at);

  CREATE TABLE IF NOT EXISTS drift_events (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    status TEXT NOT NULL,
    details_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS drift_baselines (
    metric TEXT PRIMARY KEY,
    baseline_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

function nowIso() { return new Date().toISOString(); }
function setDefault(key, value) {
  db.prepare(`INSERT OR IGNORE INTO system_config(key,value,updated_at) VALUES(?,?,?)`)
    .run(key, JSON.stringify(value), nowIso());
}
setDefault('reviewThreshold', 35);
setDefault('highThreshold', 70);
setDefault('maxFalsePositiveRate', 0.10);

// Fixed, fictional graph used only to make the Network view demonstrable on first run.
// It is separate from the transaction ledger and excluded from dashboard totals.
function seedDemoNetwork() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM graph_edges WHERE demo_seed=1').get().n;
  if (count > 0) return;
  const nodes = [
    ['seed:s1', 'Sender A', 'source', 'Fictional sender with one first-time payment to M-01.', 90, 70],
    ['seed:s2', 'Sender B', 'source', 'Fictional sender with one first-time payment to M-01.', 90, 200],
    ['seed:s3', 'Sender C', 'source', 'Fictional sender paying M-01 and an ordinary local grocer.', 90, 330],
    ['seed:h1', 'M-01', 'hub', 'Receives payments from three senders and rapidly forwards most of the value. Human review is warranted; this is not proof of wrongdoing.', 320, 200],
    ['seed:p1', 'M-02', 'relay', 'Receives funds from M-01 and forwards them to two recipients.', 520, 105],
    ['seed:p2', 'M-03', 'relay', 'Receives a smaller share from M-01 and forwards it to two recipients.', 520, 290],
    ['seed:o1', 'R-1', 'out', 'Fictional end recipient. A link does not establish wrongdoing.', 720, 50],
    ['seed:o2', 'R-2', 'out', 'Fictional end recipient. A link does not establish wrongdoing.', 720, 150],
    ['seed:o3', 'R-3', 'out', 'Fictional end recipient. A link does not establish wrongdoing.', 720, 250],
    ['seed:o4', 'R-4', 'out', 'Fictional end recipient. A link does not establish wrongdoing.', 720, 350],
    ['seed:g1', 'Grocer', 'normal', 'Ordinary established fictional merchant relationship, shown for contrast.', 320, 385]
  ];
  const insertNode = db.prepare(`INSERT INTO graph_nodes(ref,label,role,description,x,y,demo_seed) VALUES(?,?,?,?,?,?,1)`);
  for (const n of nodes) insertNode.run(...n);

  const now = Date.now();
  const mins = (m) => new Date(now - m * 60000).toISOString();
  const days = (d) => new Date(now - d * 86400000).toISOString();
  const edges = [
    ['seed:e1','seed:s1','seed:h1',9500,mins(25),'New link'],
    ['seed:e2','seed:s2','seed:h1',12000,mins(24),'New link'],
    ['seed:e3','seed:s3','seed:h1',7800,mins(23),'New link'],
    ['seed:e4','seed:h1','seed:p1',21000,mins(20),'Forwarded in ~4 min'],
    ['seed:e5','seed:h1','seed:p2',8300,mins(18),'Forwarded in ~6 min'],
    ['seed:e6','seed:p1','seed:o1',10500,mins(17),'Fan-out, ~3 min'],
    ['seed:e7','seed:p1','seed:o2',10200,mins(17),'Fan-out, ~3 min'],
    ['seed:e8','seed:p2','seed:o3',4100,mins(13),'New link'],
    ['seed:e9','seed:p2','seed:o4',4000,mins(13),'New link'],
    ['seed:e10','seed:s3','seed:g1',640,days(7),'Established, ordinary link']
  ];
  const insertEdge = db.prepare(`INSERT INTO graph_edges(id,event_id,occurred_at,sender_ref,recipient_ref,amount,note,demo_seed) VALUES(?,?,?,?,?,?,?,1)`);
  for (const e of edges) {
    const [id, from, to, amount, time, note] = e;
    insertEdge.run(id, id, time, from, to, amount, note);
  }
}
seedDemoNetwork();

function getConfig(key, fallback) {
  const row = db.prepare('SELECT value FROM system_config WHERE key=?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}
function setConfig(key, value) {
  db.prepare(`INSERT INTO system_config(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(key, JSON.stringify(value), nowIso());
}

module.exports = { db, DB_PATH, getConfig, setConfig, nowIso };

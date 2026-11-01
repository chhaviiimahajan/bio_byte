'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { scoreTransaction } = require('./scoring');
const { graphSignalsForTransaction, insertGraphEdge } = require('./graph');
const { getConfig, nowIso } = require('./db');

const ALLOWED_TYPES = new Set(['upi', 'collect', 'qr']);
const ALLOWED_IMPERSONATION = new Set(['none', 'bank', 'government', 'merchant', 'family', 'support']);
const BOOL_FIELDS = [
  'firstPayment', 'reported', 'deviceChanged', 'unusualLocation', 'otpEvent',
  'unusualTiming', 'unusualFrequency', 'unusualFlow', 'rapidTransfers',
  'urgency', 'unexpectedCollect'
];
const AUDIT_ALLOWED = {
  regionType: new Set(['Urban', 'Semi-urban', 'Rural', 'Other']),
  deviceTier: new Set(['Premium phone', 'Mid-range phone', 'Entry-level phone', 'Other']),
  appLanguage: new Set(['English', 'Hindi', 'Tamil', 'Bengali', 'Other']),
  upiExperience: new Set(['Established user', 'New to UPI', 'Other'])
};
const FORBIDDEN_KEYS = new Set(['otp', 'otpcode', 'otpvalue', 'otpsecret', 'pin', 'pinvalue', 'password', 'passwordhash', 'passphrase', 'passcode', 'bankingcredential', 'cvv']);

function hashRef(value) {
  return 'acct_' + createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}
function text(value, max = 120) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function validatePayment(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['Body must be a JSON object.'];
  for (const key of Object.keys(body)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
    if (FORBIDDEN_KEYS.has(normalized)) errors.push(`Field '${key}' is not accepted. Never submit OTPs, PINs, passwords, or banking credentials.`);
    if (['age', 'caste', 'religion', 'gender', 'race', 'ethnicity', 'disability'].includes(normalized))
      errors.push(`Field '${key}' is not a permitted scoring input.`);
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) errors.push('amount must be a positive number up to ₹1 crore.');
  if (!ALLOWED_TYPES.has(body.paymentType)) errors.push('paymentType must be upi, collect, or qr.');
  if (!text(body.recipientName, 100)) errors.push('recipientName is required (maximum 100 characters).');
  if (body.impersonation != null && !ALLOWED_IMPERSONATION.has(body.impersonation)) errors.push('impersonation has an unsupported value.');
  if (body.timestamp && Number.isNaN(Date.parse(body.timestamp))) errors.push('timestamp must be a valid ISO date/time.');
  return errors;
}
function publicRow(row) {
  const result = JSON.parse(row.result_json || '{}');
  const flags = JSON.parse(row.flags_json || '{}');
  return {
    id: row.id, eventId: row.event_id,
    when: new Date(row.created_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'medium' }),
    createdAt: row.created_at, occurredAt: row.occurred_at,
    amount: Number(row.amount), paymentType: row.payment_type,
    recipientName: row.recipient_name, recipientId: '',
    result, flags, source: row.source,
    reviewLabel: row.review_label === 1 ? 'fraud' : row.review_label === 0 ? 'legitimate' : null
  };
}

function processPayment(db, body, source = 'ui') {
  const errors = validatePayment(body);
  if (errors.length) return { ok: false, status: 400, errors };
  const eventId = text(body.eventId || body.idempotencyKey, 100) || randomUUID();
  const duplicate = db.prepare('SELECT * FROM transactions WHERE event_id=?').get(eventId);
  if (duplicate) return { ok: true, duplicate: true, transaction: publicRow(duplicate) };

  const id = randomUUID();
  const createdAt = nowIso();
  const occurredAt = body.timestamp ? new Date(body.timestamp).toISOString() : createdAt;
  const amount = Number(body.amount);
  const paymentType = body.paymentType;
  const recipientName = text(body.recipientName, 100);
  const recipientIdInput = text(body.recipientId, 120);
  // Only one-way hashes are persisted in the network graph. Raw UPI IDs/account refs are not stored.
  const senderRef = hashRef(text(body.senderRef || body.senderAccountId, 100) || 'demo-sender-001');
  const recipientRef = hashRef(recipientIdInput || recipientName.toLocaleLowerCase('en'));
  const flags = {};
  for (const field of BOOL_FIELDS) flags[field] = body[field] === true;
  flags.impersonation = ALLOWED_IMPERSONATION.has(body.impersonation) ? body.impersonation : 'none';
  flags.qrDisplayed = text(body.qrDisplayed, 100);
  flags.qrActual = text(body.qrActual, 100);
  const normalized = {
    amount, paymentType, recipientName,
    firstPayment: flags.firstPayment, reported: flags.reported,
    deviceChanged: flags.deviceChanged, unusualLocation: flags.unusualLocation,
    otpEvent: flags.otpEvent, unusualTiming: flags.unusualTiming,
    unusualFrequency: flags.unusualFrequency, unusualFlow: flags.unusualFlow,
    rapidTransfers: flags.rapidTransfers, urgency: flags.urgency,
    unexpectedCollect: flags.unexpectedCollect,
    impersonation: ALLOWED_IMPERSONATION.has(body.impersonation) ? body.impersonation : 'none',
    qrDisplayed: text(body.qrDisplayed, 100), qrActual: text(body.qrActual, 100)
  };
  const audit = {};
  if (body.auditDimensions && typeof body.auditDimensions === 'object' && !Array.isArray(body.auditDimensions)) {
    for (const [key, allowed] of Object.entries(AUDIT_ALLOWED)) {
      const value = body.auditDimensions[key];
      if (typeof value === 'string' && allowed.has(value)) audit[key] = value;
    }
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO transactions
      (id,event_id,created_at,occurred_at,amount,payment_type,recipient_name,recipient_ref,sender_ref,flags_json,result_json,audit_json,source)
      VALUES(?,?,?,?,?,?,?,?,?,?, '{}',?,?)`)
      .run(id, eventId, createdAt, occurredAt, amount, paymentType, recipientName, recipientRef,
        senderRef, JSON.stringify(flags), JSON.stringify(audit), source);

    insertGraphEdge(db, { eventId, occurredAt, senderRef, recipientRef, amount, note: source === 'stream' ? 'Stream-ingested payment' : 'Frontend payment check' });
    const graph = graphSignalsForTransaction(db, senderRef, recipientRef);
    const thresholds = {
      reviewThreshold: getConfig('reviewThreshold', 35),
      highThreshold: getConfig('highThreshold', 70)
    };
    const result = scoreTransaction(normalized, graph.signals, thresholds);
    const enrichedResult = {
      ...result,
      graphEvidence: { sender: graph.sender, recipient: graph.recipient },
      caveat: 'Risk score and graph signals are estimates for human review, not proof of fraud.'
    };
    db.prepare('UPDATE transactions SET result_json=? WHERE id=?').run(JSON.stringify(enrichedResult), id);

    if (result.category !== 'Low') {
      db.prepare(`INSERT OR IGNORE INTO alerts(id,transaction_id,alert_type,category,score,status,created_at,updated_at,details_json)
        VALUES(?,?,'risk',?,?, 'OPEN',?,?,?)`)
        .run(randomUUID(), id, result.category, result.score, createdAt, createdAt,
          JSON.stringify({ explanation: result.explanation, signalCount: result.signals.length }));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    if (String(error.message).includes('UNIQUE constraint failed: transactions.event_id')) {
      const old = db.prepare('SELECT * FROM transactions WHERE event_id=?').get(eventId);
      return { ok: true, duplicate: true, transaction: publicRow(old) };
    }
    throw error;
  }

  const row = db.prepare('SELECT * FROM transactions WHERE id=?').get(id);
  return { ok: true, duplicate: false, transaction: publicRow(row) };
}

module.exports = { processPayment, validatePayment, publicRow, hashRef, AUDIT_ALLOWED };

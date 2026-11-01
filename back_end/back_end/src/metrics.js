'use strict';

const { randomUUID } = require('node:crypto');
function nowIso() { return new Date().toISOString(); }
function readConfig(db, key, fallback) {
  const row = db.prepare('SELECT value FROM system_config WHERE key=?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}
function writeConfig(db, key, value) {
  db.prepare(`INSERT INTO system_config(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .run(key, JSON.stringify(value), nowIso());
}

function transactionRows(db, limit = 1000) {
  return db.prepare(`SELECT t.id,t.created_at,t.result_json,l.label,l.labeled_at
    FROM transactions t LEFT JOIN labels l ON l.transaction_id=t.id
    ORDER BY t.occurred_at DESC LIMIT ?`).all(limit).map(r => {
      const result = JSON.parse(r.result_json || '{}');
      return { id: r.id, createdAt: r.created_at, score: Number(result.score || 0), category: result.category || 'Low', label: r.label == null ? null : Number(r.label) };
    });
}
function confusion(rows, threshold) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const row of rows) {
    if (row.label == null) continue;
    const predicted = row.score >= threshold;
    if (predicted && row.label === 1) tp++;
    else if (predicted && row.label === 0) fp++;
    else if (!predicted && row.label === 0) tn++;
    else fn++;
  }
  const div = (a, b) => b > 0 ? a / b : null;
  const precision = div(tp, tp + fp), recall = div(tp, tp + fn), specificity = div(tn, tn + fp);
  const f1 = precision != null && recall != null && precision + recall > 0 ? 2 * precision * recall / (precision + recall) : null;
  const f2 = precision != null && recall != null && 4 * precision + recall > 0 ? 5 * precision * recall / (4 * precision + recall) : null;
  return {
    support: tp + fp + tn + fn, positives: tp + fn, negatives: tn + fp,
    tp, fp, tn, fn, precision, recall, specificity,
    falsePositiveRate: specificity == null ? null : 1 - specificity,
    f1, f2
  };
}
function averagePrecision(rows) {
  const labelled = rows.filter(r => r.label != null).sort((a, b) => b.score - a.score);
  const positives = labelled.filter(r => r.label === 1).length;
  if (!positives) return null;
  let tp = 0, fp = 0, previousRecall = 0, ap = 0;
  for (const row of labelled) {
    if (row.label === 1) tp++; else fp++;
    const recall = tp / positives;
    const precision = tp / (tp + fp);
    ap += (recall - previousRecall) * precision;
    previousRecall = recall;
  }
  return ap;
}
function getMetrics(db) {
  const rows = transactionRows(db);
  const labelled = rows.filter(r => r.label != null);
  const threshold = readConfig(db, 'reviewThreshold', 35);
  const stats = confusion(labelled, threshold);
  const supported = stats.positives >= 3 && stats.negatives >= 10;
  return {
    labelledTransactions: labelled.length,
    unlabelledTransactions: rows.length - labelled.length,
    currentReviewThreshold: threshold,
    classDistribution: { fraud: stats.positives, legitimate: stats.negatives },
    metrics: supported ? { ...stats, prAuc: averagePrecision(labelled) } : null,
    status: supported ? 'supported' : 'insufficient_labelled_data',
    note: supported
      ? 'Metrics use reviewer-confirmed labels only. PR-AUC is reported because it is more informative than accuracy under class imbalance.'
      : 'Collect more independently reviewed labels before interpreting precision/recall. Minimum reporting support: 3 positive and 10 negative labels.'
  };
}
function bucketDistribution(rows) {
  const buckets = [0, 0, 0];
  for (const r of rows) {
    if (r.score < 35) buckets[0]++;
    else if (r.score < 70) buckets[1]++;
    else buckets[2]++;
  }
  const total = Math.max(1, rows.length);
  return buckets.map(n => n / total);
}
function psi(expected, actual) {
  const eps = 0.005;
  return expected.reduce((sum, e, i) => {
    const a = actual[i];
    const ee = Math.max(e, eps), aa = Math.max(a, eps);
    return sum + (aa - ee) * Math.log(aa / ee);
  }, 0);
}
function getDrift(db) {
  const rows = transactionRows(db, 1000);
  if (rows.length < 60) return {
    status: 'insufficient_data', psi: null, recentWindow: Math.min(50, rows.length),
    baselineWindow: 0, note: 'Score-distribution drift monitoring starts after at least 60 stored transactions (50 recent plus 10 baseline).'
  };
  const recent = rows.slice(0, 50);
  const baselineConfig = db.prepare('SELECT baseline_json,updated_at FROM drift_baselines WHERE metric=?').get('risk_score_distribution');
  const baselineRows = rows.slice(50, 250);
  const expected = baselineConfig ? JSON.parse(baselineConfig.baseline_json) : bucketDistribution(baselineRows);
  const actual = bucketDistribution(recent);
  const value = psi(expected, actual);
  const status = value >= 0.25 ? 'drift' : value >= 0.10 ? 'watch' : 'stable';
  const previous = db.prepare(`SELECT status FROM drift_events WHERE metric='risk_score_distribution' ORDER BY created_at DESC LIMIT 1`).get();
  if ((status === 'watch' || status === 'drift') && previous?.status !== status) {
    const createdAt = nowIso();
    db.prepare(`INSERT INTO drift_events(id,created_at,metric,value,status,details_json) VALUES(?,?,?,?,?,?)`)
      .run(randomUUID(), createdAt, 'risk_score_distribution', value, status,
        JSON.stringify({ expected, actual, recentWindow: 50, baselineWindow: baselineConfig ? 'operator baseline' : baselineRows.length }));
    const exists = db.prepare(`SELECT 1 AS yes FROM alerts WHERE alert_type='drift' AND category=? AND status='OPEN' LIMIT 1`).get(status.toUpperCase());
    if (!exists) db.prepare(`INSERT INTO alerts(id,transaction_id,alert_type,category,score,status,created_at,updated_at,details_json)
      VALUES(?,NULL,'drift',?,?, 'OPEN',?,?,?)`)
      .run(randomUUID(), status.toUpperCase(), Math.min(100, Math.round(value * 100)), createdAt, createdAt,
        JSON.stringify({ expected, actual, metric: 'Population Stability Index' }));
  }
  return {
    status, psi: Number(value.toFixed(4)), recentWindow: recent.length,
    baselineWindow: baselineConfig ? 'operator baseline' : baselineRows.length,
    expected, actual,
    note: 'This monitors shifts in score-band distribution (not concept drift or fraud prevalence). It does not automatically change thresholds or block payments.'
  };
}
function rebaseline(db) {
  const rows = transactionRows(db, 1000);
  if (rows.length < 50) return { ok: false, status: 400, error: 'At least 50 transactions are required to create a drift baseline.' };
  const distribution = bucketDistribution(rows.slice(0, 50));
  db.prepare(`INSERT INTO drift_baselines(metric,baseline_json,updated_at) VALUES('risk_score_distribution',?,?)
    ON CONFLICT(metric) DO UPDATE SET baseline_json=excluded.baseline_json,updated_at=excluded.updated_at`)
    .run(JSON.stringify(distribution), nowIso());
  return { ok: true, baseline: distribution, sampleSize: 50, updatedAt: nowIso() };
}
function getCalibration(db) {
  const rows = transactionRows(db, 1000).filter(r => r.label != null);
  const positives = rows.filter(r => r.label === 1).length;
  const negatives = rows.filter(r => r.label === 0).length;
  if (positives < 5 || negatives < 20) return {
    ready: false, positives, negatives, minimum: { positives: 5, negatives: 20 },
    note: 'Threshold recommendations are withheld until there are at least 5 confirmed fraud labels and 20 confirmed legitimate labels.'
  };
  const maxFpr = readConfig(db, 'maxFalsePositiveRate', 0.10);
  const candidates = [...new Set(rows.map(r => r.score))].sort((a, b) => a - b);
  let best = null;
  for (const threshold of candidates) {
    const stats = confusion(rows, threshold);
    if (stats.falsePositiveRate == null || stats.falsePositiveRate > maxFpr) continue;
    if (!best || (stats.f2 ?? -1) > (best.stats.f2 ?? -1)) best = { threshold, stats };
  }
  return {
    ready: Boolean(best), positives, negatives, maxFalsePositiveRate: maxFpr,
    recommendation: best ? { reviewThreshold: best.threshold, f2: best.stats.f2, precision: best.stats.precision,
      recall: best.stats.recall, falsePositiveRate: best.stats.falsePositiveRate } : null,
    note: best ? 'This is a human-reviewed threshold suggestion selected using F2 (recall-weighted) while limiting false-positive rate. It is not applied automatically.'
      : 'No candidate met the configured false-positive-rate constraint. Review labels and data quality before changing thresholds.'
  };
}
function applyCalibration(db) {
  const result = getCalibration(db);
  if (!result.ready || !result.recommendation) return { ok: false, status: 409, error: 'No supported calibration recommendation is available.', calibration: result };
  const highThreshold = readConfig(db, 'highThreshold', 70);
  const threshold = Math.max(15, Math.min(highThreshold - 5, Math.round(result.recommendation.reviewThreshold)));
  writeConfig(db, 'reviewThreshold', threshold);
  return { ok: true, applied: { reviewThreshold: threshold }, calibration: getCalibration(db) };
}
function getFairness(db) {
  const rows = db.prepare(`SELECT t.result_json,t.audit_json,l.label FROM transactions t
    JOIN labels l ON l.transaction_id=t.id`).all();
  const dimensions = ['regionType', 'deviceTier', 'appLanguage', 'upiExperience'];
  const output = {};
  for (const dimension of dimensions) {
    const groups = new Map();
    for (const row of rows) {
      if (Number(row.label) !== 0) continue; // false alert rate among reviewer-labelled legitimate payments
      const audit = JSON.parse(row.audit_json || '{}');
      const group = audit[dimension];
      if (!group) continue;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(JSON.parse(row.result_json || '{}'));
    }
    output[dimension] = [...groups.entries()].filter(([, vals]) => vals.length >= 20).map(([group, vals]) => ({
      group, sampleSize: vals.length, falseAlertRate: vals.filter(v => Number(v.score || 0) >= readConfig(db, 'reviewThreshold', 35)).length / vals.length
    }));
  }
  const any = dimensions.some(k => output[k].length > 0);
  return {
    status: any ? 'available' : 'insufficient_group_data',
    dimensions: output,
    minimumGroupSize: 20,
    note: 'Audit dimensions are optional metadata, never scoring inputs. Only aggregate reporting with at least 20 confirmed legitimate records per group is returned. No protected traits are collected by this demo.'
  };
}

module.exports = { getMetrics, getDrift, rebaseline, getCalibration, applyCalibration, getFairness, confusion, averagePrecision };

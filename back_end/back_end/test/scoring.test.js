'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreTransaction, namesMatch } = require('../src/scoring');

const base = {
  amount: 1200, paymentType: 'upi', recipientName: 'Demo Merchant',
  firstPayment: false, reported: false, deviceChanged: false,
  unusualLocation: false, otpEvent: false, unusualTiming: false,
  unusualFrequency: false, unusualFlow: false, rapidTransfers: false,
  urgency: false, unexpectedCollect: false, impersonation: 'none',
  qrDisplayed: '', qrActual: ''
};

test('ordinary baseline payment stays Low and has an explanation', () => {
  const result = scoreTransaction(base);
  assert.equal(result.category, 'Low');
  assert.equal(result.score, 5);
  assert.ok(result.explanation.length > 10);
  assert.ok(Array.isArray(result.signals));
});

test('context-only flags cannot produce High', () => {
  const result = scoreTransaction({ ...base, deviceChanged: true, unusualLocation: true, otpEvent: true });
  assert.notEqual(result.category, 'High');
});

test('QR payment only receives a QR signal when the merchant and recipient differ', () => {
  const matched = scoreTransaction({ ...base, paymentType: 'qr', qrDisplayed: 'Meenakshi Tailors', qrActual: 'Meenakshi Tailors Pvt Ltd' });
  const mismatch = scoreTransaction({ ...base, paymentType: 'qr', qrDisplayed: 'Sunrise Cafe', qrActual: 'Rohit Enterprises' });
  assert.equal(matched.signals.some(s => s.id === 'qrMismatch'), false);
  assert.equal(mismatch.signals.some(s => s.id === 'qrMismatch'), true);
});

test('graph heuristics add an explainable network signal', () => {
  const graphSignals = [{ id: 'graphRapidPassThrough', label: 'Rapid pass-through', points: 22, group: 'graph', detail: 'Synthetic evidence.' }];
  const result = scoreTransaction(base, graphSignals);
  assert.equal(result.signals[0].group, 'graph');
  assert.equal(result.independentKinds, 1);
});

test('one signal group cannot cross the High threshold even with a large raw score', () => {
  const graphSignals = [
    { id: 'graphSharedReceiver', label: 'Shared receiver', points: 18, group: 'graph', detail: 'a' },
    { id: 'graphRapidPassThrough', label: 'Pass-through', points: 22, group: 'graph', detail: 'b' },
    { id: 'graphFanOut', label: 'Fan-out', points: 15, group: 'graph', detail: 'c' }
  ];
  const result = scoreTransaction({ ...base, deviceChanged: true, unusualLocation: true, otpEvent: true }, graphSignals);
  assert.equal(result.independentKinds, 1);
  assert.equal(result.capped, true);
  assert.equal(result.category, 'Review');
  assert.equal(result.score, 69);
});

test('name matching tolerates common company suffixes without treating unrelated names as equal', () => {
  assert.equal(namesMatch('Meenakshi Tailors', 'Meenakshi Tailors Pvt Ltd'), true);
  assert.equal(namesMatch('Sunrise Cafe', 'Rohit Enterprises'), false);
});

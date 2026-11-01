'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { confusion, averagePrecision } = require('../src/metrics');

test('label metrics provide F2, false-positive rate and PR average precision', () => {
  const rows = [
    { score: 98, label: 1 },
    { score: 91, label: 1 },
    { score: 74, label: 0 },
    { score: 20, label: 0 }
  ];
  const stats = confusion(rows, 70);
  assert.equal(stats.tp, 2);
  assert.equal(stats.fp, 1);
  assert.equal(stats.fn, 0);
  assert.equal(stats.tn, 1);
  assert.equal(stats.recall, 1);
  assert.equal(stats.falsePositiveRate, 0.5);
  assert.ok(stats.f2 > stats.f1);
  assert.equal(averagePrecision(rows), 1);
});

test('PR average precision is undefined when no positive labels exist', () => {
  assert.equal(averagePrecision([{ score: 90, label: 0 }, { score: 10, label: 0 }]), null);
});

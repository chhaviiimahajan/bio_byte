'use strict';

// Generates an intentionally imbalanced, fully fictional dataset for a project demo.
// The generated labels are synthetic ground truth and must never be presented as real-world performance.

const API = process.env.API_URL || 'http://127.0.0.1:3000';
const RUN = `synthetic-${Date.now()}`;

async function request(path, options = {}) {
  const response = await fetch(API + path, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function main() {
  await request('/api/health');
  const now = Date.now();
  const events = [];
  const labels = new Map();
  for (let i = 0; i < 100; i++) {
    const isFraud = i >= 95; // 5% positive class: deliberately imbalanced.
    const isSyntheticFalseAlert = [72, 84].includes(i) && !isFraud;
    const amount = isFraud ? 9000 + i * 10 : isSyntheticFalseAlert ? 7000 : 450 + (i % 7) * 90;
    const event = {
      eventId: `${RUN}-${i}`,
      timestamp: new Date(now - (100 - i) * 60000).toISOString(),
      amount,
      paymentType: 'upi',
      recipientName: isFraud ? `Synthetic Recipient ${i}` : `Synthetic Merchant ${i}`,
      recipientId: `synthetic-recipient-${RUN}-${i}`,
      senderRef: `synthetic-sender-${RUN}-${i}`,
      firstPayment: isFraud || isSyntheticFalseAlert,
      reported: isFraud,
      urgency: isFraud || isSyntheticFalseAlert,
      unusualFrequency: isFraud,
      impersonation: isFraud ? 'bank' : 'none',
      auditDimensions: {
        regionType: i % 2 === 0 ? 'Rural' : 'Urban',
        deviceTier: ['Entry-level phone', 'Mid-range phone', 'Premium phone'][i % 3],
        appLanguage: i % 2 === 0 ? 'Hindi' : 'English',
        upiExperience: i % 2 === 0 ? 'New to UPI' : 'Established user'
      }
    };
    events.push(event);
    labels.set(event.eventId, isFraud ? 'fraud' : 'legitimate');
  }

  const batch = await request('/api/stream/transactions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactions: events })
  });
  if (batch.accepted !== events.length) throw new Error(`Only ${batch.accepted}/${events.length} generated transactions were accepted.`);

  const reviewerLabels = batch.results.filter(item => item.transaction).map(item => ({
    transactionId: item.transaction.id,
    label: labels.get(item.transaction.eventId),
    notes: 'Synthetic generator label; not a real-world adjudication.'
  }));
  const feedback = await request('/api/feedback/labels', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labels: reviewerLabels })
  });
  const labelled = feedback.count;

  const [metrics, drift, fairness, calibration] = await Promise.all([
    request('/api/metrics'), request('/api/drift'), request('/api/fairness'), request('/api/calibration')
  ]);
  console.log(`Generated ${batch.accepted} synthetic transactions; reviewer labels added: ${labelled}.`);
  console.log(`Synthetic class balance: 5 fraud / 95 legitimate (5% positive).`);
  console.log(`Metrics status: ${metrics.status}; PR-AUC: ${metrics.metrics?.prAuc ?? 'not available'}.`);
  console.log(`Score distribution drift: ${drift.status}; PSI: ${drift.psi ?? 'not available'}.`);
  console.log(`Fairness audit: ${fairness.status}; minimum group size: ${fairness.minimumGroupSize}.`);
  console.log(`Threshold calibration ready: ${calibration.ready}.`);
  console.log('All labels are generator-provided synthetic ground truth for demonstration only.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

'use strict';

const PROFILE = { typicalAmount: 1200, typicalAmountLabel: '₹1,200' };
const W = {
  base: 5, firstPayment: 10, reported: 32, deviceChanged: 8, unusualLocation: 6,
  otpEvent: 6, rapidTransfers: 14, behaviourByCount: [0, 8, 14, 18],
  amountTiers: [[5, 16], [3, 10], [2, 5]], unexpectedCollect: 16,
  urgency: 10, impersonation: 10, qrMismatch: 34,
  combo: { takeover: 15, newContext: 10, collectPressure: 15, impersonation: 10, qr: 12 }
};
const GROUPS = {
  context: 'Context (weak alone)', payee: 'Recipient history', reputation: 'Recipient reports',
  behaviour: 'Payment behaviour', message: 'Message cues', qr: 'QR details',
  combo: 'Combination', graph: 'Network / graph pattern'
};
const INDEPENDENT = ['payee', 'reputation', 'behaviour', 'message', 'qr', 'graph'];
const IMPERSONATION_LABEL = {
  bank: 'bank staff', government: 'a government official', merchant: 'a merchant',
  family: 'a family member', support: 'customer support'
};
const CATALOG = [
  { id: 'firstPayment', label: 'First payment to this recipient', group: 'payee', points: '+10', desc: 'Common and mild by itself.' },
  { id: 'reported', label: 'Simulated recent report on recipient', group: 'reputation', points: '+32', desc: 'A synthetic report is not proof.' },
  { id: 'amount', label: 'Amount compared with own typical amount', group: 'behaviour', points: '+5 to +16', desc: 'Compared only with the user’s own stated baseline.' },
  { id: 'behaviour', label: 'Differences in timing, frequency or flow', group: 'behaviour', points: '+8 to +18', desc: 'Uses self-relative behaviour flags.' },
  { id: 'rapidTransfers', label: 'Rapid transfers before this payment', group: 'behaviour', points: '+14', desc: 'A reported burst of transfers.' },
  { id: 'unexpectedCollect', label: 'Unexpected collect request', group: 'message', points: '+16', desc: 'An unexpected collect request deserves verification.' },
  { id: 'urgency', label: 'Urgent or pressuring wording', group: 'message', points: '+10', desc: 'A cue, not proof.' },
  { id: 'impersonation', label: 'Claim of being a trusted party', group: 'message', points: '+10', desc: 'The claim is not verified by this input.' },
  { id: 'qrMismatch', label: 'QR merchant name differs from recipient', group: 'qr', points: '+34', desc: 'Only a clear recipient-name mismatch is counted.' },
  { id: 'deviceChanged', label: 'Device or session changed', group: 'context', points: '+8', desc: 'Weak context signal; cannot produce High alone.' },
  { id: 'unusualLocation', label: 'Unusual location', group: 'context', points: '+6', desc: 'Weak context signal; travel is normal.' },
  { id: 'otpEvent', label: 'Recent OTP event', group: 'context', points: '+6', desc: 'No OTP value is collected.' },
  { id: 'graphSharedReceiver', label: 'Multiple independent senders to one recipient', group: 'graph', points: '+18', desc: 'Graph heuristic for a shared receiving hub.' },
  { id: 'graphRapidPassThrough', label: 'Rapid onward-transfer pattern', group: 'graph', points: '+22', desc: 'Graph heuristic for fast movement of received value.' },
  { id: 'graphFanOut', label: 'Rapid fan-out to several recipients', group: 'graph', points: '+15', desc: 'Graph heuristic for multiple rapid onward recipients.' }
];

function normName(s) {
  return String(s || '').toLocaleLowerCase('en').normalize('NFKC')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\b(pvt|ltd|private|limited|the|store|stores|shop|and)\b/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}
function namesMatch(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return true;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const tx = [...new Set(x.split(' '))], ty = [...new Set(y.split(' '))];
  const shared = tx.filter(t => ty.includes(t)).length;
  const union = new Set([...tx, ...ty]).size;
  return union > 0 && shared / union >= 0.5;
}
function categoryFor(score, thresholds = {}) {
  const review = Number(thresholds.reviewThreshold ?? 35);
  const high = Number(thresholds.highThreshold ?? 70);
  return score >= high ? 'High' : score >= review ? 'Review' : 'Low';
}
function recommendation(category) {
  if (category === 'High') return {
    action: 'pause', title: 'Pause and verify through a trusted channel', steps: [
      'Do not approve until you have independently checked the recipient and purpose.',
      'Contact the person or business using contact details you already trust.',
      'Never share an OTP, PIN or password. This application never requests them.'
    ]
  };
  if (category === 'Review') return {
    action: 'verify', title: 'Verify the details before continuing', steps: [
      'Check the recipient name, UPI ID and amount carefully.',
      'Confirm the reason for payment through a separate trusted channel.',
      'For a collect request, remember that approving it sends money out.'
    ]
  };
  return {
    action: 'continue', title: 'No strong demo signals were found', steps: [
      'Still verify the recipient and amount before approving.',
      'A Low estimate is not a guarantee that a payment is safe.'
    ]
  };
}

function scoreTransaction(t, graphSignals = [], thresholds = {}) {
  const signals = [];
  const add = (id, label, points, group, detail) => signals.push({ id, label, points, group, detail });
  const amount = Number(t.amount) || 0;
  const ratio = PROFILE.typicalAmount > 0 ? amount / PROFILE.typicalAmount : 0;
  if (t.firstPayment) add('firstPayment', 'First payment to this recipient', W.firstPayment, 'payee', 'You have not paid this recipient before. This is common and mild by itself.');
  if (t.reported) add('reported', 'Simulated recent report on recipient', W.reported, 'reputation', 'This is a fictional report flag, not proof.');
  for (const [tier, points] of W.amountTiers) {
    if (ratio >= tier) {
      add('amount', 'Amount is higher than your usual', points, 'behaviour', `About ${Math.round(ratio * 10) / 10}× the demo typical amount ${PROFILE.typicalAmountLabel}.`);
      break;
    }
  }
  const diffs = ['unusualTiming', 'unusualFrequency', 'unusualFlow'].filter(k => !!t[k]);
  if (diffs.length) {
    const names = diffs.map(k => ({ unusualTiming: 'timing', unusualFrequency: 'frequency', unusualFlow: 'payment flow' })[k]);
    add('behaviour', `Differs from your usual ${names.join(', ')}`, W.behaviourByCount[diffs.length], 'behaviour', 'Compared with the user’s own stated pattern, not other people.');
  }
  const behaviourChange = diffs.length > 0 || !!t.rapidTransfers || ratio >= 3;
  if (t.rapidTransfers) add('rapidTransfers', 'Rapid transfers before this payment', W.rapidTransfers, 'behaviour', 'Several transfers were reported in a short time window.');
  const collectUnexpected = t.paymentType === 'collect' && !!t.unexpectedCollect;
  if (collectUnexpected) add('unexpectedCollect', 'Unexpected collect request', W.unexpectedCollect, 'message', 'The user reports not expecting this collect request.');
  if (t.urgency) add('urgency', 'Urgent or pressuring wording', W.urgency, 'message', 'Pressure to act quickly is a cue, not proof.');
  if (t.impersonation && t.impersonation !== 'none') add('impersonation', `Message claims to be ${IMPERSONATION_LABEL[t.impersonation] || 'a trusted party'}`, W.impersonation, 'message', 'The identity claim is not verified by the message.');
  const qrMismatch = t.paymentType === 'qr' && !namesMatch(t.qrDisplayed, t.qrActual);
  if (qrMismatch) add('qrMismatch', 'QR merchant name differs from recipient name', W.qrMismatch, 'qr', `Displayed name: “${t.qrDisplayed || '?'}”; app recipient: “${t.qrActual || '?'}”.`);
  if (t.deviceChanged) add('deviceChanged', 'Device or session changed recently', W.deviceChanged, 'context', 'A device or session change is weak context by itself.');
  if (t.unusualLocation) add('unusualLocation', 'Unusual location', W.unusualLocation, 'context', 'Travel and VPN use are normal; this is a weak context signal.');
  if (t.otpEvent) add('otpEvent', 'Recent OTP event', W.otpEvent, 'context', 'Only the occurrence is recorded. No OTP value is accepted or stored.');

  const imp = t.impersonation && t.impersonation !== 'none';
  if (t.otpEvent && t.deviceChanged && (t.firstPayment || t.rapidTransfers || behaviourChange))
    add('combo-takeover', 'Combination: OTP event + new device + new payee or unusual behaviour', W.combo.takeover, 'combo', 'Several independent cues resemble an account-takeover pattern.');
  if ((t.deviceChanged || t.unusualLocation) && behaviourChange)
    add('combo-context', 'Combination: new device/location + changed payment behaviour', W.combo.newContext, 'combo', 'A context change appears alongside behaviour change.');
  if (t.paymentType === 'collect' && t.urgency && (t.firstPayment || collectUnexpected))
    add('combo-collect', 'Combination: collect request + urgency + new or unexpected', W.combo.collectPressure, 'combo', 'Several collect-request cues occur together.');
  if (imp && t.urgency && (t.firstPayment || t.paymentType === 'collect'))
    add('combo-impersonation', 'Combination: trusted-party claim + urgency + new payee or collect request', W.combo.impersonation, 'combo', 'Impersonation and urgency cues occur alongside another signal.');
  if (qrMismatch && (t.firstPayment || t.reported || ratio >= 3))
    add('combo-qr', 'Combination: QR name mismatch + new, reported or unusually large', W.combo.qr, 'combo', 'The QR mismatch occurs with another payment signal.');

  for (const g of graphSignals) add(g.id, g.label, g.points, g.group || 'graph', g.detail);
  const rawScore = W.base + signals.reduce((sum, s) => sum + s.points, 0);
  const independent = new Set(signals.filter(s => INDEPENDENT.includes(s.group)).map(s => s.group));
  let score = Math.min(100, Math.max(0, rawScore));
  let capped = false;
  const highThreshold = Number(thresholds.highThreshold ?? 70);
  if (independent.size < 2 && score >= highThreshold) { score = highThreshold - 1; capped = true; }
  const category = categoryFor(score, thresholds);
  const top = signals.slice().sort((a, b) => b.points - a.points).slice(0, 3).map(s => s.label);
  let explanation = signals.length
    ? `This payment is rated “${category}” mainly because of: ${top.join('; ')}. Signals are estimates, not proof.`
    : 'No notable demo risk signals were found. This is not a guarantee that the payment is safe.';
  if (capped) explanation += ' Fewer than two independent signal groups were present, so the score was kept below High.';
  if (graphSignals.length) explanation += ' Network heuristics identify patterns for human review; ordinary shared merchants and group payments can look similar.';
  return {
    score, rawScore, category, capped, independentKinds: independent.size,
    thresholds: { review: Number(thresholds.reviewThreshold ?? 35), high: Number(thresholds.highThreshold ?? 70) },
    signals, explanation, recommendation: recommendation(category)
  };
}

module.exports = { scoreTransaction, categoryFor, namesMatch, CATALOG, GROUPS, W, PROFILE };

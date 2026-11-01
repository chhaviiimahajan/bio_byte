/*
 * Fraud scoring utility (deterministic demo rules).
 *
 * To use a real backend later, keep the same input/output shape and replace
 * the body of scoreTransaction() with a fetch() call to your API.
 *
 * Input:  transaction object (see data.js BASE)
 * Output: { score, category, rawScore, capped, signals[], explanation, recommendation }
 */
window.UPIDemo = window.UPIDemo || {};

window.UPIDemo.scoring = (function () {
  'use strict';

  var PROFILE = window.UPIDemo.data.PROFILE;

  var W = {
    base: 5,
    firstPayment: 10,
    reported: 32,
    deviceChanged: 8,
    unusualLocation: 6,
    otpEvent: 6,
    rapidTransfers: 14,
    behaviourByCount: [0, 8, 14, 18],
    amountTiers: [[5, 16], [3, 10], [2, 5]],   // [ratio vs typical, points]
    unexpectedCollect: 16,
    urgency: 10,
    impersonation: 10,
    qrMismatch: 34,
    combo: { takeover: 15, newContext: 10, collectPressure: 15, impersonation: 10, qr: 12 }
  };

  var BANDS = { review: 35, high: 70 };

  var GROUPS = {
    context: 'Context (weak alone)',
    payee: 'Recipient history',
    reputation: 'Recipient reports',
    behaviour: 'Payment behaviour',
    message: 'Message cues',
    qr: 'QR details',
    combo: 'Combination'
  };
  var INDEPENDENT = ['payee', 'reputation', 'behaviour', 'message', 'qr'];

  var IMPERSONATION_LABEL = {
    bank: 'bank staff', government: 'a government official', merchant: 'a merchant',
    family: 'a family member', support: 'customer support'
  };

  var CATALOG = [
    { id: 'firstPayment', label: 'First payment to this recipient', group: 'payee', points: '+' + W.firstPayment, desc: 'No earlier payments to this recipient. Very common and mild alone.' },
    { id: 'reported', label: 'Simulated recent report on recipient', group: 'reputation', points: '+' + W.reported, desc: 'A synthetic report flag. A report is not proof.' },
    { id: 'amount', label: 'Amount compared with your typical amount', group: 'behaviour', points: '+5 to +16', desc: 'Compared with this user\'s own typical amount, never with other people.' },
    { id: 'behaviour', label: 'Differences in timing, frequency or flow', group: 'behaviour', points: '+8 to +18', desc: 'Counts how many of timing, frequency and flow differ from usual.' },
    { id: 'rapidTransfers', label: 'Rapid transfers before this payment', group: 'behaviour', points: '+' + W.rapidTransfers, desc: 'Several quick transfers in a short window.' },
    { id: 'unexpectedCollect', label: 'Unexpected collect request', group: 'message', points: '+' + W.unexpectedCollect, desc: 'You did not expect someone to request money.' },
    { id: 'urgency', label: 'Urgent or pressuring wording', group: 'message', points: '+' + W.urgency, desc: 'Simulated cue. Urgency is common in scams but also in genuine reminders.' },
    { id: 'impersonation', label: 'Claim of being a trusted party', group: 'message', points: '+' + W.impersonation, desc: 'A claim in a message is an indicator, not proof.' },
    { id: 'qrMismatch', label: 'QR merchant name differs from recipient', group: 'qr', points: '+' + W.qrMismatch, desc: 'Only clear name differences count. QR payments themselves are normal.' },
    { id: 'deviceChanged', label: 'Device or session changed', group: 'context', points: '+' + W.deviceChanged, desc: 'People change phones. Never High alone.' },
    { id: 'unusualLocation', label: 'Unusual location', group: 'context', points: '+' + W.unusualLocation, desc: 'Travel is normal. Never High alone.' },
    { id: 'otpEvent', label: 'Recent OTP event', group: 'context', points: '+' + W.otpEvent, desc: 'OTPs are routine. Never High alone. The app never sees any OTP.' },
    { id: 'combo-takeover', label: 'Combo: OTP + new device + new payee / rapid / unusual', group: 'combo', points: '+' + W.combo.takeover, desc: 'Possible account-takeover pattern; only when several signals line up.' },
    { id: 'combo-context', label: 'Combo: new device/location + behaviour change', group: 'combo', points: '+' + W.combo.newContext, desc: 'Context plus a meaningful change in payment behaviour.' },
    { id: 'combo-collect', label: 'Combo: collect request + urgency + new/unexpected', group: 'combo', points: '+' + W.combo.collectPressure, desc: 'Typical shape of a fake collect request.' },
    { id: 'combo-impersonation', label: 'Combo: trusted-party claim + urgency + new payee/collect', group: 'combo', points: '+' + W.combo.impersonation, desc: 'Impersonation cues supported by other signals.' },
    { id: 'combo-qr', label: 'Combo: QR mismatch + new/reported/unusual amount', group: 'combo', points: '+' + W.combo.qr, desc: 'A name mismatch supported by another signal.' }
  ];

  function normName(s) {
    return String(s || '').toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\b(pvt|ltd|private|limited|the|store|stores|shop|and)\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  function namesMatch(a, b) {
    var x = normName(a), y = normName(b);
    if (!x || !y) return true;               // cannot compare, so do not flag
    if (x === y || x.indexOf(y) !== -1 || y.indexOf(x) !== -1) return true;
    var tx = x.split(' '), ty = y.split(' ');
    var shared = tx.filter(function (t) { return ty.indexOf(t) !== -1; }).length;
    var union = tx.length + ty.length - shared;
    return union > 0 && (shared / union) >= 0.5;
  }

  function categoryFor(score) {
    if (score >= BANDS.high) return 'High';
    if (score >= BANDS.review) return 'Review';
    return 'Low';
  }

  function computeScore(t) {
    var signals = [];
    function add(id, label, points, group, detail) {
      signals.push({ id: id, label: label, points: points, group: group, detail: detail });
    }

    var amount = Number(t.amount) || 0;
    var type = t.paymentType;
    var ratio = PROFILE.typicalAmount > 0 ? amount / PROFILE.typicalAmount : 0;

    // Recipient
    if (t.firstPayment) add('firstPayment', 'First payment to this recipient', W.firstPayment, 'payee',
      'You have not paid this recipient before. This is common and only a mild signal.');
    if (t.reported) add('reported', 'Simulated recent report on recipient', W.reported, 'reputation',
      'The synthetic data includes a recent report about this recipient. A report is not proof.');

    // Amount vs own typical amount
    for (var i = 0; i < W.amountTiers.length; i++) {
      if (ratio >= W.amountTiers[i][0]) {
        add('amount', 'Amount is higher than your usual', W.amountTiers[i][1], 'behaviour',
          'About ' + (Math.round(ratio * 10) / 10) + '× your typical payment of ' + PROFILE.typicalAmountLabel + '.');
        break;
      }
    }

    // Behaviour differences
    var diffs = [];
    if (t.unusualTiming) diffs.push('timing');
    if (t.unusualFrequency) diffs.push('frequency');
    if (t.unusualFlow) diffs.push('payment flow');
    if (diffs.length) add('behaviour', 'Differs from your usual ' + diffs.join(', '),
      W.behaviourByCount[diffs.length], 'behaviour', 'Compared only with your own earlier payments.');
    if (t.rapidTransfers) add('rapidTransfers', 'Rapid transfers before this payment', W.rapidTransfers, 'behaviour',
      'Several transfers happened in a short window.');

    var behaviourChange = diffs.length > 0 || t.rapidTransfers || ratio >= 3;

    // Message cues
    var collectUnexpected = type === 'collect' && !!t.unexpectedCollect;
    if (collectUnexpected) add('unexpectedCollect', 'Unexpected collect request', W.unexpectedCollect, 'message',
      'A collect request asks to take money from you. You were not expecting this one.');
    if (t.urgency) add('urgency', 'Urgent or pressuring wording', W.urgency, 'message',
      'Pressure to act quickly is a common scam cue, but not proof.');
    var imp = t.impersonation && t.impersonation !== 'none' ? t.impersonation : null;
    if (imp) add('impersonation', 'Message claims to be ' + (IMPERSONATION_LABEL[imp] || 'a trusted party'), W.impersonation, 'message',
      'A claim in a message cannot be verified from the message itself.');

    // QR
    var qrMismatch = type === 'qr' && !namesMatch(t.qrDisplayed, t.qrActual);
    if (qrMismatch) add('qrMismatch', 'QR merchant name differs from recipient name', W.qrMismatch, 'qr',
      'Shown: “' + (t.qrDisplayed || '?') + '”. Actual recipient: “' + (t.qrActual || '?') + '”.');

    // Context (weak alone)
    if (t.deviceChanged) add('deviceChanged', 'Device or session changed recently', W.deviceChanged, 'context',
      'Changing phones or sessions is common. It matters mainly alongside other signals.');
    if (t.unusualLocation) add('unusualLocation', 'Unusual location', W.unusualLocation, 'context',
      'Travel and VPNs are normal. It matters mainly alongside other signals.');
    if (t.otpEvent) add('otpEvent', 'Recent OTP event', W.otpEvent, 'context',
      'OTPs are routine. This app never sees or stores any OTP.');

    // Combinations
    if (t.otpEvent && t.deviceChanged && (t.firstPayment || t.rapidTransfers || behaviourChange))
      add('combo-takeover', 'Combination: OTP event + new device + new payee or unusual behaviour', W.combo.takeover, 'combo',
        'These together can match an account-takeover pattern.');
    if ((t.deviceChanged || t.unusualLocation) && behaviourChange)
      add('combo-context', 'Combination: new device/location + changed payment behaviour', W.combo.newContext, 'combo',
        'A context change alongside meaningful changes in how you pay.');
    if (type === 'collect' && t.urgency && (t.firstPayment || collectUnexpected))
      add('combo-collect', 'Combination: collect request + urgency + new or unexpected', W.combo.collectPressure, 'combo',
        'Matches the typical shape of a fake collect request.');
    if (imp && t.urgency && (t.firstPayment || type === 'collect'))
      add('combo-impersonation', 'Combination: trusted-party claim + urgency + new payee or collect request', W.combo.impersonation, 'combo',
        'Impersonation cues supported by other signals.');
    if (qrMismatch && (t.firstPayment || t.reported || ratio >= 3))
      add('combo-qr', 'Combination: QR name mismatch + new, reported or unusually large', W.combo.qr, 'combo',
        'The mismatch is supported by another signal.');

    // Score
    var raw = W.base;
    signals.forEach(function (s) { raw += s.points; });

    var seen = {};
    signals.forEach(function (s) { if (INDEPENDENT.indexOf(s.group) !== -1) seen[s.group] = true; });
    var independentKinds = Object.keys(seen).length;

    var score = Math.min(100, Math.max(0, raw));
    var capped = false;
    // Guardrail: High needs at least two independent kinds of signal beyond context.
    if (independentKinds < 2 && score > BANDS.high - 1) { score = BANDS.high - 1; capped = true; }

    var category = categoryFor(score);
    return {
      score: score, rawScore: raw, category: category, capped: capped,
      independentKinds: independentKinds, signals: signals,
      explanation: buildExplanation(category, signals, capped),
      recommendation: buildRecommendation(category)
    };
  }

  function buildExplanation(category, signals, capped) {
    if (!signals.length) {
      return 'No notable risk signals were found for this payment. It looks consistent with your usual behaviour. This is an estimate, not a guarantee.';
    }
    var top = signals.slice().sort(function (a, b) { return b.points - a.points; }).slice(0, 3)
      .map(function (s) { return s.label; });
    var text = 'This payment is rated “' + category + '” mainly because of: ' + top.join('; ') + '. ';
    text += 'The score reflects how signals combine, because single signals such as a new device, a new location, a QR payment or an OTP event are common and do not indicate fraud by themselves. ';
    if (capped) text += 'Fewer than two independent kinds of signal were present, so the score was kept below High. ';
    text += 'This is an estimate and does not prove fraud.';
    return text;
  }

  function buildRecommendation(category) {
    if (category === 'High') {
      return { action: 'pause', title: 'Pause and contact the recipient through a trusted channel',
        steps: [
          'Do not approve yet. Nothing has been blocked, and the decision is yours.',
          'Contact the person or business using a number or app you already trust, not details from the message or QR.',
          'Never share an OTP, PIN or password with anyone, including people claiming to be from your bank.',
          'If you already shared credentials, contact your bank using the number on your card or official app.'
        ] };
    }
    if (category === 'Review') {
      return { action: 'verify', title: 'Verify the details before continuing',
        steps: [
          'Check the recipient name and UPI ID carefully.',
          'Confirm the amount and the reason for the payment with the person or shop.',
          'For collect requests, remember that approving sends money out.',
          'If anything feels off, wait and check through a trusted channel.'
        ] };
    }
    return { action: 'continue', title: 'You can continue',
      steps: [
        'Nothing unusual stood out. Still, glance at the recipient name and amount before approving.',
        'Never share an OTP or PIN with anyone.'
      ] };
  }

  /* Swap this function's body for an API call later. Keep it returning a Promise. */
  function scoreTransaction(t) {
    return Promise.resolve(computeScore(t));
  }

  return {
    scoreTransaction: scoreTransaction,
    categoryFor: categoryFor,
    CATALOG: CATALOG,
    GROUPS: GROUPS,
    BANDS: BANDS
  };
})();

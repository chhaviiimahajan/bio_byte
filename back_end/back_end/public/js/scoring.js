/* Backend adapter. Scoring is performed and persisted by the SafeUPI API. */
window.UPIDemo = window.UPIDemo || {};
window.UPIDemo.API_BASE = window.UPIDemo.API_BASE || '';
window.UPIDemo.scoring = (function () {
  'use strict';
  var API = window.UPIDemo.API_BASE;
  var GROUPS = {
    context: 'Context (weak alone)', payee: 'Recipient history', reputation: 'Recipient reports',
    behaviour: 'Payment behaviour', message: 'Message cues', qr: 'QR details',
    combo: 'Combination', graph: 'Network / graph pattern'
  };
  var CATALOG = [
    { id: 'firstPayment', label: 'First payment to this recipient', group: 'payee', points: '+10', desc: 'Common and mild by itself.' },
    { id: 'reported', label: 'Simulated recent report on recipient', group: 'reputation', points: '+32', desc: 'A synthetic report is not proof.' },
    { id: 'amount', label: 'Amount compared with own typical amount', group: 'behaviour', points: '+5 to +16', desc: 'Compared with the user’s own baseline.' },
    { id: 'behaviour', label: 'Differences in timing, frequency or flow', group: 'behaviour', points: '+8 to +18', desc: 'Self-relative behaviour flags.' },
    { id: 'rapidTransfers', label: 'Rapid transfers before this payment', group: 'behaviour', points: '+14', desc: 'Several transfers in a short window.' },
    { id: 'unexpectedCollect', label: 'Unexpected collect request', group: 'message', points: '+16', desc: 'Unexpected collect requests deserve verification.' },
    { id: 'urgency', label: 'Urgent or pressuring wording', group: 'message', points: '+10', desc: 'A cue, not proof.' },
    { id: 'impersonation', label: 'Claim of being a trusted party', group: 'message', points: '+10', desc: 'The identity claim is not verified.' },
    { id: 'qrMismatch', label: 'QR merchant name differs from recipient', group: 'qr', points: '+34', desc: 'Only a clear mismatch is counted.' },
    { id: 'deviceChanged', label: 'Device or session changed', group: 'context', points: '+8', desc: 'Weak context signal; cannot produce High alone.' },
    { id: 'unusualLocation', label: 'Unusual location', group: 'context', points: '+6', desc: 'Weak context signal; travel is normal.' },
    { id: 'otpEvent', label: 'Recent OTP event', group: 'context', points: '+6', desc: 'No OTP value is collected.' },
    { id: 'graphSharedReceiver', label: 'Multiple independent senders to one recipient', group: 'graph', points: '+18', desc: 'Graph heuristic for a shared receiving hub.' },
    { id: 'graphRapidPassThrough', label: 'Rapid onward-transfer pattern', group: 'graph', points: '+22', desc: 'Graph heuristic for fast movement of received value.' },
    { id: 'graphFanOut', label: 'Rapid fan-out to several recipients', group: 'graph', points: '+15', desc: 'Graph heuristic for multiple onward recipients.' }
  ];
  function scoreTransaction(transaction) {
    return fetch(API + '/api/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(transaction)
    }).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) throw new Error((data.details || [data.error || 'The API request failed.']).join(' '));
        var result = data.transaction.result;
        result.transaction = data.transaction;
        return result;
      });
    });
  }
  return { scoreTransaction: scoreTransaction, CATALOG: CATALOG, GROUPS: GROUPS, BANDS: { review: 35, high: 70 } };
})();

/* Fictional synthetic data. No real people, accounts or banks. */
window.UPIDemo = window.UPIDemo || {};

window.UPIDemo.data = (function () {
  'use strict';

  var PROFILE = {
    name: 'Ananya Rao (fictional)',
    typicalAmount: 1200,
    typicalAmountLabel: '₹1,200',
    usualHours: '8 AM – 10 PM',
    weeklyPayments: 9,
    knownRecipients: 14,
    mainFlow: 'Pays shops and friends; rarely sends out money she just received'
  };

  var BASE = {
    amount: 0, paymentType: 'upi', recipientName: '', recipientId: '',
    firstPayment: false, reported: false,
    deviceChanged: false, unusualLocation: false, otpEvent: false,
    unusualTiming: false, unusualFrequency: false, unusualFlow: false, rapidTransfers: false,
    urgency: false, impersonation: 'none', unexpectedCollect: false,
    qrDisplayed: '', qrActual: ''
  };

  function tx(o) { return Object.assign({}, BASE, o); }

  var TRANSACTIONS = [
    tx({ id: 'T-1001', when: 'Today, 09:12', sampleLabel: 'Everyday grocery payment', note: 'Known shop, usual amount.',
         amount: 640, paymentType: 'upi', recipientName: 'Fresh Basket Grocers', recipientId: 'freshbasket@demobank' }),
    tx({ id: 'T-1002', when: 'Today, 10:40', sampleLabel: 'QR payment, first time, names match', note: 'A QR payment to a new shop is normal when the names match.',
         amount: 1800, paymentType: 'qr', recipientName: 'Meenakshi Tailors', recipientId: 'meenakshi.tailors@demobank',
         firstPayment: true, qrDisplayed: 'Meenakshi Tailors', qrActual: 'Meenakshi Tailors' }),
    tx({ id: 'T-1003', when: 'Today, 11:05', sampleLabel: 'Urgent collect request from “refund desk”', note: 'Unexpected collect, new recipient, urgent wording and a support claim.',
         amount: 4999, paymentType: 'collect', recipientName: 'Quick Refund Desk', recipientId: 'qr.refunds@demobank',
         firstPayment: true, unexpectedCollect: true, urgency: true, impersonation: 'support' }),
    tx({ id: 'T-1004', when: 'Today, 11:32', sampleLabel: 'Possible account takeover pattern', note: 'OTP event with a new device, new payee, rapid transfers and unusual timing.',
         amount: 18000, paymentType: 'upi', recipientName: 'R. Kulkarni', recipientId: 'r.kulkarni77@demobank',
         firstPayment: true, deviceChanged: true, otpEvent: true, rapidTransfers: true, unusualTiming: true }),
    tx({ id: 'T-1005', when: 'Today, 12:10', sampleLabel: 'QR name mismatch (otherwise ordinary)', note: 'Displayed merchant and actual recipient differ.',
         amount: 2400, paymentType: 'qr', recipientName: 'Rohit Enterprises', recipientId: 'rohit.ent@demobank',
         qrDisplayed: 'Sunrise Cafe', qrActual: 'Rohit Enterprises' }),
    tx({ id: 'T-1006', when: 'Today, 12:45', sampleLabel: 'New phone, paying a friend', note: 'A new device alone is a weak signal.',
         amount: 900, paymentType: 'upi', recipientName: 'Kavya Menon', recipientId: 'kavya.m@demobank', deviceChanged: true }),
    tx({ id: 'T-1007', when: 'Today, 13:20', sampleLabel: 'OTP event, usual payee', note: 'An OTP event alone is not suspicious.',
         amount: 1500, paymentType: 'upi', recipientName: 'City Power Utility', recipientId: 'citypower@demobank', otpEvent: true }),
    tx({ id: 'T-1008', when: 'Today, 14:02', sampleLabel: 'QR mismatch + reported recipient + large amount', note: 'Several independent signals together.',
         amount: 7500, paymentType: 'qr', recipientName: 'S. Prakash Traders', recipientId: 'sprakash.tr@demobank',
         firstPayment: true, reported: true, qrDisplayed: 'Lakshmi Sweets', qrActual: 'S. Prakash Traders' }),
    tx({ id: 'T-1009', when: 'Today, 14:30', sampleLabel: 'Expected subscription collect request', note: 'Collect requests are normal when expected and from a known merchant.',
         amount: 499, paymentType: 'collect', recipientName: 'StreamBox Subscriptions', recipientId: 'streambox@demobank' }),
    tx({ id: 'T-1010', when: 'Today, 15:15', sampleLabel: '“Dad, new number” urgent request', note: 'Family-member claim from a new number with urgent wording.',
         amount: 9000, paymentType: 'upi', recipientName: 'Dad (new number)', recipientId: 'newnum.9000@demobank',
         firstPayment: true, urgency: true, impersonation: 'family' }),
    tx({ id: 'T-1011', when: 'Today, 16:00', sampleLabel: 'New location + unusual amount and timing', note: 'Known shop, but several behaviour differences.',
         amount: 6000, paymentType: 'upi', recipientName: 'Gupta Electronics', recipientId: 'gupta.elec@demobank',
         unusualLocation: true, unusualTiming: true }),
    tx({ id: 'T-1012', when: 'Today, 16:35', sampleLabel: 'Pass-through style flow', note: 'Money just received is being sent on quickly to a new account.',
         amount: 22000, paymentType: 'upi', recipientName: 'Account M-02', recipientId: 'm02.relay@demobank',
         firstPayment: true, rapidTransfers: true, unusualFlow: true, unusualFrequency: true })
  ];

  /* Illustrative false-alert rates among LEGITIMATE payments. Invented demo numbers. */
  var FAIRNESS = {
    overall: 4.3,
    groups: [
      { title: 'Region type', rows: [
        { label: 'Urban', rate: 4.1 }, { label: 'Semi-urban', rate: 4.3 }, { label: 'Rural', rate: 4.8 } ] },
      { title: 'Device tier', rows: [
        { label: 'Premium phone', rate: 4.0 }, { label: 'Mid-range phone', rate: 4.4 }, { label: 'Entry-level phone', rate: 4.9 } ] },
      { title: 'App interface language', rows: [
        { label: 'English', rate: 3.9 }, { label: 'Hindi', rate: 4.4 }, { label: 'Tamil', rate: 4.6 }, { label: 'Bengali', rate: 4.5 } ] },
      { title: 'Experience with UPI', rows: [
        { label: 'Established user', rate: 3.8 }, { label: 'New to UPI (under 3 months)', rate: 5.7 } ] }
    ]
  };

  /* Synthetic mule-style network. Coordinates are for the SVG viewBox 800x430. */
  var NETWORK = {
    nodes: [
      { id: 's1', label: 'Sender A', x: 90, y: 70, role: 'source',
        text: 'A fictional account holder who sent a one-time payment to a newly seen account. One payment is common and not suspicious by itself.' },
      { id: 's2', label: 'Sender B', x: 90, y: 200, role: 'source',
        text: 'Another fictional account holder with a first-time payment to the same new account.' },
      { id: 's3', label: 'Sender C', x: 90, y: 330, role: 'source',
        text: 'Pays the same new account once, and also pays an ordinary local grocer regularly. The grocer link is a normal, established one.' },
      { id: 'h1', label: 'M-01', x: 320, y: 200, role: 'hub',
        text: 'Newly linked account that received three first-time payments from unrelated senders and passed most of the money on within minutes. This pattern deserves human review, but there may be innocent explanations (for example a small group collecting money).' },
      { id: 'p1', label: 'M-02', x: 520, y: 105, role: 'relay',
        text: 'Receives funds from M-01 and forwards them within about 5 minutes to two recipients (fan-out).' },
      { id: 'p2', label: 'M-03', x: 520, y: 290, role: 'relay',
        text: 'Receives a smaller share from M-01 and forwards it to two further recipients.' },
      { id: 'o1', label: 'R-1', x: 720, y: 50, role: 'out',
        text: 'End recipient of a rapid onward transfer. Being at the end of a chain does not prove wrongdoing.' },
      { id: 'o2', label: 'R-2', x: 720, y: 150, role: 'out',
        text: 'End recipient of a rapid onward transfer from M-02.' },
      { id: 'o3', label: 'R-3', x: 720, y: 250, role: 'out',
        text: 'End recipient of a transfer from M-03.' },
      { id: 'o4', label: 'R-4', x: 720, y: 350, role: 'out',
        text: 'End recipient of a transfer from M-03.' },
      { id: 'g1', label: 'Grocer', x: 320, y: 385, role: 'normal',
        text: 'An ordinary local grocer with a long-standing, regular link. Shown for contrast: most network links are normal.' }
    ],
    edges: [
      { from: 's1', to: 'h1', amount: 9500, pattern: 'new', note: 'New link' },
      { from: 's2', to: 'h1', amount: 12000, pattern: 'new', note: 'New link' },
      { from: 's3', to: 'h1', amount: 7800, pattern: 'new', note: 'New link' },
      { from: 'h1', to: 'p1', amount: 21000, pattern: 'rapid', note: 'Forwarded in ~4 min' },
      { from: 'h1', to: 'p2', amount: 8300, pattern: 'rapid', note: 'Forwarded in ~6 min' },
      { from: 'p1', to: 'o1', amount: 10500, pattern: 'rapid', note: 'Fan-out, ~3 min' },
      { from: 'p1', to: 'o2', amount: 10200, pattern: 'rapid', note: 'Fan-out, ~3 min' },
      { from: 'p2', to: 'o3', amount: 4100, pattern: 'new', note: 'New link' },
      { from: 'p2', to: 'o4', amount: 4000, pattern: 'new', note: 'New link' },
      { from: 's3', to: 'g1', amount: 640, pattern: 'normal', note: 'Established, ordinary link' }
    ]
  };

  return { PROFILE: PROFILE, TRANSACTIONS: TRANSACTIONS, FAIRNESS: FAIRNESS, NETWORK: NETWORK };
})();

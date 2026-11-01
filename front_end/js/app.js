/* UI logic: navigation, rendering, form handling. */
(function () {
  'use strict';

  var D = window.UPIDemo.data;
  var S = window.UPIDemo.scoring;

  var inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
  var TYPE_LABEL = { upi: 'UPI payment', collect: 'Collect request', qr: 'QR payment' };
  var VIEWS = ['dashboard', 'checker', 'alerts', 'network', 'explain'];
  var TITLES = {
    dashboard: 'Dashboard', checker: 'Check a payment', alerts: 'Alerts',
    network: 'Network view', explain: 'Explainability & fairness'
  };
  var CHECKBOXES = ['firstPayment', 'reported', 'deviceChanged', 'unusualLocation', 'otpEvent',
    'unusualTiming', 'unusualFrequency', 'unusualFlow', 'rapidTransfers', 'urgency', 'unexpectedCollect'];
  var TEXTS = ['amount', 'paymentType', 'recipientName', 'recipientId', 'impersonation', 'qrDisplayed', 'qrActual'];

  var scored = [];          // transactions with results
  var filter = 'all';
  var lastResult = null;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function badge(cat) {
    var icon = cat === 'High' ? '▲' : cat === 'Review' ? '!' : '✓';
    return '<span class="badge badge-' + cat.toLowerCase() + '"><span aria-hidden="true">' + icon + '</span>' + cat + ' risk</span>';
  }

  /* ---------- Navigation ---------- */
  function showView(name, focus) {
    if (VIEWS.indexOf(name) === -1) name = 'dashboard';
    VIEWS.forEach(function (v) { $('#view-' + v).hidden = v !== name; });
    $$('.nav-btn').forEach(function (b) {
      if (b.dataset.view === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    document.title = TITLES[name] + ' – SafeUPI Check demo';
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    if (focus) { var h = $('#view-' + name + ' h1'); if (h) h.focus(); window.scrollTo(0, 0); }
    if (name === 'explain') renderLatestSignals();
  }

  /* ---------- Dashboard ---------- */
  function renderDashboard() {
    $('#profileName').textContent = D.PROFILE.name;
    var high = scored.filter(function (t) { return t.result.category === 'High'; }).length;
    var review = scored.filter(function (t) { return t.result.category === 'Review'; }).length;
    var vol = scored.reduce(function (a, t) { return a + t.amount; }, 0);
    $('#summaryCards').innerHTML =
      card('Payments checked today', scored.length, 'Synthetic transactions') +
      card('High-risk alerts', high, 'Prompts to pause and verify; nothing is blocked') +
      card('Review alerts', review, 'Prompts to double-check details') +
      card('Demo false-alert rate', D.FAIRNESS.overall + '%', 'Invented figure for illustration') +
      card('Total value checked', inr.format(vol), 'Fictional amounts');

    $('#recentBody').innerHTML = scored.slice(0, 7).map(function (t) {
      return '<tr><td>' + esc(t.when) + '</td><td>' + esc(t.recipientName) + '</td><td>' + esc(TYPE_LABEL[t.paymentType]) +
        '</td><td class="num">' + inr.format(t.amount) + '</td><td>' + badge(t.result.category) + '</td></tr>';
    }).join('');

    var P = D.PROFILE;
    $('#profileList').innerHTML =
      row('Typical payment', P.typicalAmountLabel) + row('Usual hours', P.usualHours) +
      row('Payments per week', P.weeklyPayments) + row('Known recipients', P.knownRecipients) + row('Usual flow', P.mainFlow);
  }
  function card(label, value, hint) {
    return '<div class="card"><p class="label">' + esc(label) + '</p><p class="value">' + esc(value) + '</p><p class="hint">' + esc(hint) + '</p></div>';
  }
  function row(dt, dd) { return '<dt>' + esc(dt) + '</dt><dd>' + esc(dd) + '</dd>'; }

  /* ---------- Alerts ---------- */
  function renderAlerts() {
    var list = scored.slice().sort(function (a, b) { return b.result.score - a.result.score; })
      .filter(function (t) { return filter === 'all' || t.result.category === filter; });
    $('#alertCount').textContent = 'Showing ' + list.length + ' of ' + scored.length + ' alerts' +
      (filter === 'all' ? '.' : ' (' + filter + ' risk).');
    if (!list.length) {
      $('#alertList').innerHTML = '<li class="alert-item"><p>No alerts in this category.</p></li>';
      return;
    }
    $('#alertList').innerHTML = list.map(function (t) {
      var sigs = t.result.signals.filter(function (s) { return s.group !== 'combo'; }).slice(0, 4)
        .map(function (s) { return '<li>' + esc(s.label) + '</li>'; }).join('');
      return '<li class="alert-item cat-' + t.result.category + '">' +
        '<div class="alert-top"><span class="alert-title">' + esc(t.recipientName) + ' · ' + inr.format(t.amount) + '</span>' +
        badge(t.result.category) + '</div>' +
        '<p class="alert-meta">' + esc(TYPE_LABEL[t.paymentType]) + ' · ' + esc(t.when) + ' · Demo score ' + t.result.score + '/100 · ' + esc(t.id) + '</p>' +
        (sigs ? '<ul class="alert-sig">' + sigs + '</ul>' : '<p class="small">No notable signals.</p>') +
        '<button type="button" class="btn btn-secondary" data-open="' + esc(t.id) + '">Open in checker</button></li>';
    }).join('');
  }

  /* ---------- Checker ---------- */
  function readForm(form) {
    var t = {};
    TEXTS.forEach(function (n) { t[n] = form.elements[n].value; });
    t.amount = Number(t.amount);
    CHECKBOXES.forEach(function (n) { t[n] = form.elements[n].checked; });
    return t;
  }
  function fillForm(form, t) {
    TEXTS.forEach(function (n) { form.elements[n].value = t[n] == null ? '' : t[n]; });
    CHECKBOXES.forEach(function (n) { form.elements[n].checked = !!t[n]; });
    syncTypeFields();
  }
  function syncTypeFields() {
    var type = $('#paymentType').value;
    $('#qrFields').hidden = type !== 'qr';
    $('#collectFields').hidden = type !== 'collect';
  }

  function renderResult(r, t) {
    var cat = r.category, lc = cat.toLowerCase();
    var sigHtml = r.signals.length ? '<ul class="signal-list">' + r.signals.map(function (s) {
      return '<li><span>' + esc(s.label) + '<span class="detail">' + esc(s.detail) + '</span></span><span class="pts">+' + s.points + '</span></li>';
    }).join('') + '</ul>' : '<p class="small">No contributing signals.</p>';
    var reco = r.recommendation;

    $('#result').innerHTML =
      '<div class="result-head">' + badge(cat) +
      '<span class="score-text">Demo risk score: ' + r.score + ' / 100</span></div>' +
      '<div class="meter meter-' + lc + '" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + r.score +
      '" aria-label="Demo risk score ' + r.score + ' out of 100"><span style="width:' + r.score + '%"></span></div>' +
      '<div class="meter-scale" aria-hidden="true"><span>0 Low</span><span>35 Review</span><span>70 High</span><span>100</span></div>' +
      '<p class="notice"><strong>This is only an estimate.</strong> It does not prove fraud, and nothing has been blocked. You decide what to do.</p>' +
      '<h3>Why this result</h3><p>' + esc(r.explanation) + '</p>' +
      '<h3>Contributing signals</h3>' + sigHtml +
      '<div class="reco reco-' + lc + '"><h3>Recommendation: ' + esc(reco.title) + '</h3><ul>' +
      reco.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul></div>' +
      '<p class="small">Checked: ' + inr.format(t.amount) + ' to ' + esc(t.recipientName) + ' (' + esc(TYPE_LABEL[t.paymentType]) + ').</p>';
    $('#result').focus();
  }

  function onSubmit(e) {
    e.preventDefault();
    var form = e.target;
    var t = readForm(form);
    var err = $('#formError');
    if (!(t.amount > 0)) { err.textContent = 'Please enter an amount greater than zero.'; form.elements.amount.focus(); return; }
    if (!t.recipientName.trim()) { err.textContent = 'Please enter the recipient or merchant name.'; form.elements.recipientName.focus(); return; }
    err.textContent = '';
    S.scoreTransaction(t).then(function (r) {
      lastResult = { r: r, t: t };
      renderResult(r, t);
    });
  }

  function populateSamples() {
    $('#sampleSelect').innerHTML = D.TRANSACTIONS.map(function (t) {
      return '<option value="' + esc(t.id) + '">' + esc(t.sampleLabel) + '</option>';
    }).join('');
  }
  function loadSample(id) {
    var t = D.TRANSACTIONS.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    fillForm($('#checkForm'), t);
    $('#sampleNote').textContent = 'Loaded: ' + t.note;
    $('#formError').textContent = '';
  }

  /* ---------- Network ---------- */
  var SVGNS = 'http://www.w3.org/2000/svg';
  function nodeById(id) { return D.NETWORK.nodes.filter(function (n) { return n.id === id; })[0]; }
  function svgEl(tag, attrs) {
    var el = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }
  function renderNetwork() {
    var svg = $('#graph');
    svg.innerHTML = '';
    var defs = svgEl('defs');
    var marker = svgEl('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
    marker.appendChild(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#34415a' }));
    defs.appendChild(marker);
    svg.appendChild(defs);
    var R = 27;

    D.NETWORK.edges.forEach(function (e) {
      var a = nodeById(e.from), b = nodeById(e.to);
      var dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy);
      var ux = dx / len, uy = dy / len;
      var line = svgEl('line', {
        x1: a.x + ux * R, y1: a.y + uy * R, x2: b.x - ux * (R + 6), y2: b.y - uy * (R + 6),
        'class': 'e-' + e.pattern, 'marker-end': 'url(#arrow)'
      });
      svg.appendChild(line);
    });
    D.NETWORK.edges.forEach(function (e) {
      var a = nodeById(e.from), b = nodeById(e.to);
      var t = svgEl('text', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 6, 'text-anchor': 'middle', 'class': 'edge-label' });
      t.textContent = inr.format(e.amount);
      svg.appendChild(t);
    });

    D.NETWORK.nodes.forEach(function (n) {
      var g = svgEl('g', { 'class': 'node role-' + n.role, tabindex: '0', role: 'button',
        'aria-label': 'Account ' + n.label + '. Press Enter for details.', 'data-id': n.id, transform: 'translate(' + n.x + ',' + n.y + ')' });
      g.appendChild(svgEl('circle', { r: R, cx: 0, cy: 0 }));
      var t = svgEl('text', { x: 0, y: 4 }); t.textContent = n.label;
      g.appendChild(t);
      g.addEventListener('click', function () { selectNode(n.id); });
      g.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectNode(n.id); }
      });
      svg.appendChild(g);
    });

    $('#edgeBody').innerHTML = D.NETWORK.edges.map(function (e) {
      return '<tr><td>' + esc(nodeById(e.from).label) + '</td><td>' + esc(nodeById(e.to).label) + '</td><td class="num">' +
        inr.format(e.amount) + '</td><td>' + esc(e.note) + '</td></tr>';
    }).join('');
  }
  function selectNode(id) {
    var n = nodeById(id);
    $$('#graph .node').forEach(function (g) { g.classList.toggle('selected', g.getAttribute('data-id') === id); });
    var inE = D.NETWORK.edges.filter(function (e) { return e.to === id; });
    var outE = D.NETWORK.edges.filter(function (e) { return e.from === id; });
    var f = function (list, key) {
      return list.length ? list.map(function (e) { return esc(nodeById(e[key]).label) + ' (' + inr.format(e.amount) + ', ' + esc(e.note.toLowerCase()) + ')'; }).join('; ') : 'none';
    };
    $('#nodeDetail').innerHTML = '<h3>Account ' + esc(n.label) + '</h3><p>' + esc(n.text) + '</p>' +
      '<p class="small"><strong>Incoming:</strong> ' + f(inE, 'from') + '<br><strong>Outgoing:</strong> ' + f(outE, 'to') + '</p>' +
      '<p class="small">A link in this graph does not prove wrongdoing.</p>';
  }

  /* ---------- Explainability & fairness ---------- */
  function renderLatestSignals() {
    var box = $('#latestSignals');
    if (!lastResult) return;
    var r = lastResult.r;
    if (!r.signals.length) { box.innerHTML = '<p>No contributing signals for your latest check (' + badge(r.category) + ').</p>'; return; }
    var max = Math.max.apply(null, r.signals.map(function (s) { return s.points; }).concat([20]));
    box.innerHTML = '<p>Latest check: ' + badge(r.category) + ' · demo score ' + r.score + '/100. Each bar shows points added by a signal.</p>' +
      r.signals.map(function (s) {
        return '<div class="bar-row"><span>' + esc(s.label) + '</span>' +
          '<div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:' + Math.round(s.points / max * 100) + '%"></div></div>' +
          '<span class="bar-val">+' + s.points + ' points · ' + esc(S.GROUPS[s.group]) + '</span></div>';
      }).join('');
  }
  function renderCatalog() {
    $('#catalogBody').innerHTML = S.CATALOG.map(function (c) {
      return '<tr><td>' + esc(c.label) + '</td><td>' + esc(S.GROUPS[c.group]) + '</td><td class="num">' + esc(c.points) + '</td><td>' + esc(c.desc) + '</td></tr>';
    }).join('');
  }
  function renderFairness() {
    var overall = D.FAIRNESS.overall;
    $('#overallRate').textContent = overall + '% (demo)';
    var maxRate = 8;
    $('#fairness').innerHTML = D.FAIRNESS.groups.map(function (g) {
      return '<h3 class="group-title">' + esc(g.title) + '</h3>' + g.rows.map(function (r) {
        var gap = Math.round((r.rate - overall) * 10) / 10;
        var flagged = gap >= 1;
        var gapText = (gap > 0 ? '+' : '') + gap + ' pts vs overall';
        return '<div class="bar-row"><span>' + esc(r.label) + '</span>' +
          '<div class="bar-track" aria-hidden="true"><div class="bar-fill' + (flagged ? ' gap' : '') + '" style="width:' + Math.round(r.rate / maxRate * 100) + '%"></div></div>' +
          '<span class="bar-val">' + r.rate + '% · ' + gapText + (flagged ? ' <span class="flag">· gap to investigate</span>' : '') + '</span></div>';
      }).join('');
    }).join('') +
      '<p class="small">A gap of 1 percentage point or more is marked for investigation in this demo. In practice teams would also examine why gaps exist and whether rules or thresholds need to change.</p>';
  }

  /* ---------- Init ---------- */
  function init() {
    // Score synthetic transactions
    Promise.all(D.TRANSACTIONS.map(function (t) {
      return S.scoreTransaction(t).then(function (r) { return Object.assign({}, t, { result: r }); });
    })).then(function (list) {
      scored = list;
      renderDashboard();
      renderAlerts();
    });

    populateSamples();
    renderNetwork();
    renderCatalog();
    renderFairness();

    $$('.nav-btn').forEach(function (b) {
      b.addEventListener('click', function () { showView(b.dataset.view, true); });
    });

    $('#checkForm').addEventListener('submit', onSubmit);
    $('#paymentType').addEventListener('change', syncTypeFields);
    $('#loadSample').addEventListener('click', function () { loadSample($('#sampleSelect').value); });
    $('#resetForm').addEventListener('click', function () {
      $('#checkForm').reset();
      syncTypeFields();
      $('#sampleNote').textContent = '';
      $('#formError').textContent = '';
      $('#result').innerHTML = '<p class="placeholder">Fill in the form or load a sample, then choose “Check this payment”. Your estimate will appear here.</p>';
    });

    $('#filterBar').addEventListener('click', function (e) {
      var btn = e.target.closest('.chip');
      if (!btn) return;
      filter = btn.dataset.filter;
      $$('.chip').forEach(function (c) { c.setAttribute('aria-pressed', c === btn ? 'true' : 'false'); });
      renderAlerts();
    });

    $('#alertList').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-open]');
      if (!btn) return;
      var id = btn.getAttribute('data-open');
      showView('checker', true);
      $('#sampleSelect').value = id;
      loadSample(id);
      var t = scored.filter(function (x) { return x.id === id; })[0];
      if (t) { lastResult = { r: t.result, t: t }; renderResult(t.result, t); }
    });

    window.addEventListener('hashchange', function () { showView(location.hash.replace('#', ''), false); });
    showView(location.hash.replace('#', '') || 'dashboard', false);
  }

  document.addEventListener('DOMContentLoaded', init);
})();

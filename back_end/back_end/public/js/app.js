/* UI logic: navigation, rendering, form handling. */
(function () {
  'use strict';

  var D = window.UPIDemo.data;
  var S = window.UPIDemo.scoring;

  var inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
  var TYPE_LABEL = { upi: 'UPI payment', collect: 'Collect request', qr: 'QR payment' };
  var VIEWS = ['dashboard', 'checker', 'alerts', 'network', 'explain'];
  var NETWORK = D.NETWORK;
  var latestMetrics = null;
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
      card('Payments checked', scored.length, 'Saved in local SQLite storage') +
      card('High-risk alerts', high, 'Prompts to pause and verify; nothing is blocked') +
      card('Review alerts', review, 'Prompts to double-check details') +
      card('Measured false-alert rate', latestMetrics && latestMetrics.metrics && latestMetrics.metrics.falsePositiveRate != null ? (latestMetrics.metrics.falsePositiveRate * 100).toFixed(1) + '%' : 'Not enough labels', 'Calculated only from reviewer-confirmed legitimate samples') +
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
        '<button type="button" class="btn btn-secondary" data-open="' + esc(t.id) + '">Open in checker</button> ' +
        '<span class="small">Reviewer label: ' + esc(t.reviewLabel || 'unreviewed') + '</span> ' +
        '<button type="button" class="btn btn-secondary" data-label-id="' + esc(t.id) + '" data-label="fraud">Confirm fraud</button> ' +
        '<button type="button" class="btn btn-secondary" data-label-id="' + esc(t.id) + '" data-label="legitimate">Confirm legitimate</button></li>';
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
      '<div class="meter-scale" aria-hidden="true"><span>0 Low</span><span>' + (r.thresholds ? r.thresholds.review : 35) + ' Review</span><span>' + (r.thresholds ? r.thresholds.high : 70) + ' High</span><span>100</span></div>' +
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
      return refreshBackendData();
    }).catch(function (error) {
      err.textContent = 'Could not check this payment: ' + error.message + ' Make sure the backend is running.';
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
  function nodeById(id) { return NETWORK.nodes.filter(function (n) { return n.id === id; })[0]; }
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

    NETWORK.edges.forEach(function (e) {
      var a = nodeById(e.from), b = nodeById(e.to);
      var dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy);
      var ux = dx / len, uy = dy / len;
      var line = svgEl('line', {
        x1: a.x + ux * R, y1: a.y + uy * R, x2: b.x - ux * (R + 6), y2: b.y - uy * (R + 6),
        'class': 'e-' + e.pattern, 'marker-end': 'url(#arrow)'
      });
      svg.appendChild(line);
    });
    NETWORK.edges.forEach(function (e) {
      var a = nodeById(e.from), b = nodeById(e.to);
      var t = svgEl('text', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 6, 'text-anchor': 'middle', 'class': 'edge-label' });
      t.textContent = inr.format(e.amount);
      svg.appendChild(t);
    });

    NETWORK.nodes.forEach(function (n) {
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

    $('#edgeBody').innerHTML = NETWORK.edges.map(function (e) {
      return '<tr><td>' + esc(nodeById(e.from).label) + '</td><td>' + esc(nodeById(e.to).label) + '</td><td class="num">' +
        inr.format(e.amount) + '</td><td>' + esc(e.note) + '</td></tr>';
    }).join('');
  }
  function selectNode(id) {
    var n = nodeById(id);
    $$('#graph .node').forEach(function (g) { g.classList.toggle('selected', g.getAttribute('data-id') === id); });
    var inE = NETWORK.edges.filter(function (e) { return e.to === id; });
    var outE = NETWORK.edges.filter(function (e) { return e.from === id; });
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
    Promise.all([
      fetch('/api/fairness').then(function (r) { return r.json(); }),
      fetch('/api/metrics').then(function (r) { return r.json(); }),
      fetch('/api/drift').then(function (r) { return r.json(); }),
      fetch('/api/calibration').then(function (r) { return r.json(); })
    ]).then(function (parts) {
      var fairness = parts[0], metrics = parts[1], drift = parts[2], calibration = parts[3];
      var dimensions = fairness.dimensions || {};
      var title = { regionType: 'Region type', deviceTier: 'Device tier', appLanguage: 'App language', upiExperience: 'UPI experience' };
      var groups = [];
      Object.keys(dimensions).forEach(function (key) {
        if (dimensions[key] && dimensions[key].length) {
          groups.push('<h3 class="group-title">' + esc(title[key] || key) + '</h3>' + dimensions[key].map(function (item) {
            var rate = item.falseAlertRate * 100;
            return '<div class="bar-row"><span>' + esc(item.group) + '</span>' +
              '<div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:' + Math.min(100, Math.round(rate)) + '%"></div></div>' +
              '<span class="bar-val">' + rate.toFixed(1) + '% · n=' + item.sampleSize + '</span></div>';
          }).join(''));
        }
      });
      $('#overallRate').textContent = drift.status + (drift.psi == null ? '' : ' · PSI ' + drift.psi);
      var html = groups.length ? groups.join('') : '<p class="notice">No sufficiently large reviewer-labelled audit groups are available yet. The dashboard will not invent fairness percentages. Optional audit dimensions are metadata only and never influence the risk score.</p>';
      html += '<h3 class="group-title">Label-based model evaluation</h3>';
      html += '<p class="small">Reviewer-labelled transactions: ' + metrics.labelledTransactions + ' · Confirmed fraud: ' + metrics.classDistribution.fraud + ' · Confirmed legitimate: ' + metrics.classDistribution.legitimate + '</p>';
      if (metrics.metrics) {
        var m = metrics.metrics;
        html += '<p>Precision: ' + (m.precision * 100).toFixed(1) + '% · Recall: ' + (m.recall * 100).toFixed(1) + '% · False-positive rate: ' + (m.falsePositiveRate * 100).toFixed(1) + '% · F2: ' + (m.f2 * 100).toFixed(1) + '% · PR-AUC: ' + (m.prAuc == null ? 'N/A' : (m.prAuc * 100).toFixed(1) + '%') + '</p>';
      } else {
        html += '<p class="notice">' + esc(metrics.note) + '</p>';
      }
      html += '<h3 class="group-title">Score-distribution drift</h3>';
      html += '<p>Status: <strong>' + esc(drift.status) + '</strong>' + (drift.psi == null ? '' : ' · PSI ' + drift.psi) + '</p>';
      html += '<p class="small">' + esc(drift.note || '') + '</p>';
      if (drift.status === 'watch' || drift.status === 'drift') {
        html += '<button type="button" class="btn btn-secondary" data-rebaseline>Approve new drift baseline</button> ';
      }
      html += '<h3 class="group-title">Imbalance-aware threshold calibration</h3>';
      if (calibration.ready && calibration.recommendation) {
        html += '<p>Suggested Review threshold: <strong>' + calibration.recommendation.reviewThreshold + '</strong> · F2: ' + (calibration.recommendation.f2 * 100).toFixed(1) + '% · FPR: ' + (calibration.recommendation.falsePositiveRate * 100).toFixed(1) + '%</p>';
        html += '<p class="small">' + esc(calibration.note) + '</p>';
        html += '<button type="button" class="btn btn-secondary" data-calibrate>Apply suggested Review threshold</button>';
      } else {
        html += '<p class="small">' + esc(calibration.note) + '</p>';
      }
      html += '<p class="small">' + esc(fairness.note || '') + '</p>';
      $('#fairness').innerHTML = html;
    }).catch(function () {
      $('#overallRate').textContent = 'API unavailable';
      $('#fairness').innerHTML = '<p class="notice">Fairness and monitoring metrics could not be loaded from the backend.</p>';
    });
  }

  function refreshBackendData() {
    return Promise.all([
      fetch('/api/transactions?limit=100').then(function (r) { if (!r.ok) throw new Error('Transactions API unavailable'); return r.json(); }),
      fetch('/api/metrics').then(function (r) { if (!r.ok) throw new Error('Metrics API unavailable'); return r.json(); })
    ]).then(function (parts) {
      scored = parts[0].transactions || [];
      latestMetrics = parts[1];
      renderDashboard();
      renderAlerts();
      if (location.hash === '#explain') renderLatestSignals();
      return scored;
    });
  }

  function connectEventStream() {
    if (!window.EventSource) return;
    var stream = new EventSource('/api/events');
    stream.addEventListener('transaction', function () { refreshBackendData(); renderFairness(); });
    stream.addEventListener('batch', function () { refreshBackendData(); renderFairness(); });
    stream.addEventListener('alert', function () { refreshBackendData(); });
    stream.addEventListener('label', function () { refreshBackendData(); renderFairness(); });
    stream.addEventListener('labels', function () { refreshBackendData(); renderFairness(); });
    stream.addEventListener('drift', function () { refreshBackendData(); });
  }

  /* ---------- Init ---------- */
  function init() {
    // Load persistent server-side history. Sample options remain local form templates
    // and are only stored after the user submits a payment check.
    refreshBackendData().catch(function () {
      $('#summaryCards').innerHTML = card('Backend status', 'Unavailable', 'Start the Node.js server to load saved data');
    });

    populateSamples();
    fetch('/api/network').then(function (r) { if (!r.ok) throw new Error('Network API unavailable'); return r.json(); })
      .then(function (data) { NETWORK = data; renderNetwork(); })
      .catch(function () { renderNetwork(); });
    renderCatalog();
    renderFairness();
    connectEventStream();

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

    $('#fairness').addEventListener('click', function (e) {
      var button = e.target.closest('[data-calibrate], [data-rebaseline]');
      if (!button) return;
      var path = button.hasAttribute('data-calibrate') ? '/api/calibration/apply' : '/api/drift/rebaseline';
      button.disabled = true;
      fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function (r) { return r.json().then(function (data) { if (!r.ok) throw new Error(data.error || 'Action could not be completed'); return data; }); })
        .then(function () { renderFairness(); refreshBackendData(); })
        .catch(function (error) { button.disabled = false; window.alert(error.message); });
    });

    $('#alertList').addEventListener('click', function (e) {
      var labelBtn = e.target.closest('[data-label-id]');
      if (labelBtn) {
        var labelId = labelBtn.getAttribute('data-label-id');
        var label = labelBtn.getAttribute('data-label');
        labelBtn.disabled = true;
        fetch('/api/transactions/' + encodeURIComponent(labelId) + '/label', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: label })
        }).then(function (r) { return r.json().then(function (data) { if (!r.ok) throw new Error(data.error || 'Could not save label'); return data; }); })
          .then(function () { return refreshBackendData(); })
          .then(function () { renderFairness(); })
          .catch(function (error) { labelBtn.disabled = false; window.alert(error.message); });
        return;
      }
      var btn = e.target.closest('[data-open]');
      if (!btn) return;
      var id = btn.getAttribute('data-open');
      showView('checker', true);
      $('#sampleSelect').value = id;
      loadSample(id);
      var t = scored.filter(function (x) { return x.id === id; })[0];
      if (t) {
        var formValue = Object.assign({}, t.flags || {}, {
          amount: t.amount, paymentType: t.paymentType, recipientName: t.recipientName,
          recipientId: '', impersonation: (t.flags && t.flags.impersonation) || 'none',
          qrDisplayed: (t.flags && t.flags.qrDisplayed) || '', qrActual: (t.flags && t.flags.qrActual) || ''
        });
        fillForm($('#checkForm'), formValue);
        lastResult = { r: t.result, t: t };
        renderResult(t.result, formValue);
      }
    });

    window.addEventListener('hashchange', function () { showView(location.hash.replace('#', ''), false); });
    showView(location.hash.replace('#', '') || 'dashboard', false);
  }

  document.addEventListener('DOMContentLoaded', init);
})();

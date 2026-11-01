'use strict';

const { randomUUID } = require('node:crypto');

function analyseAccount(db, ref, now = Date.now()) {
  const since = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const inbound = db.prepare(`SELECT * FROM graph_edges WHERE recipient_ref=? AND occurred_at>=? ORDER BY occurred_at`)
    .all(ref, since);
  const outbound = db.prepare(`SELECT * FROM graph_edges WHERE sender_ref=? AND occurred_at>=? ORDER BY occurred_at`)
    .all(ref, since);
  const inboundSenders = new Set(inbound.map(e => e.sender_ref));
  const outboundRecipients = new Set(outbound.map(e => e.recipient_ref));
  const quick = new Map();
  for (const edge of outbound) {
    const tOut = Date.parse(edge.occurred_at);
    const followsInbound = inbound.some(inEdge => {
      const delta = tOut - Date.parse(inEdge.occurred_at);
      return delta >= 0 && delta <= 30 * 60 * 1000;
    });
    if (followsInbound) quick.set(edge.id, edge);
  }
  const quickEdges = [...quick.values()];
  const received = inbound.reduce((s, e) => s + Number(e.amount), 0);
  const quicklyForwarded = quickEdges.reduce((s, e) => s + Number(e.amount), 0);
  const ratio = received > 0 ? quicklyForwarded / received : 0;
  const quickRecipients = new Set(quickEdges.map(e => e.recipient_ref));

  const signals = [];
  if (inboundSenders.size >= 3) {
    signals.push({ id: 'graphSharedReceiver', label: 'Multiple independent accounts paid the same recipient',
      points: 18, group: 'graph', detail: `${inboundSenders.size} distinct sending accounts paid this node within 24 hours.` });
  }
  if (quickEdges.length > 0 && ratio >= 0.65) {
    signals.push({ id: 'graphRapidPassThrough', label: 'Rapid onward-transfer pattern',
      points: 22, group: 'graph', detail: `${Math.round(ratio * 100)}% of observed incoming value was followed by outbound transfers within 30 minutes. This heuristic is not proof.` });
  }
  if (quickRecipients.size >= 3) {
    signals.push({ id: 'graphFanOut', label: 'Rapid fan-out to several recipients',
      points: 15, group: 'graph', detail: `Rapid onward transfers went to ${quickRecipients.size} distinct recipients.` });
  }
  return {
    ref,
    inboundCount: inbound.length,
    outboundCount: outbound.length,
    uniqueSenders: inboundSenders.size,
    uniqueRecipients: outboundRecipients.size,
    rapidRecipients: quickRecipients.size,
    receivedAmount: Math.round(received * 100) / 100,
    rapidOutAmount: Math.round(quicklyForwarded * 100) / 100,
    rapidOutRatio: Math.round(ratio * 1000) / 1000,
    signals
  };
}

function graphSignalsForTransaction(db, senderRef, recipientRef) {
  const a = analyseAccount(db, senderRef);
  const b = analyseAccount(db, recipientRef);
  const all = [...a.signals, ...b.signals];
  // Avoid duplicate signal types if both endpoints exhibit the same pattern.
  const unique = new Map();
  for (const s of all) {
    const previous = unique.get(s.id);
    if (!previous || s.points > previous.points) unique.set(s.id, s);
  }
  return { signals: [...unique.values()], sender: a, recipient: b };
}

function snapshot(db, limit = 250) {
  const edges = db.prepare(`SELECT * FROM graph_edges ORDER BY occurred_at DESC LIMIT ?`).all(limit).reverse();
  const nodeRefs = new Set();
  for (const e of edges) { nodeRefs.add(e.sender_ref); nodeRefs.add(e.recipient_ref); }
  const storedNodes = db.prepare('SELECT * FROM graph_nodes').all();
  const nodeMap = new Map(storedNodes.filter(n => nodeRefs.has(n.ref)).map(n => [n.ref, n]));
  const incoming = new Map(), outgoing = new Map();
  for (const ref of nodeRefs) { incoming.set(ref, []); outgoing.set(ref, []); }
  for (const e of edges) {
    incoming.get(e.recipient_ref)?.push(e);
    outgoing.get(e.sender_ref)?.push(e);
  }

  const dynamicRefs = [...nodeRefs].filter(ref => !nodeMap.has(ref));
  const allRefs = [...nodeRefs];
  const dynamicPositions = new Map();
  const layers = { source: [], hub: [], relay: [], out: [] };
  for (const ref of dynamicRefs) {
    const indeg = incoming.get(ref)?.length || 0;
    const outdeg = outgoing.get(ref)?.length || 0;
    const role = indeg === 0 ? 'source' : outdeg === 0 ? 'out' : outdeg >= 2 ? 'relay' : 'hub';
    layers[role].push(ref);
  }
  const xByRole = { source: 90, hub: 320, relay: 520, out: 720 };
  for (const role of Object.keys(layers)) {
    layers[role].forEach((ref, i) => {
      dynamicPositions.set(ref, { x: xByRole[role], y: 55 + (i + 1) * (320 / (layers[role].length + 1)), role });
    });
  }

  const nodes = allRefs.map(ref => {
    const stored = nodeMap.get(ref);
    const pos = dynamicPositions.get(ref) || {};
    const inc = incoming.get(ref) || [], out = outgoing.get(ref) || [];
    const short = ref.startsWith('seed:') ? ref.slice(5) : ref.slice(-5);
    const label = stored?.label || `Account ${short}`;
    const inAmount = inc.reduce((s, e) => s + e.amount, 0);
    const outAmount = out.reduce((s, e) => s + e.amount, 0);
    const description = stored?.description ||
      `Observed ${inc.length} incoming and ${out.length} outgoing synthetic/authorized links. A network connection is not evidence of wrongdoing.`;
    return {
      id: ref, label, role: stored?.role || pos.role || 'hub',
      x: stored?.x ?? pos.x ?? 400, y: stored?.y ?? pos.y ?? 215, text: description,
      stats: { incoming: inc.length, outgoing: out.length, receivedAmount: inAmount, sentAmount: outAmount }
    };
  });

  const edgesOut = edges.map(e => {
    const priorIncoming = edges.some(x => x.recipient_ref === e.sender_ref &&
      Date.parse(e.occurred_at) >= Date.parse(x.occurred_at) &&
      Date.parse(e.occurred_at) - Date.parse(x.occurred_at) <= 30 * 60 * 1000);
    const samePairCount = edges.filter(x => x.sender_ref === e.sender_ref && x.recipient_ref === e.recipient_ref).length;
    const pattern = priorIncoming ? 'rapid' : samePairCount > 1 ? 'normal' : 'new';
    return {
      id: e.id, from: e.sender_ref, to: e.recipient_ref,
      amount: Number(e.amount), pattern,
      note: e.note || (pattern === 'rapid' ? 'Rapid onward transfer' : pattern === 'new' ? 'New link' : 'Repeated link')
    };
  });
  return { nodes, edges: edgesOut, generatedAt: new Date().toISOString(), note: 'Includes an illustrative synthetic network seed. User-submitted edges are stored separately from demo dashboard totals.' };
}

function ensureGraphNode(db, ref, role, name) {
  const row = db.prepare('SELECT ref FROM graph_nodes WHERE ref=?').get(ref);
  if (row) return;
  const suffix = ref.slice(-5);
  db.prepare(`INSERT INTO graph_nodes(ref,label,role,description,x,y,demo_seed) VALUES(?,?,?,?,NULL,NULL,0)`)
    .run(ref, `Account ${suffix}`, role, 'Pseudonymous graph node derived from a one-way account-reference hash.');
}

function insertGraphEdge(db, { eventId, occurredAt, senderRef, recipientRef, amount, note = '' }) {
  ensureGraphNode(db, senderRef, 'source', 'sender');
  ensureGraphNode(db, recipientRef, 'hub', 'recipient');
  db.prepare(`INSERT OR IGNORE INTO graph_edges(id,event_id,occurred_at,sender_ref,recipient_ref,amount,note,demo_seed)
    VALUES(?,?,?,?,?,?,?,0)`).run(randomUUID(), eventId, occurredAt, senderRef, recipientRef, amount, note);
}

module.exports = { analyseAccount, graphSignalsForTransaction, snapshot, insertGraphEdge };

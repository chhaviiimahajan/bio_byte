# SafeUPI Check — integrated backend prototype

This project preserves the uploaded frontend and connects it to a local API and persistent SQLite database. It is an educational prototype using synthetic or properly authorized data only.

## What changed from the uploaded frontend

- `public/index.html` and `public/css/styles.css` retain your original interface.
- `public/js/data.js` retains the fictional user profile, sample form transactions, and illustrative seed graph.
- `public/js/scoring.js` is now an API adapter; it submits transactions to the server instead of scoring inside the browser.
- `public/js/app.js` loads saved transactions, graph data, fairness/quality metrics, and reviewer labels from the backend. It refreshes on Server-Sent Events.
- `server.js` provides the HTTP API and serves the frontend from the same origin.
- `src/` contains the scoring, graph, persistence, metrics, and transaction service modules.

## Requirements and run

- Node.js **22.5 or newer** (the implementation uses Node's built-in `node:sqlite`; Node may print an experimental-feature warning depending on the release).
- No external npm packages are required.

From this folder:

```bash
npm start
```

Open `http://127.0.0.1:3000` in your browser. Health check: `http://127.0.0.1:3000/api/health`.

Generate a fully fictional, deliberately imbalanced 100-transaction dataset (5 fraud / 95 legitimate) for the dashboard, drift monitor, class metrics, and group audit: start the server in one terminal, then run this in another:

```bash
npm run demo:seed
```

The generator adds synthetic labels and optional audit dimensions. These figures are for demonstrating the workflow only, not evidence of real-world model performance.

Run tests:

```bash
npm test
```

For development auto-restart:

```bash
npm run dev
```

The SQLite database is created automatically at `data/safeupi.sqlite`. It uses WAL mode and survives application restarts. Back up the database file while the application is stopped, or use SQLite's online backup facilities for a live deployment.

## Main API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | API and storage health |
| POST | `/api/check` | Score, explain, and persist one payment check |
| POST | `/api/stream/transactions` | Ingest a batch of 1–100 synthetic/authorized events |
| GET | `/api/dashboard` | Dashboard totals and recent saved transactions |
| GET | `/api/transactions` | Saved transaction history |
| GET | `/api/alerts` | Open risk and drift alerts |
| PATCH | `/api/alerts/:id/status` | Mark an alert OPEN, ACKNOWLEDGED, or CLOSED |
| GET | `/api/network` | Stored graph links and derived network view |
| GET | `/api/explainability` | Scoring catalogue, thresholds, and guardrails |
| GET | `/api/drift` | Score-distribution drift monitor |
| POST | `/api/drift/rebaseline` | Manually approve a new score-distribution baseline |
| POST | `/api/transactions/:id/label` | Store one reviewer-confirmed fraud/legitimate label |
| POST | `/api/feedback/labels` | Store a batch of 1–100 reviewer labels |
| GET | `/api/metrics` | Precision, recall, F2, FPR and PR-AUC when label support is adequate |
| GET | `/api/calibration` | Imbalance-aware threshold recommendation |
| POST | `/api/calibration/apply` | Explicitly apply a supported recommended review threshold |
| GET | `/api/fairness` | Aggregate false-alert rates for optional audit groups |
| GET | `/api/events` | Server-Sent Events for live frontend updates |

## Example: check one payment

```bash
curl -X POST http://127.0.0.1:3000/api/check \
  -H "Content-Type: application/json" \
  -d '{
    "eventId": "demo-event-001",
    "amount": 1200,
    "paymentType": "upi",
    "recipientName": "Demo Merchant",
    "recipientId": "merchant@demobank",
    "firstPayment": true,
    "urgency": false,
    "impersonation": "none"
  }'
```

The response contains a transaction ID, score, category, signal-by-signal explanations, recommendation, and graph evidence. `eventId` (or the `Idempotency-Key` request header) prevents duplicate ingestion on retries.

## Example: streaming batch ingestion

```bash
curl -X POST http://127.0.0.1:3000/api/stream/transactions \
  -H "Content-Type: application/json" \
  -d '{"transactions":[
    {"eventId":"stream-01","amount":950,"paymentType":"upi","recipientName":"Synthetic Account A","recipientId":"account-a@demo","senderRef":"sender-01"},
    {"eventId":"stream-02","amount":1100,"paymentType":"upi","recipientName":"Synthetic Account A","recipientId":"account-a@demo","senderRef":"sender-02"}
  ]}'
```

For graph testing, pass stable pseudonymous `senderRef` and `recipientId` values so the backend can connect multiple events into account nodes. The backend hashes these references before graph storage. The UI's form defaults to one fictional sender, because the supplied form does not collect a sender/account reference.

## Scoring and explainability

The backend preserves the existing demo rule concepts and initial bands (Review 35, High 70). It includes first-recipient, reported-recipient, amount-relative-to-own-baseline, behaviour-change, message, QR mismatch, and weak context signals. A High category requires at least two independent non-context signal groups. Context signals cannot independently produce High.

The graph engine examines a rolling 24-hour edge window. Demo heuristics look for a shared receiver with at least three distinct incoming senders, rapid onward movement within 30 minutes, and fan-out to multiple recipients. These are signals for human review, not mule-account determinations. The preloaded network graph is fictional and is excluded from dashboard payment totals.

## Storage and feedback

SQLite stores transactions, alerts, reviewer labels, graph links, drift events, drift baselines, and threshold configuration. It is local persistent storage, not a cloud database.

The Alerts section includes reviewer feedback controls. Use them only when an authorized reviewer has independent evidence. The feedback endpoint is:

```bash
curl -X POST http://127.0.0.1:3000/api/transactions/TRANSACTION_ID/label \
  -H "Content-Type: application/json" \
  -d '{"label":"legitimate","notes":"Verified by authorized reviewer"}'
```

Allowed labels are `fraud` and `legitimate`. The demo does not treat its own score as a ground-truth label.

## Drift and severe class imbalance

- `/api/drift` compares the latest 50 transaction score bands against an earlier window using Population Stability Index (PSI). It monitors **score-distribution drift only**, not concept drift or real fraud prevalence.
- Drift can raise a system alert for review. It does not automatically change risk thresholds or block transactions.
- `/api/metrics` uses confirmed labels and reports precision, recall, specificity, false-positive rate, F1, F2, and average precision (PR-AUC). It withholds the summary until at least 3 positive and 10 negative labels exist.
- `/api/calibration` recommends a review threshold using F2 with a false-positive-rate constraint. It requires at least 5 positive and 20 negative labels. Applying it is a separate explicit action; there is no automatic online threshold update.
- Drift rebaselining is manual and requires at least 50 transactions.

This is deliberately conservative: unlabeled score drift should prompt investigation, not cause a new threshold to silently punish legitimate users.

## Inclusion and fairness

Protected characteristics such as age, caste, religion, gender, disability, race, and ethnicity are rejected as request fields and are not scoring inputs. `auditDimensions` may optionally include one or more of `regionType`, `deviceTier`, `appLanguage`, and `upiExperience`; these are metadata only and never affect the score. The fairness endpoint reports group false-alert rates only when at least 20 confirmed legitimate samples exist in a group. No fabricated fairness percentages are displayed when support is insufficient.

Example authorized audit metadata:

```json
{
  "auditDimensions": {
    "regionType": "Rural",
    "deviceTier": "Entry-level phone",
    "appLanguage": "Hindi",
    "upiExperience": "New to UPI"
  }
}
```

Do not collect these dimensions without an appropriate lawful basis, notice, and data-minimization review.

## Important limitations before any real deployment

This is not connected to UPI, NPCI, a bank, a PSP, or payment rails. It does not authenticate a sender, verify a recipient, query a fraud-report registry, or stop payments. The supplied browser form contains user-reported flags; they are not independently observed telemetry. The rule engine and graph thresholds are illustrative and have not been trained or validated on real fraud data.

The local demo has no authentication or role-based access control. Before deployment, add identity and authorization, TLS, CSRF/CORS review, secrets management, encrypted backups, data retention controls, audit logging, abuse monitoring, load tests, privacy review, and independent model/fairness validation. Do not send real account details, UPI IDs, or credentials to this prototype.

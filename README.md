# GridSync: AI-Driven AWS Cloud for Smart EV Fast-Charging & Power Grid Management

**Team 4** · Anish P (24BCE2394) · Neeraj K (24BCE2393)

GridSync is a serverless AWS architecture that bridges utility **OpenADR** signals and charger **OCPP**
commands. Every control decision is made by **three machine-learning models**. All three are implemented
from scratch in JavaScript (no ML libraries) and trained live in the browser when the page opens.

## The AI components

| # | Model | Type | What it does | Held-out result |
|---|-------|------|--------------|-----------------|
| 1 | **Demand forecaster**: MLP 7→16→12→1, backprop + Adam | Supervised | Predicts next-hour site demand from time of day, weekday, temperature and recent load | MAE 148 kW vs 224 kW seasonal-naive (**34% lower error**), R² 0.81 |
| 2 | **Charging agent**: tabular Q-learning | Reinforcement | Chooses what share of transformer headroom to give EVs. The forecaster's trend is part of its state | On 30 unseen days: overloads **85 → 1** and EV peak **731 → 591 kW** vs a fixed cloud rule, at 91% of the energy |
| 3 | **Telemetry guard**: Isolation Forest (150 trees) | Unsupervised | Scores every OCPP/Kinesis message using physics features (P − V·I residual, limit compliance, cadence, voltage) | **89% attack recall** at a **0.4% false-positive rate** |

Numbers come from fixed random seeds and are reproduced every time the page loads (see the **AI Lab** section).

## Novel contributions

1. **Forecast-informed RL control.** A neural forecast feeds an RL agent that *learns* how much safety margin to keep, instead of using a hand-tuned limit.
2. **Security that acts on the grid.** When the Isolation Forest flags a charger, its IoT Core certificate is revoked and its power is reallocated in the same control cycle, so the cyber-security and grid-control loops are joined.
3. **Explainable decisions.** Every AI action is shown with its Q-values and the forecast's feature attributions, written out in plain language for auditability.
4. **OpenADR ⇄ OCPP in under 2 s** on a fully serverless AWS pipeline (API Gateway → Lambda → Step Functions → SageMaker endpoint → DynamoDB → IoT Core, with Kinesis → Timestream feeding back).

## Live demo

- **Three controllers on the same grid.** Compare *Static limits* (legacy), *Cloud rules* (AWS, no ML) and *GridSync AI*.
- **Evening rush.** Plugs a car into every bay at once. Static mode trips the feeder; the cloud modes keep the transformer under 100%.
- **Send OpenADR event.** Requests a 30% load cut, and the Step Functions pipeline (including SageMaker inference) animates with per-stage latency.
- **Simulate cyber attack.** Compromises a charger with limit bypass, false data injection or replay flooding. In AI mode the Isolation Forest detects and quarantines it. In the other modes it goes unseen.
- **Explainable AI panel.** Shows why the agent chose the current budget.
- **AI Lab.** Watch the loss curve, the RL reward curve, the learned policy heatmap and the anomaly-score histogram build up live, and retrain on demand.

The grid, the vehicles and the telemetry are simulated. The machine-learning models are real.

## Run locally

It is a static site with no build step. Open `index.html` directly, or serve the folder:

```bash
python -m http.server 8000
```

## Running on AWS

The `aws/` folder deploys the architecture to a real AWS account as one CloudFormation stack (`aws/template.yaml`).

```
8 chargers + transformer meter (sim/charger-sim.js, MQTT over mutual TLS, one X.509 cert each)
        │  gridsync/<thing>/telemetry
        ▼
AWS IoT Core ── IoT Rule ──► Amazon SQS ──► Lambda "telemetry-guard"
                                              │  Isolation Forest on every message
                                              │  2 of 3 flagged → IoT certificate set INACTIVE
                                              ▼
                                           DynamoDB (charger state, load time series, events)
                                              │  every ~4 s / on quarantine
                                              ▼
Utility ─► API Gateway POST /openadr ─► Step Functions EXPRESS "gridsync-control"
                                         ReadTransformerLoad → ReadChargerStatus → AIInference (MLP + RL)
                                         → ComputeLimits → WriteChargerState → PublishOcppCommands
                                              │  gridsync/<thing>/cmd  SetChargingProfile
                                              ▼
                                           AWS IoT Core ─► chargers obey the new limit

Dashboard: S3 + CloudFront ─► API Gateway GET /state ─► Lambda ─► DynamoDB
Ops: CloudWatch dashboard "GridSync", AWS Budget alert at $10/month
```

**Deploy** (needs the AWS CLI signed in, plus Node.js):

```bash
.\aws\scripts\deploy.ps1 -BudgetEmail you@example.com
```

```bash
cd sim; npm install; node charger-sim.js
```

Then open the CloudFront URL that the deploy prints, and go to **Live on AWS**.

**Tear everything down** (IoT things, certificates, stack, buckets):

```bash
.\aws\scripts\teardown.ps1
```

**Differences from the report, and why:**

| Report | Deployed | Reason |
|---|---|---|
| Kinesis Data Streams | IoT Rule → **SQS** → Lambda | The account's organization policy (SCP) denies Kinesis. SQS gives the same batched, buffered stream into Lambda. |
| Amazon Timestream | **DynamoDB** time-series items with TTL | Timestream LiveAnalytics no longer accepts new customers, and it is also denied by the SCP. |
| SageMaker endpoint | Models trained offline (`aws/scripts/export-models.js`), weights stored in S3 and served inside Lambda | An always-on endpoint costs money 24/7. Inference stays inside the < 2 s Step Functions path. |
| Region ap-south-1 | **ap-southeast-2 (Sydney)** | The organization policy only allows this region. |

## Deploy as a static site only

- **Hostinger:** hPanel → File Manager → upload all `.html`, `.css` and `.js` files into `public_html`.
- **GitHub Pages:** Settings → Pages → Deploy from branch → `main` / root.

## Files

| File | Purpose |
|------|---------|
| `ml.js` | ML toolkit written from scratch: MLP with backprop + Adam, Q-learning agent, Isolation Forest |
| `ai.js` | Grid model, training data, the three GridSync models, and their evaluation |
| `app.js` | Live simulation, the three control modes, attack simulation, explainable-AI panel, AI Lab charts |
| `aws-live.js` | "Live on AWS" control room that reads the deployed backend through API Gateway |
| `index.html`, `styles.css` | Page structure, theme and animations |
| `aws/template.yaml` | CloudFormation: IoT policy and rule, SQS, Lambda ×4, Step Functions, API Gateway, DynamoDB ×2, S3 + CloudFront, CloudWatch, Budget |
| `aws/lambda/` | Lambda code: `guard.js` (AI IDS), `control.js` (workflow steps), `openadr.js`, `api.js` |
| `aws/scripts/` | `export-models.js` (training job), `deploy.ps1`, `teardown.ps1` |
| `sim/charger-sim.js` | Edge simulator: 9 IoT things over MQTT/mTLS that obey OCPP commands |

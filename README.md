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

## Deploy

- **Hostinger:** hPanel → File Manager → upload all `.html`, `.css` and `.js` files into `public_html`.
- **GitHub Pages:** Settings → Pages → Deploy from branch → `main` / root.

## Files

| File | Purpose |
|------|---------|
| `ml.js` | ML toolkit written from scratch: MLP with backprop + Adam, Q-learning agent, Isolation Forest |
| `ai.js` | Grid model, training data, the three GridSync models, and their evaluation |
| `app.js` | Live simulation, the three control modes, attack simulation, explainable-AI panel, AI Lab charts |
| `index.html`, `styles.css` | Page structure, theme and animations |

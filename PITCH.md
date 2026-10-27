# GridSync: Pitch & Demo Script

**Team 4** · Anish P (24BCE2394) · Neeraj K (24BCE2393)
*About 4 minutes of talking, plus a live demo.*

---

## 1. The hook (20 s)

> "Go to any fast-charging hub at 6 PM. Five or six EVs plug in at once, each pulling 150 to 350 kilowatts from
> the same local transformer. That transformer was never designed for this. The voltage sags, the protection
> relay trips, and the whole feeder goes dark: chargers, shops and homes alike.
> The grid usually has enough power. What's missing is coordination."

## 2. The problem (30 s)

> "We broke this into four pillars:
> **one**, utilities speak OpenADR and chargers speak OCPP, and nothing connects them;
> **two**, today's backends take 15 to 30 seconds to react, while a relay trips in under one;
> **three**, every charger has a fixed power limit set on installation day;
> **four**, chargers sit on public cellular links, so a hacked charger is a way into the grid."

## 3. Our solution (40 s)

> "GridSync is a fully serverless AWS architecture. A utility signal hits **API Gateway**, **Lambda** translates
> OpenADR into OCPP, and **Step Functions** runs the decision: read the transformer from **Timestream**, read the
> chargers from **DynamoDB**, ask **SageMaker** what to do, and push new limits through **IoT Core** over
> mutual TLS. Meter data flows back through **Kinesis**, which closes the loop.
>
> What makes it more than a dashboard is that **every decision is made by three machine-learning models** that we
> implemented from scratch: a neural network, a reinforcement-learning agent and an anomaly detector."

## 4. Live demo (about 2 min)

Open the site. The AI Lab trains on page load and takes about 5 seconds.

| Step | Click | What to say | What happened in our run |
|---|---|---|---|
| 1 | Scroll to **AI Lab** | "These three models trained from scratch in the browser just now. No libraries, no pre-computed numbers." | All models trained ✓ |
| 2 | Point at the forecast chart | "The neural network predicts next-hour demand. On 20 days it never saw, its error is 34% lower than the 'same as yesterday' baseline." | MAE **148 kW** vs **224 kW**, R² **0.81** |
| 3 | Point at the RL table | "The RL agent learned from 6,000 simulated days how much safety margin to keep. Compared with a fixed cloud rule it cut overloads from 85 to 1." | Overloads **398 → 85 → 1**, peak **731 → 591 kW** |
| 4 | Dashboard → **Static limits** → **Evening rush** | "Legacy setup: every car pulls full power…" | Transformer hit **251%**, feeder **tripped twice** |
| 5 | **Send OpenADR event** (still static) | "…and the utility asks for a 30% cut, but there's no bridge to the chargers." | Response **24.1 s** (too late) |
| 6 | **🧠 GridSync AI** → **Evening rush** → **Send OpenADR** | "Now with GridSync. Watch the pipeline: SageMaker inference sits right in the decision path." | **0 trips**, max load **< 100%**, reaction **0.84 s** |
| 7 | **☠ Simulate cyber attack** | "A charger gets hacked: it ignores its limit and fakes its meter data. The Isolation Forest scores every message…" | Flagged in **~2 sim-min** (score 0.63 > 0.56) → **certificate revoked, power reallocated** |
| 8 | **Cloud rules** → **Simulate cyber attack** | "Same attack without the AI guard: nobody notices, and the feeder trips." | Attack **undetected**, **2 trips** (123%, 128%) |
| 9 | Point at **Explainable AI** | "And the AI can explain itself: these are the agent's Q-values, and this is what drove the forecast." | e.g. "Demand is falling… agent gives EVs the full headroom. EV budget = 452 kW." |

## 5. Novelty (30 s)

> "The research we surveyed splits three ways: cloud forecasting that can't act in real time, edge AI that's hard
> to audit, and security papers that never touch grid control. GridSync joins all of them:
> **one**, a forecast-informed RL controller that *learns* its safety margin;
> **two**, intrusion detection that *acts on the grid*, revoking the certificate and reallocating power in the same cycle;
> **three**, every AI decision is explainable;
> **four**, utility signal to charger command in under 2 seconds, fully serverless."

## 6. Close (10 s)

> "Fast enough to protect the grid, smart enough to use every spare kilowatt, and secure by design. Thank you."

---

## Measured results (from this run)

| Metric | Static (legacy) | Cloud rules (no ML) | **GridSync AI** |
|---|---|---|---|
| Feeder trips in live evening rush | 2 | 0–2 (2 with attack) | **0** |
| OpenADR reaction time | 24.1 s ✗ | < 1 s | **0.84 s** |
| Cyber attack detected | ✗ | ✗ | **✓ quarantined** |
| Overloads on 30 unseen days (RL eval) | 398 | 85 | **1** |
| EV demand peak (RL eval) | 2,000 kW | 731 kW | **591 kW** |
| Energy delivered (RL eval) | 165.8 MWh | 165.4 MWh | 151.1 MWh (91%) |

| Model | Held-out metric |
|---|---|
| MLP forecaster | MAE 148 kW · 34% better than seasonal-naive · R² 0.81 |
| Q-learning agent | −99% overloads, −19% EV peak vs fixed rule |
| Isolation Forest IDS | 89% recall · 0.4% false positives (FDI 100%, flooding 100%, limit bypass 66%) |

## Likely questions

- **"Is the data real?"** The grid and vehicles are simulated with a realistic daily load model. The ML is real: the models train in the browser, are tested on held-out data, and use fixed random seeds, so the numbers are reproducible.
- **"Why does the AI deliver less energy?"** That's the trade-off it learned. It gives up about 9% of the energy to remove 99% of overloads and 19% of the peak, which is what drives demand charges. Customers waiting a little longer is cheaper than a blackout.
- **"Why Isolation Forest?"** New attacks have no labels. Isolation Forest is unsupervised and finds messages that are easy to isolate. Physics features such as P ≠ V·I make tampered telemetry stand out.
- **"Why is limit bypass only 66%?"** If the charger's limit is already close to its rating, cheating changes almost nothing, so it looks normal. That's why we require 2 of 3 flagged messages, which keeps false alarms low.
- **"Why tabular Q-learning rather than deep RL?"** The state is small (1,152 states), so a table trains in about 1 second and every value can be inspected. That supports the explainability goal. Deep RL is the next step for multi-site control.
- **"How does it map to AWS?"** Training runs as nightly SageMaker jobs on Timestream data. Inference uses a SageMaker serverless endpoint called from Step Functions. The IDS is a Lambda consumer on Kinesis. Quarantine uses IoT Core `UpdateCertificate → INACTIVE`.

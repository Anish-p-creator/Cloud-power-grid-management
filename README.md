# GridSync: AWS Cloud Infrastructure for Smart EV Fast-Charging & Power Grid Management

**Team 4** · Anish P (24BCE2394) · Neeraj K (24BCE2393)

An animated, interactive dashboard for the case study. It simulates a fast-charging hub on a 1 MW
distribution transformer and shows how a serverless AWS pipeline (API Gateway → Lambda → Step Functions
→ DynamoDB / Timestream → IoT Core, with Kinesis and SageMaker closing the loop) keeps the feeder from tripping.

## What you can do on the dashboard

- **Switch modes.** *Static limits (baseline)* is the traditional setup with a fixed power ceiling per charger. *GridSync AWS control* recalculates every charger's limit each cycle.
- **Evening rush.** Plugs a car into every bay at once. In static mode the transformer goes past 100% and the feeder trips. In GridSync mode the load stays under the 950 kW safe ceiling.
- **Send an OpenADR event.** Asks for a 30% site load reduction for 20 minutes. The Step Functions panel animates each stage and shows the end-to-end reaction time (target < 2 s).
- **Watch the live KPIs.** Transformer load, reaction time, peak-demand saving against the uncoordinated baseline, trip count and IoT Core connections.
- **Explore the architecture.** Click any AWS service in the diagram to see its role and which problem pillar it solves.
- **Read the literature timeline and use the cost estimator** (2020–2026 survey; serverless vs. always-on cost).

All data is simulated in the browser. Nothing calls real AWS services.

## Run locally

It is a static site with no build step. Open `index.html` directly, or serve the folder:

```bash
python -m http.server 8000
```

Then visit http://localhost:8000.

## Deploy

- **Hostinger:** hPanel → File Manager → upload `index.html`, `styles.css` and `app.js` into `public_html`.
- **GitHub Pages:** Settings → Pages → Deploy from branch → `main` / root.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page structure: hero, dashboard, problem, architecture, research, security & cost |
| `styles.css` | Theme, layout and animations (responsive, respects reduced-motion) |
| `app.js` | Grid and charger simulation, allocation algorithm, charts, interactions |

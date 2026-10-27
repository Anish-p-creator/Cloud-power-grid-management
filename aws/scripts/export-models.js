/* Trains the three GridSync models (same code as the website) and exports
   their learned parameters to aws/lambda/models.json for the Lambda functions.
   In production this is the SageMaker training job; here it runs locally.
   Usage: node aws/scripts/export-models.js */
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "../..");
require(path.join(root, "ml.js"));
require(path.join(root, "ai.js"));
const { forecaster, agent, guard } = globalThis.GridAI;

const t0 = Date.now();
forecaster.build();
for (const _ of forecaster.trainSteps());
agent.reset();
for (const _ of agent.trainSteps());
guard.train();

const r = (x) => Math.round(x * 1e5) / 1e5;
const tree = (n) => (n.size !== undefined ? { s: n.size } : { f: n.f, t: r(n.split), l: tree(n.left), r: tree(n.right) });

const out = {
  version: 1,
  trainedAt: new Date().toISOString(),
  mlp: {
    sizes: forecaster.model.sizes,
    W: forecaster.model.W.map((w) => Array.from(w, r)),
    b: forecaster.model.b.map((b) => Array.from(b, r)),
    baseline: forecaster.baseline.map(r),
  },
  q: { nS: agent.q.nS, nA: agent.q.nA, Q: Array.from(agent.q.Q, r) },
  forest: { c: guard.forest.c, threshold: guard.threshold, trees: guard.forest.trees.map(tree) },
  metrics: { forecast: forecaster.metrics, rl: agent.results, ids: guard.metrics },
};

const file = path.join(root, "aws", "lambda", "models.json");
fs.writeFileSync(file, JSON.stringify(out));
console.log(`models.json written (${(fs.statSync(file).size / 1024).toFixed(0)} KB) in ${Date.now() - t0} ms`);
console.log(`forecast MAE ${out.metrics.forecast.mae.toFixed(1)} kW · RL overloads ${out.metrics.rl.ai.overloads} · IDS recall ${(out.metrics.ids.recall * 100).toFixed(0)}%`);

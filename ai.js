/* GridSync AI: the three learning components of the project.
   1. Forecaster  - neural network (MLP) that predicts next-hour site demand  (SageMaker training job)
   2. Agent       - Q-learning RL policy that sets the EV power budget        (SageMaker endpoint / Lambda)
   3. Guard       - Isolation Forest that scores every telemetry message      (Kinesis consumer, zero-trust)
   All training data is synthetic, generated from the same grid model as the live dashboard. */
(function (root) {
  "use strict";
  const { rng, randn, poisson, MLP, QAgent, IsolationForest } = root.ML;
  const gauss = (x, mu, sd) => Math.exp(-((x - mu) ** 2) / (2 * sd * sd));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------------- Shared grid world ----------------
  const W = {
    RATED: 1000,
    SAFE: 950,
    weekend: (day) => day % 7 >= 5,
    temp: (day, h) => 31 + 4.5 * Math.sin(((h - 9) / 24) * 2 * Math.PI) + 3 * Math.sin(day * 0.9),
    base(h, day) {
      const we = W.weekend(day);
      return 230 + 140 * gauss(h % 24, 8.5, 1.8) * (we ? 0.6 : 1) + 380 * gauss(h % 24, 19, 2.2) + 14 * (W.temp(day, h) - 31);
    },
    arrival(h, day) { // expected EV arrivals per minute
      const we = W.weekend(day);
      return 0.012 + 0.11 * gauss(h % 24, 18.2, 1.6) * (we ? 0.75 : 1) + 0.04 * gauss(h % 24, 12.5, 2) * (we ? 1.6 : 1);
    },
  };

  // ======================================================================
  // 1. Demand forecaster (MLP 7-16-12-1)
  // ======================================================================
  const FEATURES = ["hour (sin)", "hour (cos)", "weekend", "temperature", "load now", "load 24h ago", "EV demand now"];

  function genHistory(days, seed = 42) {
    const r = rng(seed);
    const rows = [];
    let ev = 120;
    for (let d = 0; d < days; d++) {
      for (let h = 0; h < 24; h++) {
        const base = W.base(h + 0.5, d) + randn(r) * 18;
        const sessions = poisson(r, W.arrival(h + 0.5, d) * 60 * 1.3);
        ev = Math.min(2000, 0.3 * ev + sessions * (60 + r() * 80));
        rows.push({ d, h, base, ev, total: base + ev });
      }
    }
    return rows;
  }

  function featurize(d1, h1, totalNow, totalYday, evNow) {
    return [
      Math.sin((2 * Math.PI * h1) / 24), Math.cos((2 * Math.PI * h1) / 24),
      W.weekend(d1) ? 1 : 0, (W.temp(d1, h1 + 0.5) - 31) / 5,
      totalNow / 1000, totalYday / 1000, evNow / 1000,
    ];
  }

  const forecaster = {
    FEATURES,
    history: null,
    model: null,
    metrics: null,
    lossCurve: [],
    build(days = 120, testDays = 20) {
      this.history = genHistory(days);
      const X = [], Y = [], meta = [];
      for (let t = 24; t < this.history.length - 1; t++) {
        const nx = this.history[t + 1], now = this.history[t];
        X.push(featurize(nx.d, nx.h, now.total, this.history[t + 1 - 24].total, now.ev));
        Y.push(nx.total / 1000);
        meta.push({ yday: this.history[t + 1 - 24].total, last: now.total });
      }
      const split = X.length - testDays * 24;
      this.train = { X: X.slice(0, split), Y: Y.slice(0, split) };
      this.test = { X: X.slice(split), Y: Y.slice(split), meta: meta.slice(split) };
      this.baseline = FEATURES.map((_, i) => this.train.X.reduce((s, x) => s + x[i], 0) / this.train.X.length);
      this.model = new MLP([FEATURES.length, 16, 12, 1], 7);
      this.lossCurve = [];
    },
    *trainSteps(epochs = 60, batch = 32) {
      const r = rng(99);
      const idx = this.train.X.map((_, i) => i);
      for (let e = 0; e < epochs; e++) {
        for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
        let loss = 0, nb = 0;
        const lr = 0.006 * (1 - e / epochs) + 0.0008;
        for (let s = 0; s < idx.length; s += batch) {
          const bi = idx.slice(s, s + batch);
          loss += this.model.trainBatch(bi.map((i) => this.train.X[i]), bi.map((i) => this.train.Y[i]), lr);
          nb++;
        }
        const testMAE = this.mae();
        this.lossCurve.push({ train: Math.sqrt(loss / nb) * 1000, test: testMAE });
        yield { epoch: e + 1, epochs, rmse: Math.sqrt(loss / nb) * 1000, testMAE };
      }
      this.evaluate();
    },
    mae() {
      let s = 0;
      for (let i = 0; i < this.test.X.length; i++) s += Math.abs(this.model.predict(this.test.X[i]) - this.test.Y[i]);
      return (s / this.test.X.length) * 1000;
    },
    evaluate() {
      const n = this.test.X.length;
      let mlp = 0, seasonal = 0, persist = 0, ssTot = 0, ssRes = 0;
      const mean = this.test.Y.reduce((a, b) => a + b, 0) / n;
      this.testSeries = [];
      for (let i = 0; i < n; i++) {
        const y = this.test.Y[i] * 1000, p = this.model.predict(this.test.X[i]) * 1000;
        mlp += Math.abs(p - y); seasonal += Math.abs(this.test.meta[i].yday - y); persist += Math.abs(this.test.meta[i].last - y);
        ssRes += (p - y) ** 2; ssTot += (y - mean * 1000) ** 2;
        this.testSeries.push({ y, p });
      }
      this.metrics = { mae: mlp / n, seasonalMAE: seasonal / n, persistMAE: persist / n, r2: 1 - ssRes / ssTot };
      this.metrics.improvement = 1 - this.metrics.mae / Math.min(this.metrics.seasonalMAE, this.metrics.persistMAE);
      return this.metrics;
    },
    predict(d1, h1, totalNow, totalYday, evNow) {
      return this.model.predict(featurize(d1, h1, totalNow, totalYday, evNow)) * 1000;
    },
    explain(d1, h1, totalNow, totalYday, evNow) {
      const x = featurize(d1, h1, totalNow, totalYday, evNow);
      return this.model.attribute(x, this.baseline).map((v, i) => ({ name: FEATURES[i], kw: v * 1000 }));
    },
  };

  // ======================================================================
  // 2. Reinforcement-learning charging agent (tabular Q-learning)
  // ======================================================================
  const ACTIONS = [0.55, 0.7, 0.8, 0.9, 1.0]; // fraction of transformer headroom given to EVs
  const STEP_H = 0.25;                        // 15-minute decisions

  function stateIndex({ h, base, requested, trend, peak, headroom }) {
    const hb = Math.floor((h % 24) / 3);                                        // 8
    const bb = base < 400 ? 0 : base < 550 ? 1 : base < 680 ? 2 : 3;           // 4
    const qb = requested < 150 ? 0 : requested < 400 ? 1 : requested < 800 ? 2 : 3; // 4
    const tb = trend < -40 ? 0 : trend > 40 ? 2 : 1;                            // 3
    const pr = peak / Math.max(1, headroom);
    const pb = pr < 0.6 ? 0 : pr < 0.9 ? 1 : 2;                                 // 3
    return ((((hb * 4 + bb) * 4 + qb) * 3 + tb) * 3 + pb);
  }
  const N_STATES = 8 * 4 * 4 * 3 * 3;

  class ChargeEnv {
    constructor(seed) { this.r = rng(seed); }
    reset(day) {
      this.day = day; this.k = 0; this.queue = 40; this.peak = 0; this.spike = 0;
      return this.observe();
    }
    get h() { return this.k * STEP_H; }
    baseEst() { return W.base(this.h, this.day) + this.spike; }
    observe() {
      const base = this.baseEst();
      const fNext = W.base(this.h + 1, this.day) + W.arrival(this.h + 1, this.day) * 900;
      const fNow = W.base(this.h, this.day) + W.arrival(this.h, this.day) * 900;
      this.obs = {
        h: this.h, base, requested: Math.min(2000, this.queue / STEP_H),
        trend: fNext - fNow + randn(this.r) * 20, peak: this.peak, headroom: W.RATED - base,
      };
      return stateIndex(this.obs);
    }
    // policy: (obs) -> EV budget in kW
    step(budget) {
      const o = this.obs;
      const ev = clamp(Math.min(o.requested, budget), 0, 2000);
      // the neighbourhood load moves while the 15-minute decision is in force
      const evening = this.h >= 17 && this.h <= 21;
      if (this.r() < (evening ? 0.14 : 0.05)) this.spike += 50 + this.r() * 110;
      const baseActual = W.base(this.h + STEP_H, this.day) + this.spike + randn(this.r) * 12;
      this.spike *= 0.45;
      const overload = baseActual + ev > W.RATED;
      const delivered = ev * STEP_H;
      const newPeak = Math.max(0, ev - this.peak);
      this.peak = Math.max(this.peak, ev);
      this.queue = Math.max(0, this.queue - delivered);
      this.queue += poisson(this.r, W.arrival(this.h, this.day) * 15 * 2) * (30 + this.r() * 40);
      const reward = delivered / 100 - (overload ? 8 : 0) - (newPeak / 100) * 1.2 - (this.queue / 1000) * 0.15;
      this.k++;
      const done = this.k >= 96;
      return { s2: this.observe(), reward, done, ev, delivered, overload };
    }
  }

  const POLICIES = {
    static: () => Infinity,
    rules: (o) => W.SAFE - o.base,
  };

  const agent = {
    ACTIONS,
    q: null,
    curve: [],
    reset() { this.q = new QAgent(N_STATES, ACTIONS.length, 11); this.curve = []; },
    *trainSteps(episodes = 6000, chunk = 150) {
      const env = new ChargeEnv(2024);
      let acc = 0;
      for (let ep = 0; ep < episodes; ep++) {
        const eps = Math.max(0.03, 1 - ep / (episodes * 0.7));
        const alpha = Math.max(0.05, 0.3 * (1 - ep / episodes));
        let s = env.reset(ep % 120), total = 0, done = false;
        while (!done) {
          const a = this.q.act(s, eps);
          const res = env.step(ACTIONS[a] * env.obs.headroom);
          this.q.update(s, a, res.reward, res.s2, res.done, alpha, 0.95);
          s = res.s2; total += res.reward; done = res.done;
        }
        acc += total;
        if ((ep + 1) % chunk === 0) {
          this.curve.push(acc / chunk);
          yield { episode: ep + 1, episodes, avgReward: acc / chunk };
          acc = 0;
        }
      }
      this.evaluate();
    },
    decide(o) {
      const s = stateIndex(o);
      const a = this.q.greedy(s);
      return { s, a, frac: ACTIONS[a], q: this.q.values(s), budget: ACTIONS[a] * o.headroom };
    },
    // 30 unseen test days, same random seed for every policy (fair comparison)
    evaluate(days = 30) {
      const run = (policy) => {
        const env = new ChargeEnv(777);
        let energy = 0, overloads = 0, peak = 0, wait = 0;
        for (let d = 0; d < days; d++) {
          env.reset(200 + d);
          let done = false;
          while (!done) {
            const res = env.step(policy(env.obs));
            energy += res.delivered; overloads += res.overload ? 1 : 0; peak = Math.max(peak, res.ev); wait += env.queue;
            done = res.done;
          }
        }
        return { energyMWh: energy / 1000, overloads, peakKW: peak, avgQueue: wait / (days * 96) };
      };
      this.results = {
        static: run(POLICIES.static),
        rules: run(POLICIES.rules),
        ai: run((o) => this.decide(o).budget),
      };
      return this.results;
    },
  };

  // ======================================================================
  // 3. Telemetry guard (Isolation Forest intrusion detection)
  // ======================================================================
  const ATTACKS = {
    bypass: "Limit bypass + meter spoofing",
    fdi: "False data injection",
    flood: "Replay / message flooding",
  };

  // A Kinesis meter message: what the charger *reports*.
  function reading(r, { draw, limit, attack = null, rating = 350 }) {
    const V = 400 + randn(r) * 3;
    let msg = { V, I: (draw * 1000) / V * (1 + randn(r) * 0.01), P: draw * (1 + randn(r) * 0.01), limit, interval: 1 + randn(r) * 0.05 };
    if (attack === "bypass") {            // really draws full rating, claims to obey the limit
      const real = rating * (0.9 + r() * 0.1);
      msg.I = (real * 1000) / V; msg.P = Math.min(limit, real) * (0.97 + r() * 0.03);
    } else if (attack === "fdi") {        // injected voltage / power values
      msg.V = r() < 0.5 ? 340 + r() * 25 : 445 + r() * 20; msg.P = draw * (0.1 + r() * 0.3);
    } else if (attack === "flood") {      // replayed identical frames at high rate
      msg.V = 400; msg.interval = 0.03 + r() * 0.15; msg.P = draw; msg.I = (draw * 1000) / 400;
    }
    return msg;
  }
  function features(m) {
    const scale = Math.max(20, m.P);
    return [
      (m.V - 400) / 5,                                   // voltage deviation
      ((m.V * m.I) / 1000 - m.P) / scale,                // physics residual: P should equal V*I
      clamp((m.P - m.limit) / Math.max(20, m.limit), -1.5, 2), // compliance with commanded limit
      m.interval,                                        // message cadence
      m.P / 350,                                         // power level
    ];
  }
  function randomNormal(r) {
    const rating = r() < 0.5 ? 150 : 350;
    const limit = rating * (0.15 + r() * 0.85);
    const draw = limit * (0.4 + r() * 0.6);
    return { draw, limit, rating };
  }

  const guard = {
    ATTACKS,
    threshold: 0.6,
    train() {
      const r = rng(31);
      // Unsupervised: fitted on a raw, unlabelled slice of the Kinesis stream,
      // which (like real traffic) contains a small share of unknown attacks.
      const X = [];
      const kinds = Object.keys(ATTACKS);
      for (let i = 0; i < 3000; i++) {
        const atk = r() < 0.02 ? kinds[Math.floor(r() * kinds.length)] : null;
        X.push(features(reading(r, { ...randomNormal(r), attack: atk })));
      }
      this.forest = new IsolationForest(150, 256, 5).fit(X);
      // threshold from the expected contamination rate (top 2.5% of scores)
      const sc = X.map((x) => this.forest.score(x)).sort((a, b) => a - b);
      this.threshold = sc[Math.floor(sc.length * 0.975)];
      // held-out evaluation
      const rt = rng(77);
      const normal = [], attack = { bypass: [], fdi: [], flood: [] };
      for (let i = 0; i < 1500; i++) normal.push(this.forest.score(features(reading(rt, randomNormal(rt)))));
      for (const k of Object.keys(attack)) for (let i = 0; i < 200; i++) attack[k].push(this.forest.score(features(reading(rt, { ...randomNormal(rt), attack: k }))));
      const fpr = normal.filter((s) => s > this.threshold).length / normal.length;
      const tpr = {};
      for (const k of Object.keys(attack)) tpr[k] = attack[k].filter((s) => s > this.threshold).length / attack[k].length;
      const allAtk = Object.values(attack).flat();
      this.metrics = { fpr, tpr, recall: allAtk.filter((s) => s > this.threshold).length / allAtk.length };
      this.scores = { normal, attack: allAtk };
      return this.metrics;
    },
    reading,
    score(msg) { return this.forest.score(features(msg)); },
  };

  root.GridAI = { W, forecaster, agent, guard, stateIndex, ACTIONS, ChargeEnv };
})(typeof window !== "undefined" ? window : globalThis);

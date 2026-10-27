/* Minimal, dependency-free machine-learning toolkit used by GridSync.
   - MLP: feed-forward neural network trained with backpropagation + Adam
   - QAgent: tabular Q-learning (reinforcement learning)
   - IsolationForest: unsupervised anomaly detection (Liu, Ting & Zhou, 2008) */
(function (root) {
  "use strict";

  // Seeded PRNG (mulberry32) so every training run is reproducible.
  function rng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randn(r) {
    let u = 0;
    while (!u) u = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
  }
  function poisson(r, lambda) {
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= r(); } while (p > L);
    return k - 1;
  }

  // ---------------- Multi-layer perceptron ----------------
  class MLP {
    constructor(sizes, seed = 7) {
      const r = rng(seed);
      this.sizes = sizes;
      this.W = []; this.b = [];
      this.mW = []; this.vW = []; this.mb = []; this.vb = [];
      for (let l = 0; l < sizes.length - 1; l++) {
        const nIn = sizes[l], nOut = sizes[l + 1];
        const w = new Float64Array(nIn * nOut);
        const scale = Math.sqrt(1 / nIn); // Xavier init for tanh
        for (let i = 0; i < w.length; i++) w[i] = randn(r) * scale;
        this.W.push(w); this.b.push(new Float64Array(nOut));
        this.mW.push(new Float64Array(w.length)); this.vW.push(new Float64Array(w.length));
        this.mb.push(new Float64Array(nOut)); this.vb.push(new Float64Array(nOut));
      }
      this.t = 0;
    }
    forward(x) {
      const acts = [Float64Array.from(x)];
      for (let l = 0; l < this.W.length; l++) {
        const a = acts[l], nIn = this.sizes[l], nOut = this.sizes[l + 1];
        const z = new Float64Array(nOut);
        for (let j = 0; j < nOut; j++) {
          let s = this.b[l][j];
          for (let i = 0; i < nIn; i++) s += this.W[l][j * nIn + i] * a[i];
          z[j] = l < this.W.length - 1 ? Math.tanh(s) : s;
        }
        acts.push(z);
      }
      return acts;
    }
    predict(x) { return this.forward(x)[this.W.length][0]; }

    // One mini-batch step of MSE regression; returns mean squared error.
    trainBatch(X, Y, lr = 0.003) {
      const L = this.W.length;
      const gW = this.W.map((w) => new Float64Array(w.length));
      const gb = this.b.map((b) => new Float64Array(b.length));
      let loss = 0;
      for (let n = 0; n < X.length; n++) {
        const acts = this.forward(X[n]);
        const err = acts[L][0] - Y[n];
        loss += err * err;
        let delta = Float64Array.of(err);
        for (let l = L - 1; l >= 0; l--) {
          const nIn = this.sizes[l], nOut = this.sizes[l + 1], a = acts[l];
          for (let j = 0; j < nOut; j++) {
            gb[l][j] += delta[j];
            for (let i = 0; i < nIn; i++) gW[l][j * nIn + i] += delta[j] * a[i];
          }
          if (l > 0) {
            const prev = new Float64Array(nIn);
            for (let i = 0; i < nIn; i++) {
              let s = 0;
              for (let j = 0; j < nOut; j++) s += this.W[l][j * nIn + i] * delta[j];
              prev[i] = s * (1 - a[i] * a[i]); // tanh'
            }
            delta = prev;
          }
        }
      }
      // Adam update
      this.t++;
      const b1 = 0.9, b2 = 0.999, eps = 1e-8, n = X.length;
      const c1 = 1 - Math.pow(b1, this.t), c2 = 1 - Math.pow(b2, this.t);
      const step = (p, g, m, v) => {
        for (let i = 0; i < p.length; i++) {
          const gi = g[i] / n;
          m[i] = b1 * m[i] + (1 - b1) * gi;
          v[i] = b2 * v[i] + (1 - b2) * gi * gi;
          p[i] -= lr * (m[i] / c1) / (Math.sqrt(v[i] / c2) + eps);
        }
      };
      for (let l = 0; l < L; l++) { step(this.W[l], gW[l], this.mW[l], this.vW[l]); step(this.b[l], gb[l], this.mb[l], this.vb[l]); }
      return loss / n;
    }

    // Perturbation-based feature attribution (explainable AI):
    // how much the prediction moves when one feature is replaced by its baseline value.
    attribute(x, baseline) {
      const y = this.predict(x);
      return x.map((_, i) => {
        const xp = x.slice(); xp[i] = baseline[i];
        return y - this.predict(xp);
      });
    }
  }

  // ---------------- Tabular Q-learning ----------------
  class QAgent {
    constructor(nStates, nActions, seed = 11) {
      this.nS = nStates; this.nA = nActions;
      this.Q = new Float64Array(nStates * nActions);
      this.visits = new Uint32Array(nStates);
      this.r = rng(seed);
    }
    values(s) { return Array.from(this.Q.subarray(s * this.nA, (s + 1) * this.nA)); }
    greedy(s) {
      const q = this.values(s);
      return q.indexOf(Math.max(...q));
    }
    act(s, eps) { return this.r() < eps ? Math.floor(this.r() * this.nA) : this.greedy(s); }
    update(s, a, reward, s2, done, alpha, gamma) {
      const target = done ? reward : reward + gamma * Math.max(...this.values(s2));
      const i = s * this.nA + a;
      this.Q[i] += alpha * (target - this.Q[i]);
      this.visits[s]++;
    }
  }

  // ---------------- Isolation Forest ----------------
  const EULER = 0.5772156649;
  const cFactor = (n) => (n > 2 ? 2 * (Math.log(n - 1) + EULER) - (2 * (n - 1)) / n : n === 2 ? 1 : 0);

  class IsolationForest {
    constructor(nTrees = 100, sampleSize = 128, seed = 5) {
      this.nTrees = nTrees; this.psi = sampleSize; this.r = rng(seed);
    }
    fit(X) {
      const psi = Math.min(this.psi, X.length);
      const limit = Math.ceil(Math.log2(psi));
      this.trees = [];
      for (let t = 0; t < this.nTrees; t++) {
        const sample = [];
        for (let i = 0; i < psi; i++) sample.push(X[Math.floor(this.r() * X.length)]);
        this.trees.push(this.build(sample, 0, limit));
      }
      this.c = cFactor(psi);
      return this;
    }
    build(X, depth, limit) {
      if (depth >= limit || X.length <= 1) return { size: X.length };
      const f = Math.floor(this.r() * X[0].length);
      let lo = Infinity, hi = -Infinity;
      for (const x of X) { if (x[f] < lo) lo = x[f]; if (x[f] > hi) hi = x[f]; }
      if (lo === hi) return { size: X.length };
      const split = lo + this.r() * (hi - lo);
      const L = [], R = [];
      for (const x of X) (x[f] < split ? L : R).push(x);
      return { f, split, left: this.build(L, depth + 1, limit), right: this.build(R, depth + 1, limit) };
    }
    pathLength(x, node, d) {
      while (node.size === undefined) { node = x[node.f] < node.split ? node.left : node.right; d++; }
      return d + cFactor(node.size);
    }
    // Anomaly score in (0, 1]; values near 1 are anomalies, ~0.5 or lower are normal.
    score(x) {
      let sum = 0;
      for (const t of this.trees) sum += this.pathLength(x, t, 0);
      return Math.pow(2, -(sum / this.trees.length) / this.c);
    }
  }

  root.ML = { rng, randn, poisson, MLP, QAgent, IsolationForest };
})(typeof window !== "undefined" ? window : globalThis);

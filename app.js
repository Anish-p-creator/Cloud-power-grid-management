/* GridSync: live simulation of an AWS-controlled EV fast-charging hub.
   Three control modes are compared on the same grid:
     static - fixed per-charger limits (legacy)
     rules  - AWS cloud loop with a fixed safety-margin rule (no ML)
     ai     - AWS cloud loop driven by the trained models in ai.js
   All data is generated in the browser for demonstration. */
(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const fmt = (n) => Math.round(n).toLocaleString("en-IN");
  const pad2 = (n) => String(n).padStart(2, "0");

  const { W, forecaster, agent, guard, ACTIONS } = window.GridAI;
  const RATED_KW = W.RATED;
  const SAFE_KW = W.SAFE;
  const TICK_MS = 250;
  const CONTROL_EVERY = 4;          // ticks between cloud control cycles
  const BAY_RATINGS = [350, 350, 150, 150, 350, 150, 350, 150];
  const CARS = ["🚗", "🚙", "🚘", "🚐"];
  const MODE_NAMES = { static: "static per-charger limits (legacy)", rules: "AWS cloud with fixed rules", ai: "GridSync AI (forecast + RL + intrusion detection)" };
  const telemetryRng = window.ML.rng(1234);

  const S = {
    mode: "ai",
    aiReady: false,
    paused: false,
    speed: 6,
    day: 120,
    simMin: 17 * 60 + 30,
    tickN: 0,
    spike: 0,
    bays: BAY_RATINGS.map((r, i) => ({
      id: i + 1, rating: r, car: null, limit: r, draw: 0, connected: true, offlineFor: 0,
      attack: null, attackFor: 0, quarantined: 0, scores: [], trust: 0,
    })),
    history: [],
    hourly: {},
    hourAcc: { total: 0, ev: 0, n: 0, key: null },
    trips: 0,
    trippedFor: 0,
    overTicks: 0,
    peakActual: 0,
    peakBaseline: 0,
    peakToday: 0,
    threats: 0,
    scored: 0,
    adr: null,           // { cap, left (sim minutes) }
    adrPending: false,
    lastReact: null,
    wfBusy: false,
    lastDecision: null,
  };

  // ---------- Grid model ----------
  const hourOf = () => S.simMin / 60;
  function baseLoad() {
    return W.base(hourOf(), S.day) + S.spike + 12 * Math.sin(S.simMin / 7);
  }
  function taper(soc) { return soc < 0.8 ? 1 : clamp(1 - (soc - 0.8) * 4, 0.2, 1); }
  function demandOf(bay) {
    if (!bay.car || !bay.connected || bay.quarantined > 0) return 0;
    return bay.rating * bay.car.accept * taper(bay.car.soc);
  }
  function newCar(lowSoc) {
    return {
      icon: CARS[Math.floor(Math.random() * CARS.length)],
      soc: lowSoc ? rand(0.08, 0.3) : rand(0.1, 0.6),
      target: rand(0.8, 0.95),
      cap: rand(60, 100),
      accept: rand(0.75, 1),
    };
  }

  // ---------- Allocation (Step Functions "compute" Lambda) ----------
  function allocate(budget) {
    const act = S.bays.filter((b) => demandOf(b) > 0);
    act.forEach((b) => { b.limit = 0; });
    let remaining = Math.max(0, budget);
    let open = act.slice();
    // weighted water-filling: low-SoC vehicles get a larger share
    for (let iter = 0; iter < 6 && open.length && remaining > 0.5; iter++) {
      const wSum = open.reduce((s, b) => s + (1.1 - b.car.soc), 0);
      let used = 0;
      open.forEach((b) => {
        const share = remaining * (1.1 - b.car.soc) / wSum;
        const give = Math.min(share, demandOf(b) - b.limit);
        b.limit += give; used += give;
      });
      remaining -= used;
      open = open.filter((b) => demandOf(b) - b.limit > 0.5);
    }
    // idle bays wait at 0 kW until the next cycle assigns them a share (OCPP default profile)
    S.bays.forEach((b) => { if (!demandOf(b)) b.limit = 0; });
  }

  // ---------- Forecasting helpers (MLP) ----------
  const hkey = (d, h) => d * 24 + h;
  function prefillHourly() {
    forecaster.history.forEach((r) => { if (r.d >= 118) S.hourly[hkey(r.d, r.h)] = { total: r.total, ev: r.ev }; });
    for (let h = 0; h < Math.floor(hourOf()); h++) {
      const ev = W.arrival(h + 0.5, S.day) * 60 * 1.3 * 130 / 0.7;
      S.hourly[hkey(S.day, h)] = { total: W.base(h + 0.5, S.day) + ev, ev };
    }
  }
  function recordHour(total, ev) {
    const key = hkey(S.day, Math.floor(hourOf()));
    const A = S.hourAcc;
    if (A.key !== null && A.key !== key && A.n) S.hourly[A.key] = { total: A.total / A.n, ev: A.ev / A.n };
    if (A.key !== key) { A.key = key; A.total = 0; A.ev = 0; A.n = 0; }
    A.total += total; A.ev += ev; A.n++;
  }
  function hourVal(key) {
    if (key === S.hourAcc.key && S.hourAcc.n) return { total: S.hourAcc.total / S.hourAcc.n, ev: S.hourAcc.ev / S.hourAcc.n };
    return S.hourly[key];
  }
  // next-hour prediction from the current (partial) hour
  function forecastNext() {
    const h = Math.floor(hourOf());
    const nowRec = hourVal(hkey(S.day, h)) || { total: baseLoad(), ev: 0 };
    const d1 = h === 23 ? S.day + 1 : S.day, h1 = (h + 1) % 24;
    const yday = (S.hourly[hkey(d1 - 1, h1)] || nowRec).total;
    return {
      value: forecaster.predict(d1, h1, nowRec.total, yday, nowRec.ev),
      now: nowRec.total,
      attrib: forecaster.explain(d1, h1, nowRec.total, yday, nowRec.ev),
    };
  }
  // 24 one-step-ahead predictions for today (recursive for future hours)
  function forecastToday() {
    const out = [];
    let prev = hourVal(hkey(S.day - 1, 23)) || { total: 500, ev: 100 };
    for (let h = 0; h < 24; h++) {
      const yday = (S.hourly[hkey(S.day - 1, h)] || prev).total;
      const p = forecaster.predict(S.day, h, prev.total, yday, prev.ev);
      const actual = hourVal(hkey(S.day, h));
      out.push({ p, actual: actual ? actual.total : null });
      prev = actual || { total: p, ev: prev.ev };
    }
    return out;
  }

  // ---------- Cloud control cycle ----------
  function controlCycle(base) {
    const totalDemand = S.bays.reduce((s, b) => s + demandOf(b), 0);
    let budget;
    if (S.mode === "ai" && S.aiReady) {
      const fc = forecastNext();
      const obs = {
        h: hourOf(), base, requested: totalDemand, trend: fc.value - fc.now,
        peak: S.peakToday, headroom: RATED_KW - base,
      };
      const dec = agent.decide(obs);
      budget = dec.budget;
      S.lastDecision = { obs, dec, fc };
    } else {
      budget = SAFE_KW - base;
    }
    if (S.adr) budget = Math.min(budget, S.adr.cap);
    allocate(budget);
    return budget;
  }

  // ---------- Simulation tick ----------
  function tick() {
    if (S.paused) return;
    S.tickN++;
    const dtMin = S.speed * 0.25;
    S.simMin += dtMin;
    if (S.simMin >= 1440) {
      S.simMin -= 1440; S.day++; S.peakToday = 0;
      log(`New day: SageMaker forecaster retrains nightly on yesterday's Timestream data`, "sm");
    }
    const hour = hourOf();

    // neighbourhood disturbances (AC switching on, industrial loads ...)
    const evening = hour >= 17 && hour <= 21;
    S.spike *= Math.pow(0.45, dtMin / 15);
    if (Math.random() < (evening ? 0.14 : 0.05) * dtMin / 15) S.spike += rand(50, 160);
    const base = baseLoad();

    // tripped feeder: everything is dark
    if (S.trippedFor > 0) {
      S.trippedFor -= TICK_MS;
      S.bays.forEach((b) => { b.draw = 0; });
      pushHistory(0, 0);
      if (S.trippedFor <= 0) { $("#tripBanner").classList.remove("show"); log("Breaker reset manually, feeder restored", "ok"); }
      render(0, 0);
      return;
    }

    // arrivals & departures
    S.bays.forEach((b) => {
      if (!b.car && b.connected && !b.quarantined && Math.random() < W.arrival(hour, S.day) * dtMin) {
        b.car = newCar();
        log(`Bay ${b.id}: StartTransaction · SoC ${Math.round(b.car.soc * 100)}%`, "");
      } else if (b.car && b.car.soc >= b.car.target) {
        log(`Bay ${b.id}: StopTransaction · charged to ${Math.round(b.car.soc * 100)}%`, "ok");
        b.car = null;
      }
    });

    // cellular blips: IoT Core keeps persistent sessions and reconnects
    S.bays.forEach((b) => {
      if (b.offlineFor > 0) {
        b.offlineFor -= TICK_MS;
        if (b.offlineFor <= 0) { b.connected = true; log(`Bay ${b.id}: MQTT reconnected (mTLS verified, persistent session resumed)`, "ok"); }
      } else if (Math.random() < 0.001) {
        b.connected = false; b.offlineFor = 2500;
        log(`Bay ${b.id}: cellular link dropped, IoT Core holding session`, "err");
      }
      if (b.quarantined > 0) {
        b.quarantined -= TICK_MS;
        if (b.quarantined <= 0) {
          b.quarantined = 0; b.attack = null; b.scores = [];
          log(`Bay ${b.id}: firmware re-flashed, new X.509 certificate issued, back in service`, "ok");
        }
      }
      if (b.attack && !b.quarantined) {
        b.attackFor -= TICK_MS;
        if (b.attackFor <= 0) { log(`Bay ${b.id}: attacker disconnected after ${S.mode === "ai" ? "evading" : "running undetected"}`, "err"); b.attack = null; }
      }
    });

    if (S.adr) S.adr.left -= dtMin;
    if (S.adr && S.adr.left <= 0) {
      log("OpenADR event ended, normal allocation resumed", "adr");
      S.adr = null; $("#adrBtn").disabled = false;
    }

    const totalDemand = S.bays.reduce((s, b) => s + demandOf(b), 0);

    if (S.mode === "static") {
      S.bays.forEach((b) => { b.limit = b.rating; });
    } else if (S.tickN % CONTROL_EVERY === 1 || S.adrPending) {
      controlCycle(base);
    }
    // compromised chargers ignore their limit and pull full power
    S.bays.forEach((b) => {
      const d = demandOf(b);
      b.draw = b.attack && d > 0 ? b.rating * b.car.accept : Math.min(d, b.limit);
    });

    // charge the cars
    S.bays.forEach((b) => {
      if (b.car && b.draw > 0) b.car.soc = Math.min(1, b.car.soc + (b.draw * dtMin / 60) / b.car.cap);
    });

    const ev = S.bays.reduce((s, b) => s + b.draw, 0);
    const total = base + ev;
    S.peakActual = Math.max(S.peakActual, ev);
    S.peakBaseline = Math.max(S.peakBaseline, totalDemand);
    S.peakToday = Math.max(S.peakToday, ev);
    recordHour(base + totalDemand, totalDemand);

    // AI telemetry guard: every Kinesis message is scored by the Isolation Forest
    scoreTelemetry();

    // overload protection relay
    if (total > RATED_KW) S.overTicks++; else S.overTicks = 0;
    if (S.overTicks >= 3) {
      S.trips++; S.trippedFor = 4500; S.overTicks = 0;
      $("#tripBanner").classList.add("show");
      log(`FEEDER TRIP: transformer at ${Math.round(total / RATED_KW * 100)}%, relay opened`, "err");
    }

    pushHistory(base, ev);

    if (S.mode !== "static" && !S.wfBusy) {
      if (S.adrPending) { S.adrPending = false; runWorkflow(true); }
      else if (Math.random() < 0.06) runWorkflow(false);
    }
    if (Math.random() < 0.3) {
      const b = S.bays[Math.floor(Math.random() * 8)];
      if (b.draw > 0) log(`kinesis ← bay-${b.id} {V: ${Math.round(rand(395, 410))}, I: ${Math.round(b.draw * 1000 / 400)}A, P: ${b.draw.toFixed(1)}kW, anomaly: ${b.trust.toFixed(2)}}`, "t2");
    }

    render(base, ev);
  }

  function scoreTelemetry() {
    if (!guard.forest) return;
    S.bays.forEach((b) => {
      if (!b.car || !b.connected || b.quarantined) { b.trust = 0; return; }
      const msg = guard.reading(telemetryRng, { draw: b.attack ? b.draw : Math.max(1, b.draw), limit: b.limit, rating: b.rating, attack: b.attack });
      const sc = guard.score(msg);
      S.scored++;
      b.trust = sc;
      b.scores.push(sc > guard.threshold);
      if (b.scores.length > 3) b.scores.shift();
      if (S.mode === "ai" && S.aiReady && b.scores.filter(Boolean).length >= 2) {
        b.quarantined = 9000; S.threats++;
        log(`🛡 Isolation Forest flagged bay ${b.id} (score ${sc.toFixed(2)} > ${guard.threshold.toFixed(2)}) → IoT Core certificate revoked, power reallocated`, "err");
        if (b.attack) log(`Bay ${b.id}: attack identified as “${guard.ATTACKS[b.attack]}”`, "sm");
        controlCycle(baseLoad());
      }
    });
  }

  function pushHistory(base, ev) {
    S.history.push({ base, ev });
    if (S.history.length > 180) S.history.shift();
  }

  // ---------- Workflow animation (Step Functions) ----------
  async function runWorkflow(fromAdr) {
    S.wfBusy = true;
    const steps = $$("#pipeline li");
    steps.forEach((li) => { li.classList.remove("run", "done"); li.querySelector("em").textContent = ""; });
    const lat = [rand(40, 90), rand(60, 140), rand(70, 160), rand(15, 35), rand(60, 140), rand(80, 220), rand(15, 35), rand(110, 260)];
    const useAI = S.mode === "ai";
    const start = fromAdr ? 0 : 2;
    if (!fromAdr) for (let i = 0; i < 2; i++) steps[i].querySelector("em").textContent = "skip";
    $("#wfStatus").textContent = fromAdr ? "OpenADR-triggered execution" : "periodic rebalance";
    let total = 0;
    for (let i = start; i < steps.length; i++) {
      if (i === 4 && !useAI) { steps[i].querySelector("em").textContent = "skip"; continue; }
      steps[i].classList.add("run");
      await sleep(lat[i] * (fromAdr ? 2.2 : 1));
      total += lat[i];
      steps[i].classList.remove("run"); steps[i].classList.add("done");
      steps[i].querySelector("em").textContent = `${Math.round(lat[i])} ms`;
    }
    S.lastReact = total / 1000;
    $("#wfTotal").textContent = `${S.lastReact.toFixed(2)} s ✓`;
    $("#wfStatus").textContent = "idle · runs on every cycle";
    if (fromAdr) log(`IoT Core → SetChargingProfile sent to ${S.bays.filter((b) => b.car).length} chargers in ${S.lastReact.toFixed(2)} s`, "ok");
    await sleep(fromAdr ? 2500 : 900);
    S.wfBusy = false;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function sendAdr() {
    const ev = S.bays.reduce((s, b) => s + b.draw, 0);
    const cap = Math.max(60, ev * 0.7);
    S.adr = { cap, left: 20 };
    $("#adrBtn").disabled = true;
    log(`OpenADR oadrDistributeEvent: reduce site load 30% for 20 min (cap ${fmt(cap)} kW)`, "adr");
    if (S.mode === "static") {
      log("Static mode: no OpenADR→OCPP bridge, the event cannot reach the chargers", "err");
      setTimeout(() => { if (S.mode === "static") { S.lastReact = 24 + Math.random() * 6; log(`Legacy backend responded after ${S.lastReact.toFixed(1)} s (too late)`, "err"); } }, 1200);
      return;
    }
    S.adrPending = true; // picked up by the next tick once any running cycle finishes
  }

  function launchAttack() {
    const targets = S.bays.filter((b) => b.car && b.connected && !b.quarantined && !b.attack);
    if (!targets.length) { log("No active charger to attack right now. Plug in some cars first.", "err"); return; }
    const b = targets[Math.floor(Math.random() * targets.length)];
    const kinds = Object.keys(guard.ATTACKS);
    b.attack = kinds[Math.floor(Math.random() * kinds.length)];
    b.attackFor = 25000; b.scores = [];
    log(`☠ Bay ${b.id} compromised: ${guard.ATTACKS[b.attack]} (ignores power limit, tampers telemetry)`, "err");
    if (S.mode !== "ai") log(`${S.mode === "static" ? "Legacy" : "Rule-based"} backend has no telemetry anomaly detection, attack is not seen`, "err");
  }

  // ---------- Canvas helpers ----------
  function fitCanvas(c) {
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = Number(c.getAttribute("height"));
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.height = h + "px"; }
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = "11px JetBrains Mono, monospace";
    return { ctx, w, h };
  }

  function drawLoadChart() {
    const { ctx, w, h } = fitCanvas($("#loadChart"));
    const pad = { l: 46, r: 10, t: 10, b: 20 };
    const maxV = Math.max(1300, ...S.history.map((p) => p.base + p.ev)) * 1.08;
    const X = (i) => pad.l + (i / 179) * (w - pad.l - pad.r);
    const Y = (v) => h - pad.b - (v / maxV) * (h - pad.t - pad.b);

    ctx.fillStyle = "#8b89ad"; ctx.strokeStyle = "rgba(255,255,255,.06)"; ctx.lineWidth = 1;
    for (let v = 0; v <= maxV; v += 250) {
      ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(w - pad.r, Y(v)); ctx.stroke();
      ctx.fillText(v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 2 : 0) + "MW" : v, 4, Y(v) + 4);
    }
    const n = S.history.length;
    if (n > 1) {
      const off = 180 - n;
      const area = (fn, fill, line) => {
        const path = () => S.history.forEach((p, i) => { const x = X(i + off), y = Y(fn(p)); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.beginPath(); path();
        ctx.lineTo(X(n - 1 + off), Y(0)); ctx.lineTo(X(off), Y(0)); ctx.closePath();
        ctx.fillStyle = fill; ctx.fill();
        ctx.beginPath(); path();
        ctx.strokeStyle = line; ctx.lineWidth = 2; ctx.stroke();
      };
      const g = ctx.createLinearGradient(0, pad.t, 0, h);
      g.addColorStop(0, "rgba(140,107,255,.75)"); g.addColorStop(1, "rgba(140,107,255,.15)");
      area((p) => p.base + p.ev, g, "#8c6bff");
      area((p) => p.base, "rgba(75,74,134,.85)", "#6f6db5");
    }
    ctx.strokeStyle = "#ff5470"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(pad.l, Y(RATED_KW)); ctx.lineTo(w - pad.r, Y(RATED_KW)); ctx.stroke();
    ctx.setLineDash([5, 5]); ctx.strokeStyle = "#ffb547"; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(pad.l, Y(SAFE_KW)); ctx.lineTo(w - pad.r, Y(SAFE_KW)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#ff5470"; ctx.fillText("rated 1 MW", w - 90, Y(RATED_KW) - 6);
    if (S.adr) {
      const capLine = baseLoad() + S.adr.cap;
      ctx.setLineDash([2, 4]); ctx.strokeStyle = "#2fd6c6";
      ctx.beginPath(); ctx.moveTo(pad.l, Y(capLine)); ctx.lineTo(w - pad.r, Y(capLine)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = "#2fd6c6"; ctx.fillText("OpenADR cap", pad.l + 6, Y(capLine) - 6);
    }
  }

  function drawForecast() {
    if (!S.aiReady) return;
    const { ctx, w, h } = fitCanvas($("#fcChart"));
    const series = forecastToday();
    const pad = { l: 8, r: 8, t: 14, b: 22 };
    const max = Math.max(...series.map((s) => Math.max(s.p, s.actual || 0))) * 1.1;
    const bw = (w - pad.l - pad.r) / 24;
    const Y = (v) => h - pad.b - (v / max) * (h - pad.t - pad.b);
    const curH = Math.floor(hourOf());
    series.forEach((s, i) => {
      const x = pad.l + i * bw + 2;
      if (s.actual != null) {
        ctx.fillStyle = i === curH ? "#2fd6c6" : "rgba(140,107,255,.6)";
        ctx.fillRect(x, Y(s.actual), bw - 4, h - pad.b - Y(s.actual));
      }
      if (i % 3 === 0) { ctx.fillStyle = "#8b89ad"; ctx.fillText(pad2(i), x, h - 6); }
    });
    ctx.beginPath();
    series.forEach((s, i) => { const x = pad.l + i * bw + bw / 2, y = Y(s.p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = "#ffb547"; ctx.lineWidth = 2; ctx.stroke();
    series.forEach((s, i) => { ctx.beginPath(); ctx.arc(pad.l + i * bw + bw / 2, Y(s.p), 2.5, 0, 7); ctx.fillStyle = "#ffb547"; ctx.fill(); });
    const peakH = series.reduce((m, s, i) => (s.p > series[m].p ? i : m), 0);
    const fc = forecastNext();
    $("#fcNote").innerHTML = `Next hour: <b>${fmt(fc.value)} kW</b> (±${fmt(forecaster.metrics.mae)} kW) · predicted peak today at <b>${pad2(peakH)}:00</b>`;
  }

  // ---------- Rendering ----------
  const bayEls = [];
  function buildBays() {
    const wrap = $("#bays");
    S.bays.forEach((b) => {
      const el = document.createElement("div");
      el.className = "bay";
      el.innerHTML = `
        <div class="bay-top"><span class="bay-id">Bay ${b.id} · ${b.rating} kW</span><span class="bay-badge">IDLE</span></div>
        <div class="car">🚗</div>
        <div class="soc"><i></i></div>
        <div class="bay-row"><span>SoC <b class="v-soc">–</b></span><span>Draw <b class="v-draw">0</b> kW</span></div>
        <div class="bay-row"><span class="l-lim">Static limit</span><b class="v-lim">${b.rating} kW</b></div>
        <div class="bay-row"><span>Anomaly score</span><b class="v-trust">–</b></div>
        <span class="zap">⚡</span>`;
      wrap.appendChild(el);
      bayEls.push(el);
    });
  }

  function render(base, ev) {
    const total = base + ev;
    const pct = total / RATED_KW * 100;
    const hh = Math.floor(S.simMin / 60), mm = Math.floor(S.simMin % 60);
    $("#simClock").textContent = `${pad2(hh)}:${pad2(mm)}`;

    const kLoad = $("#kLoad");
    kLoad.textContent = `${Math.round(pct)}%`;
    kLoad.className = "k-val " + (pct > 100 ? "bad" : pct > 90 ? "warn" : "good");
    $("#kLoadBar").style.width = clamp(pct, 0, 100) + "%";
    $("#kLoadBar").style.backgroundPosition = `${clamp(pct, 0, 100)}% 0`;
    $("#kEv").textContent = `${fmt(ev)} kW`;
    const active = S.bays.filter((b) => b.draw > 0).length;
    $("#kActive").textContent = `${active} active session${active === 1 ? "" : "s"}`;

    const kR = $("#kReact");
    if (S.lastReact == null) { kR.textContent = "—"; kR.className = "k-val"; }
    else { kR.textContent = `${S.lastReact.toFixed(2)} s`; kR.className = "k-val " + (S.lastReact < 2 ? "good" : "bad"); }

    const saved = S.peakBaseline > 0 ? (1 - S.peakActual / S.peakBaseline) * 100 : 0;
    const kS = $("#kSaved");
    kS.textContent = `${Math.max(0, Math.round(saved))}%`;
    kS.className = "k-val " + (saved >= 35 ? "good" : saved > 5 ? "warn" : "");
    $("#kPeak").textContent = `peak ${fmt(S.peakActual)} kW vs ${fmt(S.peakBaseline)} kW`;

    const kT = $("#kTrips");
    kT.textContent = S.trips;
    kT.className = "k-val " + (S.trips ? "bad" : "good");
    $("#kTripSub").textContent = S.trippedFor > 0 ? "FEEDER DARK" : S.trips ? "trips since mode switch" : "feeder healthy";

    const kTh = $("#kThreat");
    kTh.textContent = S.threats;
    kTh.className = "k-val " + (S.threats ? "good" : "");
    $("#kScored").textContent = `${fmt(S.scored)} messages scored by AI`;

    // gauge
    const gp = clamp(pct, 0, 120);
    $("#gNeedle").style.transform = `rotate(${(gp / 120) * 180 - 90}deg)`;
    const arc = $("#gArc");
    const len = arc.getTotalLength();
    arc.style.strokeDasharray = len;
    arc.style.strokeDashoffset = len * (1 - gp / 120);
    arc.style.stroke = pct > 100 ? "var(--red)" : pct > 90 ? "var(--amber)" : "var(--green)";
    $("#gVal").textContent = `${Math.round(pct)}%`;
    const st = $("#gState");
    if (S.trippedFor > 0) { st.textContent = "TRIPPED"; st.className = "state bad"; }
    else if (pct > 100) { st.textContent = "OVERLOAD"; st.className = "state bad"; }
    else if (pct > 90) { st.textContent = "STRESS"; st.className = "state warn"; }
    else { st.textContent = "NORMAL"; st.className = "state ok"; }
    $("#gHead").textContent = S.trippedFor > 0 ? "—" : `${fmt(Math.max(0, RATED_KW - total))} kW`;
    $("#gAdr").textContent = S.adr ? `${fmt(S.adr.cap)} kW` : "none";

    // bays
    S.bays.forEach((b, i) => {
      const el = bayEls[i];
      const dark = S.trippedFor > 0;
      const throttled = b.car && b.draw > 0 && b.draw < demandOf(b) - 1;
      el.className = "bay" + (b.car ? " occupied" : "") + (b.draw > 0 ? " charging" : "") + (throttled ? " throttled" : "") +
        (dark ? " dark" : "") + (b.quarantined ? " quarantined" : b.attack ? " attacked" : "");
      const badge = el.querySelector(".bay-badge");
      badge.textContent = b.quarantined ? "QUARANTINED" : b.attack ? "COMPROMISED" : !b.connected ? "RECONNECTING" : dark ? "NO POWER" :
        throttled ? (S.mode === "ai" ? "AI BALANCED" : "BALANCED") : b.draw > 0 ? "CHARGING" : b.car ? "WAITING" : "IDLE";
      if (b.car) el.querySelector(".car").textContent = b.car.icon;
      el.querySelector(".soc i").style.width = b.car ? `${b.car.soc * 100}%` : "0%";
      el.querySelector(".v-soc").textContent = b.car ? `${Math.round(b.car.soc * 100)}%` : "–";
      el.querySelector(".v-draw").textContent = b.draw.toFixed(0);
      const dyn = S.mode !== "static" && b.car;
      el.querySelector(".l-lim").textContent = dyn ? (S.mode === "ai" ? "AI limit" : "Dynamic limit") : "Static limit";
      el.querySelector(".v-lim").textContent = `${(dyn ? b.limit : b.rating).toFixed(0)} kW`;
      const tv = el.querySelector(".v-trust");
      tv.textContent = b.trust ? b.trust.toFixed(2) : "–";
      tv.style.color = b.trust > guard.threshold ? "var(--red)" : b.trust ? "var(--green)" : "";
    });

    drawLoadChart();
    if (S.tickN % 8 === 0) { drawForecast(); renderExplain(); renderGuard(); }
  }

  // ---------- Explainable AI panel ----------
  function renderExplain() {
    const box = $("#xai");
    if (S.mode !== "ai") {
      box.innerHTML = `<p class="muted">Switch to <b>GridSync AI</b> mode to see the reasoning behind each decision. In <b>${S.mode === "static" ? "static" : "rule-based"}</b> mode there is no learned decision to explain${S.mode === "rules" ? `: the budget is always the fixed rule <code>950 kW − base load</code>` : ""}.</p>`;
      return;
    }
    const L = S.lastDecision;
    if (!L) { box.innerHTML = `<p class="muted">Waiting for the first AI decision…</p>`; return; }
    const { obs, dec, fc } = L;
    const qMax = Math.max(...dec.q), qMin = Math.min(...dec.q);
    const qBars = dec.q.map((q, i) => {
      const w = qMax === qMin ? 50 : 8 + ((q - qMin) / (qMax - qMin)) * 92;
      return `<div class="qrow${i === dec.a ? " pick" : ""}"><span>${Math.round(ACTIONS[i] * 100)}%</span><div class="qbar"><i style="width:${w}%"></i></div><em>${q.toFixed(1)}</em></div>`;
    }).join("");
    const top = fc.attrib.slice().sort((a, b) => Math.abs(b.kw) - Math.abs(a.kw)).slice(0, 4);
    const aMax = Math.max(...top.map((t) => Math.abs(t.kw)), 1);
    const attr = top.map((t) => `<div class="arow"><span>${t.name}</span><div class="abar"><i class="${t.kw >= 0 ? "pos" : "neg"}" style="width:${Math.abs(t.kw) / aMax * 100}%"></i></div><em>${t.kw >= 0 ? "+" : "−"}${fmt(Math.abs(t.kw))}</em></div>`).join("");
    const trend = obs.trend > 40 ? "rising" : obs.trend < -40 ? "falling" : "flat";
    const margin = obs.headroom - dec.budget;
    let why;
    if (dec.frac >= 0.95) why = `Demand is ${trend} and the risk of a load spike is low, so the agent gives EVs the <b>full headroom</b>.`;
    else why = `The forecast says demand is <b>${trend}</b> (${obs.trend >= 0 ? "+" : "−"}${fmt(Math.abs(obs.trend))} kW next hour)${S.peakToday > 0 ? ` and today's EV peak is ${fmt(S.peakToday)} kW` : ""}, so the agent keeps <b>${fmt(margin)} kW in reserve</b> against neighbourhood spikes instead of using all ${fmt(obs.headroom)} kW of headroom.`;
    box.innerHTML = `
      <div class="xai-grid">
        <div>
          <h4>RL policy · Q-values per action</h4>
          <p class="muted small">Share of transformer headroom given to EVs. Highest Q wins.</p>
          ${qBars}
        </div>
        <div>
          <h4>Forecaster · why ${fmt(fc.value)} kW next hour</h4>
          <p class="muted small">Feature contribution vs. an average hour (perturbation attribution)</p>
          ${attr}
        </div>
      </div>
      <p class="why">💡 ${why} EV budget = <b>${fmt(dec.budget)} kW</b>.</p>`;
  }

  function renderGuard() {
    const box = $("#guardBars");
    box.innerHTML = S.bays.map((b) => {
      const s = b.trust || 0;
      const cls = b.quarantined ? "q" : s > guard.threshold ? "hi" : "";
      return `<div class="grow ${cls}"><span>Bay ${b.id}</span><div class="gbar"><i style="width:${s * 100}%"></i><b style="left:${guard.threshold * 100}%"></b></div><em>${b.quarantined ? "isolated" : s ? s.toFixed(2) : "idle"}</em></div>`;
    }).join("");
  }

  // ---------- Log ----------
  function log(msg, cls) {
    const el = $("#log");
    if (!el) return;
    const d = document.createElement("div");
    const clock = $("#simClock") ? $("#simClock").textContent : "";
    d.className = cls || "";
    d.innerHTML = `<span class="t">${clock}</span>${msg}`;
    el.prepend(d);
    while (el.children.length > 60) el.lastChild.remove();
  }

  // ---------- Controls ----------
  function setMode(m) {
    S.mode = m;
    $$(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
    S.peakActual = 0; S.peakBaseline = 0; S.lastReact = null; S.trips = 0; S.threats = 0;
    $("#wfTotal").textContent = "—";
    if (m !== "static") controlCycle(baseLoad());
    log(`Switched to ${MODE_NAMES[m]}`, "sm");
    renderExplain();
  }
  $$(".seg-btn").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("#adrBtn").addEventListener("click", sendAdr);
  $("#attackBtn").addEventListener("click", launchAttack);
  $("#rushBtn").addEventListener("click", () => {
    let n = 0;
    S.bays.forEach((b) => { if (!b.car && b.connected && !b.quarantined) { b.car = newCar(true); n++; } });
    if (S.simMin < 17 * 60 || S.simMin > 20 * 60) S.simMin = 18 * 60;
    log(`Evening rush: ${n} vehicles plugged in at once`, "adr");
  });
  $("#speed").addEventListener("input", (e) => { S.speed = Number(e.target.value); });
  $("#pauseBtn").addEventListener("click", (e) => {
    S.paused = !S.paused;
    e.currentTarget.textContent = S.paused ? "▶ Resume" : "❚❚ Pause";
  });

  // ---------- AI Lab: training with live charts ----------
  function lineChart(canvas, seriesList, opts = {}) {
    const { ctx, w, h } = fitCanvas(canvas);
    const pad = { l: 44, r: 10, t: 12, b: 20 };
    const all = seriesList.flatMap((s) => s.data);
    if (!all.length) return;
    const lo = opts.min ?? Math.min(...all), hi = opts.max ?? Math.max(...all);
    const n = Math.max(...seriesList.map((s) => s.data.length), opts.n || 0);
    const X = (i) => pad.l + (i / Math.max(1, n - 1)) * (w - pad.l - pad.r);
    const Y = (v) => h - pad.b - ((v - lo) / (hi - lo || 1)) * (h - pad.t - pad.b);
    ctx.strokeStyle = "rgba(255,255,255,.06)"; ctx.fillStyle = "#8b89ad";
    for (let k = 0; k <= 4; k++) {
      const v = lo + (hi - lo) * k / 4;
      ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(w - pad.r, Y(v)); ctx.stroke();
      ctx.fillText(Math.round(v), 2, Y(v) + 4);
    }
    if (opts.xlabel) ctx.fillText(opts.xlabel, w - pad.r - ctx.measureText(opts.xlabel).width, h - 4);
    seriesList.forEach((s) => {
      ctx.beginPath();
      s.data.forEach((v, i) => { i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)); });
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 2; ctx.setLineDash(s.dash || []); ctx.stroke(); ctx.setLineDash([]);
    });
  }

  function drawHistogram(canvas) {
    const { ctx, w, h } = fitCanvas(canvas);
    const pad = { l: 10, r: 10, t: 12, b: 20 };
    const bins = 30, lo = 0.3, hi = 0.85;
    const hist = (arr) => {
      const b = new Array(bins).fill(0);
      arr.forEach((s) => { b[clamp(Math.floor((s - lo) / (hi - lo) * bins), 0, bins - 1)]++; });
      return b.map((v) => v / arr.length);
    };
    const hn = hist(guard.scores.normal), ha = hist(guard.scores.attack);
    const max = Math.max(...hn, ...ha);
    const bw = (w - pad.l - pad.r) / bins;
    const Y = (v) => (v / max) * (h - pad.t - pad.b);
    [[hn, "rgba(62,224,143,.6)"], [ha, "rgba(255,84,112,.6)"]].forEach(([arr, c]) => {
      ctx.fillStyle = c;
      arr.forEach((v, i) => ctx.fillRect(pad.l + i * bw + 1, h - pad.b - Y(v), bw - 2, Y(v)));
    });
    const tx = pad.l + (guard.threshold - lo) / (hi - lo) * (w - pad.l - pad.r);
    ctx.strokeStyle = "#ffb547"; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(tx, pad.t); ctx.lineTo(tx, h - pad.b); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#ffb547"; ctx.fillText(`threshold ${guard.threshold.toFixed(2)}`, tx + 4, pad.t + 10);
    ctx.fillStyle = "#8b89ad"; ctx.fillText("anomaly score →", w - 110, h - 4); ctx.fillText(lo, pad.l, h - 4);
  }

  function drawPolicy() {
    // greedy action in the most frequently visited situation for each hour × base-load cell
    const grid = $("#policyGrid");
    const hours = ["00", "03", "06", "09", "12", "15", "18", "21"];
    const bases = ["<400", "400–550", "550–680", "680+"];
    let html = `<div class="pg-corner">base \\ hour</div>` + hours.map((h) => `<div class="pg-h">${h}</div>`).join("");
    for (let bb = 3; bb >= 0; bb--) {
      html += `<div class="pg-h">${bases[bb]}</div>`;
      for (let hb = 0; hb < 8; hb++) {
        let s = 0, best = -1;
        for (let qb = 0; qb < 4; qb++) for (let tb = 0; tb < 3; tb++) for (let pb = 0; pb < 3; pb++) {
          const k = ((((hb * 4 + bb) * 4 + qb) * 3 + tb) * 3 + pb);
          if (agent.q.visits[k] > best) { best = agent.q.visits[k]; s = k; }
        }
        const visited = best > 0;
        const f = ACTIONS[agent.q.greedy(s)];
        const hue = visited ? 0.2 + (f - 0.55) / 0.45 * 0.8 : 0;
        html += `<div class="pg-c" style="background:rgba(140,107,255,${hue.toFixed(2)})" title="${visited ? Math.round(f * 100) + "% of headroom" : "state never visited"}">${visited ? Math.round(f * 100) : "·"}</div>`;
      }
    }
    grid.innerHTML = html;
  }

  function renderResults() {
    const m = forecaster.metrics;
    $("#fcMetrics").innerHTML = `
      <div><span>MLP test MAE</span><b>${fmt(m.mae)} kW</b></div>
      <div><span>Seasonal-naive MAE</span><b>${fmt(m.seasonalMAE)} kW</b></div>
      <div><span>Error reduction</span><b class="good">${Math.round(m.improvement * 100)}%</b></div>
      <div><span>R² (test)</span><b>${m.r2.toFixed(2)}</b></div>`;
    const ts = forecaster.testSeries.slice(-24 * 5);
    lineChart($("#fcTest"), [
      { data: ts.map((t) => t.y), color: "rgba(140,107,255,.9)" },
      { data: ts.map((t) => t.p), color: "#ffb547", dash: [5, 3] },
    ], { min: 0, xlabel: "last 5 test days (hourly)" });

    const R = agent.results;
    const row = (name, k, cls) => `<tr class="${cls}"><td>${name}</td><td>${R[k].overloads}</td><td>${fmt(R[k].peakKW)}</td><td>${R[k].energyMWh.toFixed(1)}</td><td>${fmt(R[k].avgQueue)}</td></tr>`;
    $("#rlTable").innerHTML = `<thead><tr><th>Policy (30 unseen days)</th><th>Overloads</th><th>EV peak kW</th><th>Energy MWh</th><th>Avg queue kWh</th></tr></thead>
      <tbody>${row("Static limits", "static", "")}${row("Cloud rules (950 − base)", "rules", "")}${row("GridSync RL agent", "ai", "best")}</tbody>`;
    const ovCut = 1 - R.ai.overloads / Math.max(1, R.rules.overloads);
    const pkCut = 1 - R.ai.peakKW / R.rules.peakKW;
    $("#rlSummary").innerHTML = `Compared with the fixed cloud rule, the agent cut overload events by <b>${Math.round(ovCut * 100)}%</b> and the EV demand peak by <b>${Math.round(pkCut * 100)}%</b>, delivering <b>${Math.round(R.ai.energyMWh / R.rules.energyMWh * 100)}%</b> of the energy.`;
    drawPolicy();

    const g = guard.metrics;
    $("#idsMetrics").innerHTML = `
      <div><span>Attack recall</span><b class="good">${Math.round(g.recall * 100)}%</b></div>
      <div><span>False-positive rate</span><b>${(g.fpr * 100).toFixed(1)}%</b></div>
      ${Object.entries(g.tpr).map(([k, v]) => `<div><span>${guard.ATTACKS[k]}</span><b>${Math.round(v * 100)}%</b></div>`).join("")}`;
    drawHistogram($("#idsHist"));
    $("#labStatus").textContent = "All models trained ✓";
    $("#labStatus").className = "lab-status ok";
  }

  // Runs a training generator in small slices so the page stays animated.
  // setTimeout (not requestAnimationFrame) keeps training going in background tabs.
  function pump(gen, onStep, budgetMs = 14) {
    return new Promise((resolve) => {
      const slice = () => {
        const t0 = performance.now();
        const budget = document.hidden ? 400 : budgetMs;
        let r;
        do { r = gen.next(); if (!r.done) onStep(r.value); } while (!r.done && performance.now() - t0 < budget);
        r.done ? resolve() : setTimeout(slice, 0);
      };
      setTimeout(slice, 0);
    });
  }

  async function trainAll() {
    S.aiReady = false;
    $("#retrainBtn").disabled = true;
    const status = $("#labStatus");
    status.className = "lab-status run";
    log("SageMaker training job started: forecaster, RL agent, intrusion detector", "sm");

    status.textContent = "Training demand forecaster (MLP)…";
    forecaster.build();
    await pump(forecaster.trainSteps(), (p) => {
      $("#fcEpoch").textContent = `epoch ${p.epoch}/${p.epochs} · train RMSE ${fmt(p.rmse)} kW · test MAE ${fmt(p.testMAE)} kW`;
      lineChart($("#fcLoss"), [
        { data: forecaster.lossCurve.map((c) => c.train), color: "#8c6bff" },
        { data: forecaster.lossCurve.map((c) => c.test), color: "#2fd6c6" },
      ], { min: 0, n: p.epochs, xlabel: "epoch" });
    }, 8);

    status.textContent = "Training RL agent (Q-learning, 6,000 simulated days)…";
    agent.reset();
    await pump(agent.trainSteps(), (p) => {
      $("#rlEp").textContent = `episode ${fmt(p.episode)}/${fmt(p.episodes)} · avg reward ${p.avgReward.toFixed(1)}`;
      lineChart($("#rlCurve"), [{ data: agent.curve, color: "#3ee08f" }], { n: p.episodes / 150, xlabel: "training episodes" });
    }, 8);

    status.textContent = "Fitting Isolation Forest on telemetry stream…";
    await sleep(50);
    guard.train();

    if (!Object.keys(S.hourly).length) prefillHourly();
    S.aiReady = true;
    $("#retrainBtn").disabled = false;
    renderResults();
    drawForecast();
    log(`Models deployed: forecaster MAE ${fmt(forecaster.metrics.mae)} kW, RL agent ready, IDS recall ${Math.round(guard.metrics.recall * 100)}%`, "sm");
  }
  $("#retrainBtn").addEventListener("click", trainAll);

  // ---------- Architecture explorer ----------
  const ARCH = {
    utility: ["Utility (OpenADR)", "Detects substation stress and sends a demand-response event such as “reduce load at this site by 30% for 20 minutes”.", "Source signal"],
    apigw: ["Amazon API Gateway", "The authenticated HTTPS entry point for utility OpenADR events. It validates each request and hands it to Lambda.", "Pillar 1 · Protocol disconnect"],
    lambda: ["AWS Lambda (translator)", "Parses the OpenADR payload, works out which sites and chargers it applies to, and converts it into OCPP-ready power-limit commands.", "Pillar 1 · Protocol disconnect"],
    sfn: ["AWS Step Functions + Lambda", "The decision engine. It reads transformer load and charger state, calls the SageMaker endpoint for the forecast and the RL action, splits the budget fairly across sessions and writes the result, inside the 2-second target.", "Pillar 2 · Latency at scale"],
    ddb: ["Amazon DynamoDB", "Keeps the live state of every charger: connected or not, charging or idle, current draw, last assigned limit and current anomaly score.", "Pillar 3 · Static allocation"],
    iot: ["AWS IoT Core", "Holds persistent MQTT-over-WebSocket connections for OCPP and authenticates every charger with X.509 over mutual TLS. When the AI guard flags a charger, its certificate is set to INACTIVE, which cuts it off immediately.", "Pillar 4 · Edge security"],
    kinesis: ["Kinesis + AI telemetry guard", "Absorbs high-frequency meter readings. A Lambda consumer scores every message with the Isolation Forest, using physics features such as whether P matches V×I and whether the charger obeys its commanded limit.", "Pillar 4 · Edge security (AI)"],
    ts: ["Amazon Timestream", "Time-series store for the telemetry. It feeds step 1 of every decision cycle and is the training data for the forecaster.", "Pillar 2 · Latency at scale"],
    sm: ["Amazon SageMaker", "Trains and hosts the three models: the MLP demand forecaster, the Q-learning charging agent and the Isolation Forest. They retrain nightly and are served from a serverless inference endpoint.", "Pillar 3 · AI allocation"],
    charger: ["DC fast charger (150–350 kW)", "Runs OCPP, receives AI-computed limits from IoT Core and streams meter values back up through Kinesis. Each charger holds its own private key.", "Edge device"],
  };
  $$("#arch .node").forEach((n) => n.addEventListener("click", () => {
    $$("#arch .node").forEach((x) => x.classList.remove("sel"));
    n.classList.add("sel");
    const [t, d, s] = ARCH[n.dataset.k];
    $("#archInfo").innerHTML = `<h3>${t}</h3><p>${d}</p><span class="solves">${s}</span>`;
  }));

  // ---------- Literature timeline ----------
  const PAPERS = [
    ["2020", "Remote monitoring & fault detection for EV charging devices · Gao et al.", "Centralized cloud streaming of charger telemetry.", "Showed that cloud streaming works for continuous telemetry.", "Narrow fault logic that does not react to grid load."],
    ["2022", "Concept review of a cloud-based smart BMS · MDPI Batteries", "Split between local BMS functions and cloud compute.", "Clear framework for what belongs in the cloud and what stays local.", "Conceptual only, with no deployment or data."],
    ["2023", "Cloud framework for scalable battery analytics · Karnehm et al.", "Cloud telemetry with EKF real-time SoC prediction.", "Moved from passive monitoring to predictive analytics.", "EKF assumes linear behaviour and breaks down on aged batteries."],
    ["2023", "Charge-curve & BMS-aware optimal charging scheduling · IEEE T-ITS", "Condition-aware scheduling at one fast-charging site.", "Dynamic limits instead of a flat per-bay limit.", "No coordination with the upstream grid."],
    ["2024", "Review of cloud-based Li-ion BMS for EVs · IEEE Access", "Survey of cloud-BMS frameworks and platforms.", "Broad, structured comparison.", "Review only; leaves the gaps it identifies open."],
    ["2024", "Key technologies for cloud-based BMS · J. Electronic Materials", "Data, protocols, AI/ML, digital twins, edge.", "Useful map of the technology stack.", "Treats layers separately rather than as one real-time system."],
    ["2024", "AI + blockchain demand response for EV charging · Scientific Reports", "AI forecasting with blockchain trust.", "Handles load balancing and security together.", "Consensus overhead conflicts with sub-second targets."],
    ["2026", "Cloud AI framework for EV charging forecasting · Electronics", "ARIMA + LightGBM containerized microservices.", "Strong forecasting accuracy on real data.", "Built for planning, not live reactive control."],
    ["2026", "Edge-intelligent EV charging coordination · Cluster Computing", "CNN+LSTM, XGBoost on Jetson / Raspberry Pi.", "27.6% better utilization and 24.5% lower peak load.", "Adds hardware cost and complexity at every site."],
    ["2026", "Autonomous edge-deployed AI agents for EV charging", "Domain-specialized agents at the edge, < 100 ms.", "Response far faster than a cloud round trip.", "Harder to audit and to coordinate grid-wide."],
  ];
  $("#timeline").innerHTML = PAPERS.map(([y, t, a, p, m]) => `
    <article class="card tl reveal"><span class="yr">${y}</span><h3>${t}</h3><p>${a}</p>
      <div class="pm"><div class="plus">+ ${p}</div><div class="minus">− ${m}</div></div></article>`).join("");

  // ---------- Cost estimator ----------
  function updateCost() {
    const n = Number($("#costRange").value);
    const fixed = 1800 + Math.ceil(n / 200) * 950;
    const sl = 35 + n * 0.62 + Math.ceil(n / 1000) * 25 + 120; // + SageMaker serverless inference & nightly training
    $("#cN").textContent = fmt(n);
    $("#cFixed").textContent = `$${fmt(fixed)}/mo`;
    $("#cSl").textContent = `$${fmt(sl)}/mo`;
    const m = Math.max(fixed, sl);
    $("#cbFixed").style.width = (fixed / m * 100) + "%";
    $("#cbSl").style.width = (sl / m * 100) + "%";
  }
  $("#costRange").addEventListener("input", updateCost);
  updateCost();

  // ---------- Reveal + counters ----------
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add("in");
      e.target.querySelectorAll("[data-count]").forEach(countUp);
      io.unobserve(e.target);
    });
  }, { threshold: 0.12 });
  $$(".reveal").forEach((el) => io.observe(el));

  function countUp(el) {
    const end = Number(el.dataset.count), dec = Number(el.dataset.decimals || 0);
    const pre = el.dataset.prefix || "", suf = el.dataset.suffix || "";
    const t0 = performance.now(), dur = 1600;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = pre + (end * e).toFixed(dec) + suf;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------- Boot ----------
  buildBays();
  [0, 2, 5].forEach((i) => { S.bays[i].car = newCar(); });
  for (let i = 0; i < 40; i++) pushHistory(W.base(hourOf() - (40 - i) * 0.025, S.day), 260 + Math.random() * 40);
  log("GridSync online · 8 chargers connected to AWS IoT Core over mTLS", "ok");
  setInterval(tick, TICK_MS);
  window.addEventListener("resize", () => { drawLoadChart(); drawForecast(); if (S.aiReady) renderResults(); });
  trainAll();
})();

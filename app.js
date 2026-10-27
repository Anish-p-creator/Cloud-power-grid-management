/* GridSync: simulated AWS-controlled EV fast-charging hub.
   All data is generated in the browser for demonstration. */
(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const fmt = (n) => Math.round(n).toLocaleString("en-IN");

  // ---------- Model constants ----------
  const RATED_KW = 1000;
  const SAFE_KW = 950;
  const TICK_MS = 250;
  const BAY_RATINGS = [350, 350, 150, 150, 350, 150, 350, 150];
  const CARS = ["🚗", "🚙", "🚘", "🚐"];

  const S = {
    mode: "smart",
    paused: false,
    speed: 6,
    simMin: 17 * 60 + 30,
    bays: BAY_RATINGS.map((r, i) => ({ id: i + 1, rating: r, car: null, limit: r, draw: 0, connected: true, offlineFor: 0 })),
    history: [],
    trips: 0,
    trippedFor: 0,
    overTicks: 0,
    peakActual: 0,
    peakBaseline: 0,
    adr: null,           // { cap, left (sim minutes) }
    adrPending: false,
    lastReact: null,
    wfBusy: false,
  };

  // ---------- Grid model ----------
  const gauss = (x, mu, sd) => Math.exp(-((x - mu) ** 2) / (2 * sd * sd));
  function baseLoad(min) {
    const h = (min / 60) % 24;
    return 230 + 140 * gauss(h, 8.5, 1.8) + 380 * gauss(h, 19, 2.2) + 15 * Math.sin(min / 7);
  }
  function arrivalRate(h) { // expected arrivals per sim-minute
    return 0.012 + 0.11 * gauss(h, 18.2, 1.6) + 0.04 * gauss(h, 12.5, 2);
  }
  function taper(soc) { return soc < 0.8 ? 1 : clamp(1 - (soc - 0.8) * 4, 0.2, 1); }
  function demandOf(bay) {
    if (!bay.car || !bay.connected) return 0;
    return bay.rating * bay.car.accept * taper(bay.car.soc);
  }

  function newCar(lowSoc) {
    return {
      icon: CARS[Math.floor(Math.random() * CARS.length)],
      soc: lowSoc ? rand(0.08, 0.3) : rand(0.1, 0.6),
      target: rand(0.8, 0.95),
      cap: rand(60, 100),         // battery kWh
      accept: rand(0.75, 1),      // max acceptance as fraction of charger rating
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
    S.bays.forEach((b) => { if (!demandOf(b)) b.limit = b.rating; });
  }

  // ---------- Simulation tick ----------
  function tick() {
    if (S.paused) return;
    const dtMin = S.speed * 0.25;
    S.simMin = (S.simMin + dtMin) % 1440;
    const hour = S.simMin / 60;
    const base = baseLoad(S.simMin);

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
      if (!b.car && b.connected && Math.random() < arrivalRate(hour) * dtMin) {
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
      } else if (Math.random() < 0.0015) {
        b.connected = false; b.offlineFor = 2500;
        log(`Bay ${b.id}: cellular link dropped, IoT Core holding session`, "err");
      }
    });

    if (S.adr) S.adr.left -= dtMin;
    if (S.adr && S.adr.left <= 0) {
      log("OpenADR event ended, normal allocation resumed", "adr");
      S.adr = null; $("#adrBtn").disabled = false;
    }

    const totalDemand = S.bays.reduce((s, b) => s + demandOf(b), 0);

    if (S.mode === "smart") {
      let budget = SAFE_KW - base;
      if (S.adr) budget = Math.min(budget, S.adr.cap);
      if (forecastPeakSoon()) budget *= 0.93;
      allocate(budget);
      S.bays.forEach((b) => { b.draw = Math.min(demandOf(b), b.limit); });
    } else {
      S.bays.forEach((b) => { b.limit = b.rating; b.draw = demandOf(b); });
    }

    // charge the cars
    S.bays.forEach((b) => {
      if (b.car && b.draw > 0) b.car.soc = Math.min(1, b.car.soc + (b.draw * dtMin / 60) / b.car.cap);
    });

    const ev = S.bays.reduce((s, b) => s + b.draw, 0);
    const total = base + ev;
    S.peakActual = Math.max(S.peakActual, ev);
    S.peakBaseline = Math.max(S.peakBaseline, totalDemand);

    // overload protection
    if (total > RATED_KW) S.overTicks++; else S.overTicks = 0;
    if (S.overTicks >= 3) {
      S.trips++; S.trippedFor = 4500; S.overTicks = 0;
      $("#tripBanner").classList.add("show");
      log(`FEEDER TRIP: transformer at ${Math.round(total / RATED_KW * 100)}%, relay opened`, "err");
    }

    pushHistory(base, ev);

    // the decision loop runs continuously in smart mode
    if (S.mode === "smart" && !S.wfBusy) {
      if (S.adrPending) { S.adrPending = false; runWorkflow(true); }
      else if (Math.random() < 0.08) runWorkflow(false);
    }
    if (Math.random() < 0.35) {
      const b = S.bays[Math.floor(Math.random() * 8)];
      if (b.draw > 0) log(`kinesis ← bay-${b.id} {V: ${Math.round(rand(395, 410))}, I: ${Math.round(b.draw * 1000 / 400)}A, P: ${b.draw.toFixed(1)}kW}`, "t2");
    }

    render(base, ev);
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
    const lat = [rand(40, 90), rand(60, 140), rand(70, 160), rand(15, 35), rand(80, 220), rand(15, 35), rand(110, 260)];
    const start = fromAdr ? 0 : 2;
    if (!fromAdr) for (let i = 0; i < 2; i++) { steps[i].querySelector("em").textContent = "skip"; }
    $("#wfStatus").textContent = fromAdr ? "OpenADR-triggered execution" : "periodic rebalance";
    let total = 0;
    for (let i = start; i < steps.length; i++) {
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

  // ---------- SageMaker forecast ----------
  const forecast = Array.from({ length: 24 }, (_, h) => {
    const arr = arrivalRate(h + 0.5);
    return Math.round(arr * 60 * 180 + 40 + 20 * Math.sin(h));
  });
  const fcPeakHour = forecast.indexOf(Math.max(...forecast));
  function forecastPeakSoon() {
    const h = S.simMin / 60;
    return h >= fcPeakHour - 0.5 && h < fcPeakHour + 1;
  }

  // ---------- Canvas helpers ----------
  function fitCanvas(c) {
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = Number(c.getAttribute("height"));
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.height = h + "px"; }
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  function drawLoadChart() {
    const { ctx, w, h } = fitCanvas($("#loadChart"));
    ctx.clearRect(0, 0, w, h);
    const pad = { l: 46, r: 10, t: 10, b: 20 };
    const maxV = Math.max(1300, ...S.history.map((p) => p.base + p.ev)) * 1.08;
    const X = (i) => pad.l + (i / 179) * (w - pad.l - pad.r);
    const Y = (v) => h - pad.b - (v / maxV) * (h - pad.t - pad.b);

    ctx.font = "11px JetBrains Mono, monospace";
    ctx.fillStyle = "#8b89ad"; ctx.strokeStyle = "rgba(255,255,255,.06)"; ctx.lineWidth = 1;
    for (let v = 0; v <= maxV; v += 250) {
      ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(w - pad.r, Y(v)); ctx.stroke();
      ctx.fillText(v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 2 : 0) + "MW" : v, 4, Y(v) + 4);
    }
    const n = S.history.length;
    if (n > 1) {
      const off = 180 - n;
      const area = (fn, fill, line) => {
        ctx.beginPath();
        S.history.forEach((p, i) => { const x = X(i + off), y = Y(fn(p)); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.lineTo(X(n - 1 + off), Y(0)); ctx.lineTo(X(off), Y(0)); ctx.closePath();
        ctx.fillStyle = fill; ctx.fill();
        ctx.beginPath();
        S.history.forEach((p, i) => { const x = X(i + off), y = Y(fn(p)); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.strokeStyle = line; ctx.lineWidth = 2; ctx.stroke();
      };
      const g = ctx.createLinearGradient(0, pad.t, 0, h);
      g.addColorStop(0, "rgba(140,107,255,.75)"); g.addColorStop(1, "rgba(140,107,255,.15)");
      area((p) => p.base + p.ev, g, "#8c6bff");
      area((p) => p.base, "rgba(75,74,134,.85)", "#6f6db5");
    }
    // capacity lines
    ctx.setLineDash([]); ctx.strokeStyle = "#ff5470"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(pad.l, Y(RATED_KW)); ctx.lineTo(w - pad.r, Y(RATED_KW)); ctx.stroke();
    ctx.setLineDash([5, 5]); ctx.strokeStyle = "#ffb547"; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(pad.l, Y(SAFE_KW)); ctx.lineTo(w - pad.r, Y(SAFE_KW)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#ff5470"; ctx.fillText("rated 1 MW", w - 90, Y(RATED_KW) - 6);
    if (S.adr) {
      const capLine = baseLoadNow() + S.adr.cap;
      ctx.setLineDash([2, 4]); ctx.strokeStyle = "#2fd6c6";
      ctx.beginPath(); ctx.moveTo(pad.l, Y(capLine)); ctx.lineTo(w - pad.r, Y(capLine)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = "#2fd6c6"; ctx.fillText("OpenADR cap", pad.l + 6, Y(capLine) - 6);
    }
  }
  const baseLoadNow = () => baseLoad(S.simMin);

  function drawForecast() {
    const { ctx, w, h } = fitCanvas($("#fcChart"));
    ctx.clearRect(0, 0, w, h);
    const pad = { l: 8, r: 8, t: 14, b: 22 };
    const max = Math.max(...forecast) * 1.1;
    const bw = (w - pad.l - pad.r) / 24;
    const curH = Math.floor(S.simMin / 60);
    ctx.font = "10px JetBrains Mono, monospace";
    forecast.forEach((v, i) => {
      const bh = (v / max) * (h - pad.t - pad.b);
      const x = pad.l + i * bw + 2, y = h - pad.b - bh;
      ctx.fillStyle = i === curH ? "#2fd6c6" : i === fcPeakHour ? "#ffb547" : "rgba(140,107,255,.55)";
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, bw - 4, bh, 3) : ctx.rect(x, y, bw - 4, bh); ctx.fill();
      if (i % 3 === 0) { ctx.fillStyle = "#8b89ad"; ctx.fillText(String(i).padStart(2, "0"), x, h - 6); }
    });
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
        <span class="zap">⚡</span>`;
      wrap.appendChild(el);
      bayEls.push(el);
    });
  }

  function render(base, ev) {
    const total = base + ev;
    const pct = total / RATED_KW * 100;
    const hh = Math.floor(S.simMin / 60), mm = Math.floor(S.simMin % 60);
    $("#simClock").textContent = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;

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
    $("#kTripSub").textContent = S.trippedFor > 0 ? "FEEDER DARK" : S.trips ? "nuisance trips recorded" : "feeder healthy";

    const conn = S.bays.filter((b) => b.connected).length;
    $("#kConn").textContent = `${conn} / 8 chargers connected`;

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
    $("#gHead").textContent = S.trippedFor > 0 ? "—" : `${fmt(Math.max(0, SAFE_KW - total))} kW`;
    $("#gAdr").textContent = S.adr ? `${fmt(S.adr.cap)} kW` : "none";

    // bays
    S.bays.forEach((b, i) => {
      const el = bayEls[i];
      const dark = S.trippedFor > 0;
      const throttled = b.car && b.draw > 0 && b.draw < demandOf(b) - 1;
      el.className = "bay" + (b.car ? " occupied" : "") + (b.draw > 0 ? " charging" : "") + (throttled ? " throttled" : "") + (dark ? " dark" : "");
      const badge = el.querySelector(".bay-badge");
      badge.textContent = !b.connected ? "RECONNECTING" : dark ? "NO POWER" : throttled ? "BALANCED" : b.draw > 0 ? "CHARGING" : b.car ? "WAITING" : "IDLE";
      if (b.car) el.querySelector(".car").textContent = b.car.icon;
      el.querySelector(".soc i").style.width = b.car ? `${b.car.soc * 100}%` : "0%";
      el.querySelector(".v-soc").textContent = b.car ? `${Math.round(b.car.soc * 100)}%` : "–";
      el.querySelector(".v-draw").textContent = b.draw.toFixed(0);
      const dyn = S.mode === "smart" && b.car;
      el.querySelector(".l-lim").textContent = dyn ? "Dynamic limit" : "Static limit";
      el.querySelector(".v-lim").textContent = `${(dyn ? b.limit : b.rating).toFixed(0)} kW`;
    });

    drawLoadChart();
    if (Math.floor(S.simMin) % 5 === 0) drawForecast();
  }

  // ---------- Log ----------
  let lastLogClock = "";
  function log(msg, cls) {
    const el = $("#log");
    if (!el) return;
    const d = document.createElement("div");
    const clock = $("#simClock") ? $("#simClock").textContent : "";
    d.className = cls || "";
    d.innerHTML = `<span class="t">${clock}</span>${msg}`;
    el.prepend(d);
    while (el.children.length > 60) el.lastChild.remove();
    lastLogClock = clock;
  }

  // ---------- Controls ----------
  function setMode(m) {
    S.mode = m;
    $$(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
    S.peakActual = 0; S.peakBaseline = 0; S.lastReact = null;
    $("#wfTotal").textContent = "—";
    log(m === "smart" ? "Switched to GridSync AWS control (dynamic limits)" : "Switched to static per-charger limits (baseline)", "sm");
  }
  $$(".seg-btn").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("#adrBtn").addEventListener("click", sendAdr);
  $("#rushBtn").addEventListener("click", () => {
    let n = 0;
    S.bays.forEach((b) => { if (!b.car && b.connected) { b.car = newCar(true); n++; } });
    if (S.simMin < 17 * 60 || S.simMin > 20 * 60) S.simMin = 18 * 60;
    log(`Evening rush: ${n} vehicles plugged in at once`, "adr");
  });
  $("#speed").addEventListener("input", (e) => { S.speed = Number(e.target.value); });
  $("#pauseBtn").addEventListener("click", (e) => {
    S.paused = !S.paused;
    e.currentTarget.textContent = S.paused ? "▶ Resume" : "❚❚ Pause";
  });

  // ---------- Architecture explorer ----------
  const ARCH = {
    utility: ["Utility (OpenADR)", "Detects substation stress and sends a demand-response event such as “reduce load at this site by 30% for 20 minutes”.", "Source signal"],
    apigw: ["Amazon API Gateway", "The authenticated HTTPS entry point for utility OpenADR events. It validates each request and hands it to Lambda.", "Pillar 1 · Protocol disconnect"],
    lambda: ["AWS Lambda (translator)", "Parses the OpenADR payload, works out which sites and chargers it applies to, and converts it into OCPP-ready power-limit commands.", "Pillar 1 · Protocol disconnect"],
    sfn: ["AWS Step Functions + Lambda", "The decision engine. It reads transformer load, reads charger state, computes a fair per-session split and writes the result, all as one traceable workflow inside the 2-second target.", "Pillar 2 · Latency at scale"],
    ddb: ["Amazon DynamoDB", "Keeps the live state of every charger: connected or not, charging or idle, current draw and last assigned limit. Single-digit-millisecond reads and writes mean it is never the bottleneck.", "Pillar 3 · Static allocation"],
    iot: ["AWS IoT Core", "Holds persistent MQTT-over-WebSocket connections for OCPP and authenticates every charger with X.509 certificates over mutual TLS. Pushes SetChargingProfile commands.", "Pillar 4 · Edge security"],
    kinesis: ["Amazon Kinesis Data Streams", "Absorbs high-frequency meter readings (voltage, current, power) from every active charger without falling behind during evening spikes.", "Pillar 2 · Latency at scale"],
    ts: ["Amazon Timestream", "Time-series store for the telemetry. Queries like “transformer load over the last 30 s” stay fast as data grows, and this is what feeds step 1 of every decision cycle.", "Pillar 2 · Latency at scale"],
    sm: ["Amazon SageMaker", "Learns from history, e.g. “this site always spikes around 6 PM on weekdays”, so allocation can tighten before a predicted peak instead of after it.", "Pillar 3 · Static allocation"],
    charger: ["DC fast charger (150–350 kW)", "Runs OCPP, receives dynamic limits from IoT Core and streams meter values back up through Kinesis. Each charger holds its own private key.", "Edge device"],
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
    const fixed = 1800 + Math.ceil(n / 200) * 950;          // peak-sized always-on fleet
    const sl = 35 + n * 0.62 + Math.ceil(n / 1000) * 25;    // per-message + storage
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
  // warm-start: a few cars already charging at 17:30
  [0, 2, 5].forEach((i) => { S.bays[i].car = newCar(); });
  for (let i = 0; i < 40; i++) pushHistory(baseLoad(S.simMin - (40 - i) * 1.5), 260 + Math.random() * 40);
  log("GridSync online · 8 chargers connected to AWS IoT Core over mTLS", "ok");
  log("SageMaker forecast loaded: peak expected at " + String(fcPeakHour).padStart(2, "0") + ":00", "sm");
  $("#fcNote").textContent = `Forecast peak at ${String(fcPeakHour).padStart(2, "0")}:00. Allocation tightens 30 minutes ahead.`;
  drawForecast();
  setInterval(tick, TICK_MS);
  window.addEventListener("resize", () => { drawLoadChart(); drawForecast(); });
})();

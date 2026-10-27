/* Live AWS control room: reads the deployed GridSync backend through API Gateway.
   Needs config.json (written by aws/scripts/deploy.ps1) next to index.html. */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const fmt = (n) => Math.round(n || 0).toLocaleString("en-IN");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const STEP_LABELS = {
    readTransformer: ["DynamoDB", "Read transformer load"],
    readChargers: ["DynamoDB", "Read charger status"],
    aiInference: ["Lambda · AI", "MLP forecast + RL policy"],
    computeLimits: ["Lambda", "Compute fair per-session limits"],
    writeState: ["DynamoDB", "Write charger limits"],
    publishOcpp: ["IoT Core", "Publish OCPP SetChargingProfile"],
  };
  let API = null, busy = false, lastState = null;

  async function init() {
    try {
      const r = await fetch("config.json", { cache: "no-store" });
      if (!r.ok) throw new Error();
      const cfg = await r.json();
      API = cfg.apiUrl.replace(/\/$/, "");
      $("#awsRegion").textContent = cfg.region;
      $("#awsApi").textContent = API.replace("https://", "");
    } catch {
      setConn("off", "Not connected: this copy of the site has no AWS config.json (deploy with aws/scripts/deploy.ps1)");
      return;
    }
    bind();
    poll();
    setInterval(poll, 2000);
  }

  function setConn(kind, text) {
    const el = $("#awsConn");
    el.className = "lab-status " + (kind === "on" ? "ok" : "run");
    el.textContent = text;
  }

  async function call(method, path, body) {
    const r = await fetch(API + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  async function poll() {
    if (busy) return;
    busy = true;
    try {
      const s = await call("GET", "/state");
      lastState = s;
      render(s);
    } catch (e) {
      setConn("off", `API unreachable: ${e.message}`);
    } finally { busy = false; }
  }

  function render(s) {
    const m = s.meter;
    const age = m ? (s.serverTime - m.updatedAt) / 1000 : Infinity;
    setConn(age < 12 ? "on" : "off", age < 12
      ? `Live · chargers streaming to AWS IoT Core (${age.toFixed(0)} s ago)`
      : "Backend up · charger simulator offline (run: node sim/charger-sim.js)");

    const total = m ? m.base + m.ev : 0;
    const pct = (total / 1000) * 100;
    const load = $("#awsLoad");
    load.textContent = m ? `${Math.round(pct)}%` : "—";
    load.className = "k-val " + (pct > 100 ? "bad" : pct > 90 ? "warn" : "good");
    $("#awsLoadSub").textContent = m ? `${fmt(m.base)} kW base + ${fmt(m.ev)} kW EV` : "no meter data yet";
    $("#awsClock").textContent = m ? `${String(Math.floor(m.simMin / 60)).padStart(2, "0")}:${String(Math.floor(m.simMin % 60)).padStart(2, "0")}` : "—";
    $("#awsDemand").textContent = m ? `${fmt(m.demand)} kW requested` : "";
    const ex = s.site.lastExecution;
    const kx = $("#awsExec");
    kx.textContent = ex ? `${(ex.totalMs / 1000).toFixed(2)} s` : "—";
    kx.className = "k-val " + (ex && ex.totalMs < 2000 ? "good" : ex ? "bad" : "");
    $("#awsExecSub").textContent = ex ? `trigger: ${ex.trigger} · ${timeAgo(s.serverTime - ex.at)}` : "waiting for first run";
    $("#awsThreats").textContent = s.site.threats || 0;
    $("#awsMode").textContent = s.site.mode === "ai" ? "GridSync AI" : "Cloud rules";
    document.querySelectorAll("[data-aws-mode]").forEach((b) => b.classList.toggle("active", b.dataset.awsMode === s.site.mode));
    const adr = s.site.adr && s.site.adr.until > s.serverTime ? s.site.adr : null;
    $("#awsAdr").textContent = adr ? `OpenADR cap ${fmt(adr.cap)} kW · ${Math.ceil((adr.until - s.serverTime) / 1000)} s left` : "no OpenADR event active";

    renderChargers(s);
    renderExecution(ex);
    drawChart(s.load);
    $("#awsLog").innerHTML = s.events.map((e) =>
      `<div class="${esc(e.cls || "")}"><span class="t">${new Date(e.ts).toLocaleTimeString()}</span>${esc(e.msg)}</div>`).join("") || `<div class="muted">No events yet</div>`;
  }

  const timeAgo = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)} s ago` : `${Math.round(ms / 60000)} min ago`);

  function renderChargers(s) {
    const thr = s.models.idsThreshold;
    $("#awsBays").innerHTML = s.chargers.map((c) => {
      const stale = s.serverTime - c.updatedAt > 12000;
      const st = c.status === "QUARANTINED" ? "QUARANTINED" : stale ? "OFFLINE" : (c.reportedP || 0) > 1 ? "CHARGING" : c.car ? "WAITING" : "IDLE";
      const cls = st === "QUARANTINED" ? "quarantined" : st === "CHARGING" ? "charging" : st === "OFFLINE" ? "dark" : "";
      const score = c.score || 0;
      return `<div class="bay occupied ${cls}">
        <div class="bay-top"><span class="bay-id">${esc(c.deviceId)} · ${c.rating} kW</span><span class="bay-badge">${st}</span></div>
        <div class="soc"><i style="width:${(c.soc || 0) * 100}%"></i></div>
        <div class="bay-row"><span>SoC <b>${Math.round((c.soc || 0) * 100)}%</b></span><span>Reported <b>${(c.reportedP || 0).toFixed(0)}</b> kW</span></div>
        <div class="bay-row"><span>AI limit</span><b>${(c.limit || 0).toFixed(0)} kW</b></div>
        <div class="bay-row"><span>Anomaly score</span><b style="color:${score > thr ? "var(--red)" : "var(--green)"}">${score.toFixed(2)}</b></div>
        <div class="bay-row"><span>Cert</span><b>${c.status === "QUARANTINED" ? "INACTIVE" : "ACTIVE"}</b></div>
      </div>`;
    }).join("") || `<p class="muted">No chargers have reported yet.</p>`;
  }

  function renderExecution(ex) {
    if (!ex) { $("#awsSteps").innerHTML = `<p class="muted">No Step Functions execution yet.</p>`; $("#awsWhy").textContent = ""; return; }
    const max = Math.max(...ex.timeline.map((t) => t.ms), 1);
    $("#awsSteps").innerHTML = ex.timeline.map((t) => {
      const [svc, label] = STEP_LABELS[t.step] || ["", t.step];
      return `<li class="done${t.step === "aiInference" ? " ai-step" : ""}"><span class="svc">${svc}</span><span>${label}<i class="stepbar" style="width:${(t.ms / max) * 100}%"></i></span><em>${t.ms} ms</em></li>`;
    }).join("");
    const d = ex.decision || {};
    let html = `💡 ${esc(d.why || "")}. EV budget <b>${fmt(d.budget)} kW</b>${d.adrCap ? ` (OpenADR cap ${fmt(d.adrCap)} kW)` : ""}.`;
    if (d.q) html += `<div class="qline">Q-values: ${d.q.map((q, i) => `<span class="${Math.round([0.55, 0.7, 0.8, 0.9, 1][i] * 100) === Math.round(d.frac * 100) ? "pick" : ""}">${Math.round([0.55, 0.7, 0.8, 0.9, 1][i] * 100)}% → ${q}</span>`).join("")}</div>`;
    if (d.attrib) html += `<div class="qline">Forecast drivers: ${d.attrib.map((a) => `<span>${esc(a.name)} ${a.kw >= 0 ? "+" : ""}${a.kw} kW</span>`).join("")}</div>`;
    $("#awsWhy").innerHTML = html;
  }

  function drawChart(points) {
    const c = $("#awsChart");
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = Number(c.getAttribute("height"));
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.height = h + "px"; }
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = "11px JetBrains Mono, monospace";
    const pad = { l: 46, r: 10, t: 10, b: 18 };
    const maxV = Math.max(1300, ...points.map((p) => p.base + p.ev)) * 1.08;
    const n = points.length;
    const X = (i) => pad.l + (i / Math.max(1, n - 1)) * (w - pad.l - pad.r);
    const Y = (v) => h - pad.b - (v / maxV) * (h - pad.t - pad.b);
    ctx.strokeStyle = "rgba(255,255,255,.06)"; ctx.fillStyle = "#8b89ad";
    for (let v = 0; v <= maxV; v += 250) { ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(w - pad.r, Y(v)); ctx.stroke(); ctx.fillText(v, 4, Y(v) + 4); }
    if (n > 1) {
      const area = (fn, fill, line) => {
        ctx.beginPath(); points.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(fn(p))) : ctx.moveTo(X(i), Y(fn(p)))));
        ctx.lineTo(X(n - 1), Y(0)); ctx.lineTo(X(0), Y(0)); ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
        ctx.beginPath(); points.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(fn(p))) : ctx.moveTo(X(i), Y(fn(p))))); ctx.strokeStyle = line; ctx.lineWidth = 2; ctx.stroke();
      };
      area((p) => (p.tripped ? 0 : p.base + p.ev), "rgba(140,107,255,.45)", "#8c6bff");
      area((p) => (p.tripped ? 0 : p.base), "rgba(75,74,134,.85)", "#6f6db5");
    }
    ctx.strokeStyle = "#ff5470"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(pad.l, Y(1000)); ctx.lineTo(w - pad.r, Y(1000)); ctx.stroke();
    ctx.fillStyle = "#ff5470"; ctx.fillText("rated 1 MW", w - 90, Y(1000) - 6);
    if (!n) { ctx.fillStyle = "#8b89ad"; ctx.fillText("waiting for telemetry from DynamoDB…", pad.l + 10, h / 2); }
  }

  async function action(btn, fn) {
    btn.disabled = true;
    try { await fn(); } catch (e) { $("#awsResult").innerHTML = `<span class="bad">✖ ${esc(e.message)}</span>`; }
    finally { btn.disabled = false; poll(); }
  }

  function bind() {
    document.querySelectorAll("[data-aws-mode]").forEach((b) => b.addEventListener("click", () =>
      action(b, () => call("POST", "/mode", { mode: b.dataset.awsMode }))));
    $("#awsAdrBtn").addEventListener("click", (e) => action(e.currentTarget, async () => {
      $("#awsResult").textContent = "POST /openadr → API Gateway → Lambda → Step Functions (sync)…";
      const t0 = performance.now();
      const r = await call("POST", "/openadr", { eventID: `evt-${Date.now()}`, signal: { type: "LOAD_DISPATCH", value: -30 }, demoSeconds: 120 });
      const rtt = performance.now() - t0;
      $("#awsResult").innerHTML = `✓ OpenADR <b>${esc(r.oadrResponse.eventID)}</b> opted in. Cloud reaction <b class="good">${(r.reactionMs / 1000).toFixed(2)} s</b> (browser round trip ${(rtt / 1000).toFixed(2)} s), EV cap ${fmt(r.capKW)} kW sent to ${Object.keys(r.limits).length} chargers.`;
    }));
    $("#awsRushBtn").addEventListener("click", (e) => action(e.currentTarget, () => call("POST", "/demo", { action: "rush" }).then(() => { $("#awsResult").textContent = "Evening rush sent to the chargers over IoT Core."; })));
    $("#awsAttackBtn").addEventListener("click", (e) => action(e.currentTarget, () => call("POST", "/demo", { action: "attack" }).then(() => { $("#awsResult").textContent = "Attack injected. Watch the anomaly scores: in AI mode the guard revokes the certificate."; })));
    $("#awsRestoreBtn").addEventListener("click", (e) => action(e.currentTarget, () => call("POST", "/demo", { action: "restore" }).then((r) => { $("#awsResult").textContent = `${r.restored} certificate(s) re-activated.`; })));
    window.addEventListener("resize", () => lastState && drawChart(lastState.load));
  }

  init();
})();

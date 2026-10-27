/* GridSync edge simulator: 8 DC fast chargers + 1 transformer meter.
   Each device is a real AWS IoT Core thing with its own X.509 certificate (mutual TLS).
   - publishes OCPP-style meter values to gridsync/<thing>/telemetry every 2 s
   - obeys SetChargingProfile commands from gridsync/<thing>/cmd
   - reacts to demo commands (rush / attack / restore) on gridsync/sim/demo
   If the cloud AI guard revokes a charger's certificate, IoT Core refuses the
   connection and that charger stops: that is the zero-trust quarantine.
   Usage: node charger-sim.js [--speed 2]   (sim minutes per real second) */
const fs = require("fs");
const path = require("path");
const mqtt = require("mqtt");
const root = path.resolve(__dirname, "..");
require(path.join(root, "ml.js"));
require(path.join(root, "ai.js"));
const { W, guard } = globalThis.GridAI;

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const CERTS = path.join(__dirname, "certs");
const argSpeed = process.argv.indexOf("--speed");
const SPEED = argSpeed > 0 ? Number(process.argv[argSpeed + 1]) : 2;
const RATINGS = [350, 350, 150, 150, 350, 150, 350, 150];
const rng = globalThis.ML.rng(Date.now() & 0xffff);
const rand = (a, b) => a + Math.random() * (b - a);

const S = { day: 120, simMin: 17 * 60 + 30, spike: 0, over: 0, trippedUntil: 0, tripNow: false };
const chargers = RATINGS.map((rating, i) => ({
  id: `charger-${String(i + 1).padStart(2, "0")}`, rating, car: null, limit: 0, draw: 0,
  attack: null, connected: false, client: null, isolated: false,
}));
const newCar = (low) => ({ soc: low ? rand(0.08, 0.3) : rand(0.1, 0.6), target: rand(0.8, 0.95), cap: rand(60, 100), accept: rand(0.75, 1) });
const taper = (soc) => (soc < 0.8 ? 1 : Math.max(0.2, 1 - (soc - 0.8) * 4));
const demandOf = (c) => (c.car && c.connected ? c.rating * c.car.accept * taper(c.car.soc) : 0);
const clock = () => `${String(Math.floor(S.simMin / 60)).padStart(2, "0")}:${String(Math.floor(S.simMin % 60)).padStart(2, "0")}`;
const log = (...a) => console.log(`[${clock()}]`, ...a);

function connect(id, onMessage) {
  const dir = path.join(CERTS, id);
  const client = mqtt.connect(`mqtts://${cfg.iotEndpoint}:8883`, {
    clientId: id,
    key: fs.readFileSync(path.join(dir, "private.key")),
    cert: fs.readFileSync(path.join(dir, "cert.pem")),
    ca: fs.readFileSync(path.join(CERTS, "AmazonRootCA1.pem")),
    protocol: "mqtts", reconnectPeriod: 4000, connectTimeout: 8000, clean: true,
  });
  client.on("message", (topic, buf) => { try { onMessage(topic, JSON.parse(buf.toString())); } catch { /* ignore bad frames */ } });
  return client;
}

// ---- chargers ----
for (const c of chargers) {
  c.client = connect(c.id, (topic, msg) => {
    if (topic.endsWith("/cmd") && msg.action === "SetChargingProfile") c.limit = msg.limitKW;
    if (topic === "gridsync/sim/demo") demo(msg);
  });
  c.client.on("connect", () => {
    const was = c.connected; c.connected = true;
    c.client.subscribe([`gridsync/${c.id}/cmd`, ...(c.id === "charger-01" ? ["gridsync/sim/demo"] : [])], { qos: 1 });
    log(`${c.id}: connected to AWS IoT Core (mTLS ok)${was ? "" : ""}`);
  });
  c.client.on("close", () => {
    if (c.connected) log(`${c.id}: ✖ disconnected by AWS IoT Core${c.attack ? " (certificate revoked by the AI guard)" : ""}`);
    c.connected = false; c.limit = 0;
  });
  c.client.on("error", (e) => { if (!/ECONNRESET|closed/i.test(e.message)) log(`${c.id}: ${e.message}`); });
}
// ---- transformer meter + site controller (trusted device that owns the bay contactors) ----
const meter = connect("transformer-01", (topic, msg) => {
  if (topic === "gridsync/sim/demo") return demo(msg);
  const c = chargers.find((x) => x.id === msg.deviceId);
  if (!c) return;
  if (msg.action === "IsolateBay") { c.isolated = true; log(`⛔ site controller opened the contactor of ${c.id} (cloud AI guard order)`); }
  if (msg.action === "ReconnectBay") { c.isolated = false; c.attack = null; log(`✔ ${c.id} contactor closed again after re-provisioning`); }
});
meter.on("connect", () => { meter.subscribe(["gridsync/sim/demo", "gridsync/transformer-01/cmd"], { qos: 1 }); log("transformer-01: connected"); });

const seenDemo = new Set();
function demo(msg) {
  const key = JSON.stringify(msg) + Math.floor(Date.now() / 1500);
  if (seenDemo.has(key)) return; // delivered to two subscribers
  seenDemo.add(key);
  if (msg.action === "rush") {
    let n = 0;
    chargers.forEach((c) => { if (!c.car && c.connected) { c.car = newCar(true); n++; } });
    if (S.simMin < 17 * 60 || S.simMin > 20 * 60) S.simMin = 18 * 60;
    log(`DEMO evening rush: ${n} cars plugged in`);
  } else if (msg.action === "attack") {
    const targets = chargers.filter((c) => c.connected && c.car && !c.attack);
    const c = chargers.find((x) => x.id === msg.chargerId) || targets[Math.floor(Math.random() * targets.length)];
    if (!c) return log("DEMO attack: no active charger to compromise");
    if (!c.car) c.car = newCar(true);
    const kinds = Object.keys(guard.ATTACKS);
    c.attack = kinds[Math.floor(Math.random() * kinds.length)];
    log(`DEMO ☠ ${c.id} compromised: ${guard.ATTACKS[c.attack]}`);
  } else if (msg.action === "restore") {
    chargers.forEach((c) => { c.attack = null; c.isolated = false; });
    log("DEMO restore: attacks cleared, revoked chargers will reconnect");
  }
}

// ---- physics: 1 real second per step ----
setInterval(() => {
  const dt = SPEED; // sim minutes
  S.simMin += dt;
  if (S.simMin >= 1440) { S.simMin -= 1440; S.day++; }
  const h = S.simMin / 60;
  S.spike *= Math.pow(0.45, dt / 15);
  if (Math.random() < ((h >= 17 && h <= 21) ? 0.14 : 0.05) * dt / 15) S.spike += rand(50, 160);
  const base = W.base(h, S.day) + S.spike + 12 * Math.sin(S.simMin / 7);
  const tripped = Date.now() < S.trippedUntil;

  for (const c of chargers) {
    if (!c.car && c.connected && Math.random() < W.arrival(h, S.day) * dt) c.car = newCar();
    if (c.car && c.car.soc >= c.car.target) { c.car = null; }
    const d = demandOf(c);
    c.draw = tripped || !c.connected || c.isolated ? 0 : c.attack && c.car ? c.rating * c.car.accept : Math.min(d, c.limit);
    if (c.car && c.draw > 0) c.car.soc = Math.min(1, c.car.soc + (c.draw * dt / 60) / c.car.cap);
  }
  const ev = chargers.reduce((a, c) => a + c.draw, 0);
  const demand = chargers.reduce((a, c) => a + demandOf(c), 0);
  S.tripNow = false;
  // protection relay: trips after ~6 s of sustained overload (thermal tolerance)
  if (!tripped && base + ev > W.RATED) { if (++S.over >= 6) { S.trippedUntil = Date.now() + 10000; S.over = 0; S.tripNow = true; log(`⛔ FEEDER TRIP at ${Math.round((base + ev) / 10)}%`); } }
  else S.over = 0;
  S.last = { base, ev, demand, tripped };

  const pct = Math.round(((tripped ? 0 : base + ev) / W.RATED) * 100);
  const bays = chargers.map((c) => (c.isolated ? "⛔" : !c.connected ? "✖" : c.attack ? "☠" : c.draw > 0 ? "⚡" : c.car ? "·" : "_")).join("");
  process.stdout.write(`\r[${clock()}] load ${String(pct).padStart(3)}%  base ${Math.round(base)} kW  EV ${Math.round(ev)}/${Math.round(demand)} kW  bays ${bays}   `);
}, 1000);

// ---- telemetry: every 1 s ----
setInterval(() => {
  if (!S.last) return;
  const { base, ev, demand, tripped } = S.last;
  if (meter.connected) {
    meter.publish("gridsync/transformer-01/telemetry", JSON.stringify({
      type: "meter", base, ev: tripped ? 0 : ev, demand, simMin: S.simMin, day: S.day, tripped, trippedNow: S.tripNow,
    }), { qos: 0 });
  }
  for (const c of chargers) {
    if (!c.connected) continue; // idle chargers still send a heartbeat (OCPP StatusNotification)
    const frames = c.attack === "flood" ? 6 : 1;
    for (let k = 0; k < frames; k++) {
      const m = guard.reading(rng, { draw: Math.max(0.5, c.draw), limit: c.limit, rating: c.rating, attack: c.attack });
      c.client.publish(`gridsync/${c.id}/telemetry`, JSON.stringify({
        type: "charger", V: m.V, I: m.I, P: m.P, limit: m.limit, interval: m.interval,
        rating: c.rating, soc: c.car ? c.car.soc : 0, car: !!c.car, demand: demandOf(c), simMin: S.simMin, day: S.day,
      }), { qos: 0 });
    }
  }
}, 1000);

console.log(`GridSync simulator → ${cfg.iotEndpoint} (${cfg.region}), ${SPEED} sim-min per second. Ctrl+C to stop.`);
setTimeout(() => chargers.slice(0, 3).forEach((c) => { if (!c.car) c.car = newCar(); }), 3000);

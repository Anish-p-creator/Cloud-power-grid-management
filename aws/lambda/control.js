/* Step Functions task handler: one function, one step per state.
   ReadTransformerLoad -> ReadChargerStatus -> AIInference -> ComputeLimits -> WriteState -> PublishOCPP */
const L = require("./lib");
const { W, forecaster, agent } = L.GridAI;

const RATED = W.RATED, SAFE = W.SAFE;

async function hourAvg(day, h) {
  const it = await L.getItem(L.SITE, { pk: "hour", sk: `${day}-${h}` });
  return it && it.n ? { total: it.sumTotal / it.n, ev: it.sumEv / it.n } : null;
}

const steps = {
  async readTransformer(s) {
    const m = await L.getItem(L.CHARGERS, { deviceId: L.METER_ID });
    if (!m) throw new Error("No transformer meter reading yet");
    s.meter = { base: m.base, ev: m.ev, demand: m.demand, simMin: m.simMin, day: m.day, ageMs: Date.now() - m.updatedAt };
    s.site = await L.getSite();
    return s;
  },

  async readChargers(s) {
    s.chargers = (await L.scanChargers()).map((c) => ({
      id: c.deviceId, rating: c.rating, demand: c.status === "QUARANTINED" ? 0 : c.demand || 0, soc: c.soc || 0, status: c.status, prevLimit: c.limit || 0,
    }));
    // Load the meter sees but no charger was allowed to draw: a rogue or faulty device.
    const allowed = s.chargers.reduce((a, c) => a + c.prevLimit, 0);
    s.rogueKW = Math.max(0, Math.round(s.meter.ev - allowed - 20));
    return s;
  },

  // Forecast next-hour demand with the MLP, then ask the RL policy for the EV budget.
  async aiInference(s) {
    const { base, demand, simMin, day } = s.meter;
    if (s.site.mode !== "ai") {
      s.decision = { mode: "rules", budget: SAFE - base, why: "Fixed rule: 950 kW − base load" };
      return s;
    }
    const h = Math.floor(simMin / 60), h1 = (h + 1) % 24, d1 = h === 23 ? day + 1 : day;
    const totalNow = base + demand;
    const yday = (await hourAvg(d1 - 1, h1))?.total ?? (W.base(h1 + 0.5, d1 - 1) + (W.arrival(h1 + 0.5, d1 - 1) * 60 * 1.3 * 130) / 0.7);
    const forecast = forecaster.predict(d1, h1, totalNow, yday, demand);
    const attrib = forecaster.explain(d1, h1, totalNow, yday, demand)
      .sort((a, b) => Math.abs(b.kw) - Math.abs(a.kw)).slice(0, 4).map((a) => ({ name: a.name, kw: Math.round(a.kw) }));
    const peak = s.site.peakDay === day ? s.site.peakToday || 0 : 0;
    const obs = { h: simMin / 60, base, requested: demand, trend: forecast - totalNow, peak, headroom: RATED - base };
    let dec = agent.decide(obs), fallback = false;
    // A situation never met in training has all-zero Q-values: use the nearest learned state.
    if (dec.q.every((v) => v === 0)) {
      search: for (const trend of [obs.trend, 0, 60, -60]) for (const requested of [obs.requested, 700, 350]) for (const p of [0, 0.75, 1]) {
        const d = agent.decide({ ...obs, trend, requested, peak: p * obs.headroom });
        if (d.q.some((v) => v !== 0)) { dec = d; fallback = true; break search; }
      }
    }
    s.decision = {
      fallback,
      mode: "ai", budget: Math.max(0, dec.budget), frac: dec.frac, q: dec.q.map((v) => Math.round(v * 100) / 100),
      forecast: Math.round(forecast), trend: Math.round(obs.trend), attrib,
      why: `Forecast ${Math.round(forecast)} kW next hour (${obs.trend >= 0 ? "+" : ""}${Math.round(obs.trend)} kW); RL policy${fallback ? " (nearest learned state)" : ""} gives EVs ${Math.round(dec.frac * 100)}% of ${Math.round(obs.headroom)} kW headroom`,
    };
    return s;
  },

  // Weighted water-filling: low state-of-charge vehicles get a larger share.
  async computeLimits(s) {
    let budget = s.decision.budget;
    const adr = s.site.adr;
    if (adr && adr.until > Date.now()) { budget = Math.min(budget, adr.cap); s.decision.adrCap = adr.cap; }
    if (s.rogueKW > 0) { budget -= s.rogueKW; s.decision.rogueKW = s.rogueKW; s.decision.why += `; ${s.rogueKW} kW of unexplained load subtracted`; }
    const limits = Object.fromEntries(s.chargers.map((c) => [c.id, 0]));
    let open = s.chargers.filter((c) => c.status !== "QUARANTINED" && c.demand > 0);
    let remaining = Math.max(0, budget);
    for (let it = 0; it < 6 && open.length && remaining > 0.5; it++) {
      const wSum = open.reduce((a, c) => a + (1.1 - c.soc), 0);
      let used = 0;
      for (const c of open) {
        const give = Math.min((remaining * (1.1 - c.soc)) / wSum, c.demand - limits[c.id]);
        limits[c.id] += give; used += give;
      }
      remaining -= used;
      open = open.filter((c) => c.demand - limits[c.id] > 0.5);
    }
    s.limits = Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, Math.round(v * 10) / 10]));
    s.decision.budget = Math.round(budget);
    return s;
  },

  async writeState(s) {
    await Promise.all(Object.entries(s.limits).map(([id, limit]) => L.ddb.send(new L.UpdateCommand({
      TableName: L.CHARGERS, Key: { deviceId: id }, UpdateExpression: "SET #l = :l", ExpressionAttributeNames: { "#l": "limit" }, ExpressionAttributeValues: { ":l": limit },
    }))));
    const evPlan = Object.values(s.limits).reduce((a, b) => a + b, 0);
    const day = s.meter.day;
    const peakToday = Math.max(s.site.peakDay === day ? s.site.peakToday || 0 : 0, evPlan);
    await L.updateSite({ peakToday, peakDay: day });
    return s;
  },

  async publishOcpp(s) {
    await Promise.all(Object.entries(s.limits).map(([id, limitKW]) => L.publish(`gridsync/${id}/cmd`, {
      action: "SetChargingProfile", chargingProfilePurpose: "TxDefaultProfile", limitKW, issuedAt: Date.now(),
    })));
    return s;
  },
};

exports.handler = async ({ step, state }) => {
  const t = Date.now();
  state = await steps[step](state || {});
  (state.timeline ||= []).push({ step, ms: Date.now() - t });
  if (step === "publishOcpp") {
    state.totalMs = Date.now() - (state.t0 || t);
    await L.updateSite({
      lastExecution: {
        at: Date.now(), trigger: state.trigger, totalMs: state.totalMs, timeline: state.timeline,
        decision: state.decision, limits: state.limits, base: Math.round(state.meter.base),
      },
    });
  }
  return state;
};

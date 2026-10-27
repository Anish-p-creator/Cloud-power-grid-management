/* Dashboard API (API Gateway HTTP API -> Lambda).
   GET  /state  live chargers, site state, load timeline, event log
   POST /mode   {"mode":"ai"|"rules"}
   POST /demo   {"action":"rush"|"attack"|"restore"}  (attack/rush are sent to the charger simulator over IoT Core) */
const L = require("./lib");

async function getState() {
  const [chargers, site, load, events, meter] = await Promise.all([
    L.scanChargers(), L.getSite(), L.queryLatest("load", 150), L.queryLatest("event", 40), L.getItem(L.CHARGERS, { deviceId: L.METER_ID }),
  ]);
  return {
    serverTime: Date.now(),
    meter: meter || null,
    chargers,
    site,
    load: load.reverse().map((p) => ({ ts: p.ts, base: p.base, ev: p.ev, tripped: p.tripped })),
    events: events.map((e) => ({ ts: e.ts, msg: e.msg, cls: e.cls })),
    models: { forecastMAE: L.models.metrics.forecast.mae, idsRecall: L.models.metrics.ids.recall, idsThreshold: L.GridAI.guard.threshold, trainedAt: L.models.trainedAt },
  };
}

exports.handler = async (event) => {
  const route = event.routeKey;
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return L.json(400, { error: "Body must be JSON" }); }

  if (route === "GET /state") return L.json(200, await getState());

  if (route === "POST /mode") {
    if (!["ai", "rules"].includes(body.mode)) return L.json(400, { error: "mode must be ai or rules" });
    await L.updateSite({ mode: body.mode });
    await L.logEvent(body.mode === "ai" ? "Switched to GridSync AI (SageMaker-trained models in the loop)" : "Switched to fixed cloud rules (AI guard off)", "sm");
    return L.json(200, { mode: body.mode });
  }

  if (route === "POST /demo") {
    if (body.action === "restore") {
      const chargers = await L.scanChargers();
      let n = 0;
      for (const c of chargers.filter((c) => c.status === "QUARANTINED")) {
        n += await L.setCertificates(c.deviceId, "ACTIVE");
        await L.publish(`gridsync/${L.METER_ID}/cmd`, { action: "ReconnectBay", deviceId: c.deviceId });
        await L.ddb.send(new L.UpdateCommand({
          TableName: L.CHARGERS, Key: { deviceId: c.deviceId },
          UpdateExpression: "SET #s = :a, flags = :f", ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":a": "ACTIVE", ":f": [] },
        }));
      }
      await L.publish("gridsync/sim/demo", { action: "restore" });
      await L.logEvent(`Re-provisioned: ${n} certificate(s) set ACTIVE after inspection`, "ok");
      return L.json(200, { restored: n });
    }
    if (!["rush", "attack"].includes(body.action)) return L.json(400, { error: "action must be rush, attack or restore" });
    await L.publish("gridsync/sim/demo", { action: body.action, chargerId: body.chargerId });
    await L.logEvent(body.action === "rush" ? "Demo: evening rush requested (all bays plug in)" : "Demo: cyber attack injected into a charger", "adr");
    return L.json(200, { sent: body.action });
  }
  return L.json(404, { error: `No route ${route}` });
};

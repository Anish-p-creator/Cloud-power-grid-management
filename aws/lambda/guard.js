/* Telemetry consumer: the AI telemetry guard.
   IoT Core rule -> SQS (stands in for Kinesis, which the account's org policy denies) -> this Lambda.
   - stores the transformer meter reading and the site load timeline
   - scores every charger message with the Isolation Forest
   - in AI mode, revokes the certificate of a charger with 2 of its last 3 messages flagged
   - starts the Step Functions control workflow at most every few seconds */
const { StartExecutionCommand } = require("@aws-sdk/client-sfn");
const L = require("./lib");

const CONTROL_EVERY_MS = 2000;

exports.handler = async (event) => {
  const msgs = event.Records.map((r) => JSON.parse(r.body)).sort((a, b) => (a.day - b.day) || (a.simMin - b.simMin));
  const site = await L.getSite();

  // ---- transformer meter ----
  const meters = msgs.filter((m) => m.type === "meter");
  if (meters.length) {
    const m = meters[meters.length - 1];
    const now = Date.now();
    await L.ddb.send(new L.PutCommand({ TableName: L.CHARGERS, Item: { ...m, deviceId: L.METER_ID, updatedAt: now } }));
    await L.ddb.send(new L.PutCommand({
      TableName: L.SITE,
      Item: { pk: "load", sk: String(now), ts: now, base: m.base, ev: m.ev, demand: m.demand, simMin: m.simMin, tripped: !!m.tripped, ttl: Math.floor(now / 1000) + L.DAY_S },
    }));
    // hourly aggregate of uncontrolled demand: training/feature data for the forecaster
    const h = Math.floor(m.simMin / 60);
    await L.ddb.send(new L.UpdateCommand({
      TableName: L.SITE, Key: { pk: "hour", sk: `${m.day}-${h}` },
      UpdateExpression: "ADD sumTotal :t, sumEv :e, n :one",
      ExpressionAttributeValues: { ":t": m.base + m.demand, ":e": m.demand, ":one": 1 },
    }));
    if (m.trippedNow) await L.logEvent(`FEEDER TRIP: transformer at ${Math.round((m.base + m.ev) / 10)}%, relay opened`, "err");
  }

  // ---- charger telemetry: AI anomaly scoring ----
  const byDevice = {};
  msgs.filter((m) => m.type === "charger").forEach((m) => { (byDevice[m.deviceId] ||= []).push(m); });
  let quarantined = false;
  for (const [id, list] of Object.entries(byDevice)) {
    const prev = (await L.getItem(L.CHARGERS, { deviceId: id })) || {};
    let flags = prev.flags || [];
    let status = prev.status === "QUARANTINED" ? "QUARANTINED" : "ACTIVE";
    let score = 0;
    for (const m of list) {
      if (!m.car) continue; // idle heartbeat: nothing to score
      score = L.GridAI.guard.score(m);
      flags = [...flags, score > L.GridAI.guard.threshold].slice(-3);
      if (status !== "QUARANTINED" && site.mode === "ai" && flags.filter(Boolean).length >= 2) {
        status = "QUARANTINED";
        const n = await L.setCertificates(id, "INACTIVE");
        // the trusted site controller opens the bay contactor: a compromised charger cannot be trusted to stop itself
        await L.publish(`gridsync/${L.METER_ID}/cmd`, { action: "IsolateBay", deviceId: id });
        await L.updateSite({ threats: (site.threats || 0) + 1 });
        await L.logEvent(`🛡 Isolation Forest flagged ${id} (score ${score.toFixed(2)} > ${L.GridAI.guard.threshold.toFixed(2)}) → ${n} IoT certificate(s) set INACTIVE, bay contactor opened`, "err");
        quarantined = true;
      }
    }
    const last = list[list.length - 1];
    await L.ddb.send(new L.PutCommand({
      TableName: L.CHARGERS,
      Item: {
        deviceId: id, type: "charger", rating: last.rating, soc: last.soc, car: last.car, demand: last.demand,
        reportedP: last.P, V: last.V, I: last.I, interval: last.interval, limit: prev.limit ?? 0,
        score: last.car ? score : 0, flags, status, msgs: (prev.msgs || 0) + list.length, updatedAt: Date.now(),
      },
    }));
  }

  // ---- trigger the control loop ----
  if (quarantined || Date.now() - (site.lastControlAt || 0) > CONTROL_EVERY_MS) {
    await L.updateSite({ lastControlAt: Date.now() });
    await L.sfn.send(new StartExecutionCommand({
      stateMachineArn: process.env.STATE_MACHINE_ARN,
      input: JSON.stringify({ trigger: quarantined ? "quarantine" : "telemetry", t0: Date.now() }),
    }));
  }
  return { processed: msgs.length };
};

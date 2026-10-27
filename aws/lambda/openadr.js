/* POST /openadr - utility demand-response endpoint (API Gateway -> Lambda).
   Translates an OpenADR-style event into a site load cap, then runs the
   Step Functions workflow synchronously so the response reports the real
   end-to-end reaction time until OCPP commands were published.
   Example body: {"eventID":"evt-1","signal":{"type":"LOAD_DISPATCH","value":-30},"demoSeconds":120} */
const { StartSyncExecutionCommand } = require("@aws-sdk/client-sfn");
const L = require("./lib");

exports.handler = async (event) => {
  const t0 = Date.now();
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return L.json(400, { error: "Body must be JSON" }); }
  const pct = Math.min(90, Math.abs(Number(body.signal?.value ?? -30)));
  const holdS = Math.min(900, Number(body.demoSeconds ?? 120));
  const eventID = body.eventID || `evt-${t0}`;

  const meter = await L.getItem(L.CHARGERS, { deviceId: L.METER_ID });
  if (!meter) return L.json(409, { error: "No live telemetry: start the charger simulator first" });
  const cap = Math.max(60, Math.round(meter.ev * (1 - pct / 100)));
  await L.updateSite({ adr: { eventID, pct, cap, until: t0 + holdS * 1000 } });
  await L.logEvent(`OpenADR ${eventID}: reduce site load ${pct}% (EV cap ${cap} kW for ${holdS}s)`, "adr");

  const res = await L.sfn.send(new StartSyncExecutionCommand({
    stateMachineArn: process.env.STATE_MACHINE_ARN,
    input: JSON.stringify({ trigger: "openadr", t0 }),
  }));
  if (res.status !== "SUCCEEDED") return L.json(502, { error: "Workflow failed", cause: res.cause });
  const out = JSON.parse(res.output);
  const reactionMs = Date.now() - t0;
  await L.logEvent(`IoT Core → SetChargingProfile sent to ${Object.keys(out.limits).length} chargers, ${(reactionMs / 1000).toFixed(2)} s after the OpenADR event`, "ok");
  return L.json(200, {
    oadrResponse: { eventID, optType: "optIn", responseCode: 200 },
    reactionMs, capKW: cap, timeline: out.timeline, limits: out.limits, decision: out.decision,
  });
};

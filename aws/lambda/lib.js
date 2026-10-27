/* Shared code for the GridSync Lambda functions: AWS clients, the trained
   models (loaded from models.json) and small DynamoDB helpers. */
require("./ml.js");
require("./ai.js");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const { IoTDataPlaneClient, PublishCommand } = require("@aws-sdk/client-iot-data-plane");
const { IoTClient, ListThingPrincipalsCommand, UpdateCertificateCommand, AttachPolicyCommand, DetachPolicyCommand } = require("@aws-sdk/client-iot");
const { SFNClient } = require("@aws-sdk/client-sfn");

const { ML, GridAI } = globalThis;
const models = require("./models.json");

// ---------- restore trained models ----------
const mlp = Object.create(ML.MLP.prototype);
Object.assign(mlp, {
  sizes: models.mlp.sizes,
  W: models.mlp.W.map((w) => Float64Array.from(w)),
  b: models.mlp.b.map((b) => Float64Array.from(b)),
});
GridAI.forecaster.model = mlp;
GridAI.forecaster.baseline = models.mlp.baseline;
GridAI.forecaster.metrics = models.metrics.forecast;

GridAI.agent.q = new ML.QAgent(models.q.nS, models.q.nA);
GridAI.agent.q.Q = Float64Array.from(models.q.Q);

const tree = (n) => (n.s !== undefined ? { size: n.s } : { f: n.f, split: n.t, left: tree(n.l), right: tree(n.r) });
const forest = Object.create(ML.IsolationForest.prototype);
Object.assign(forest, { c: models.forest.c, trees: models.forest.trees.map(tree) });
GridAI.guard.forest = forest;
GridAI.guard.threshold = models.forest.threshold;

// ---------- AWS clients ----------
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const iotData = new IoTDataPlaneClient({ endpoint: `https://${process.env.IOT_ENDPOINT}` });
const iot = new IoTClient({});
const sfn = new SFNClient({});

const CHARGERS = process.env.CHARGER_TABLE;
const SITE = process.env.SITE_TABLE;
const METER_ID = "transformer-01";
const DAY_S = 86400;

const getItem = async (table, Key) => (await ddb.send(new GetCommand({ TableName: table, Key }))).Item;

async function getSite() {
  const s = await getItem(SITE, { pk: "site", sk: "state" });
  return { mode: "ai", peakToday: 0, peakDay: -1, threats: 0, ...(s || {}) };
}
async function updateSite(fields) {
  const names = {}, values = {}, sets = [];
  Object.entries(fields).forEach(([k, v], i) => { names[`#k${i}`] = k; values[`:v${i}`] = v; sets.push(`#k${i} = :v${i}`); });
  await ddb.send(new UpdateCommand({
    TableName: SITE, Key: { pk: "site", sk: "state" },
    UpdateExpression: "SET " + sets.join(", "), ExpressionAttributeNames: names, ExpressionAttributeValues: values,
  }));
}
async function logEvent(msg, cls = "") {
  const ts = Date.now();
  await ddb.send(new PutCommand({
    TableName: SITE,
    Item: { pk: "event", sk: `${ts}#${Math.random().toString(36).slice(2, 7)}`, ts, msg, cls, ttl: Math.floor(ts / 1000) + DAY_S },
  }));
}
async function scanChargers() {
  const res = await ddb.send(new ScanCommand({ TableName: CHARGERS }));
  return (res.Items || []).filter((i) => i.deviceId !== METER_ID).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
}
async function queryLatest(pk, limit) {
  const res = await ddb.send(new QueryCommand({
    TableName: SITE, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": pk }, ScanIndexForward: false, Limit: limit,
  }));
  return res.Items || [];
}
async function publish(topic, payload) {
  await iotData.send(new PublishCommand({ topic, qos: 1, payload: Buffer.from(JSON.stringify(payload)) }));
}
// Zero-trust enforcement: flips the device's X.509 certificate(s) in IoT Core.
// Deactivating a certificate only drops live sessions "within a few minutes", so the
// device policy is detached too: the next publish is refused and IoT Core disconnects it.
const DEVICE_POLICY = "gridsync-device-policy";
async function setCertificates(thingName, status) {
  const { principals = [] } = await iot.send(new ListThingPrincipalsCommand({ thingName }));
  for (const arn of principals) {
    if (status === "INACTIVE") await iot.send(new DetachPolicyCommand({ policyName: DEVICE_POLICY, target: arn }));
    await iot.send(new UpdateCertificateCommand({ certificateId: arn.split("/").pop(), newStatus: status }));
    if (status === "ACTIVE") await iot.send(new AttachPolicyCommand({ policyName: DEVICE_POLICY, target: arn }));
  }
  return principals.length;
}
const json = (statusCode, body) => ({
  statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

module.exports = {
  GridAI, models, ddb, sfn, CHARGERS, SITE, METER_ID, DAY_S,
  getItem, getSite, updateSite, logEvent, scanChargers, queryLatest, publish, setCertificates, json,
  GetCommand, PutCommand, UpdateCommand,
};

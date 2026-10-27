# GridSync: Team Pitch (Anish & Neeraj)

**About 5 minutes in total.** Anish leads the problem, the solution and the AI. Neeraj drives the AWS demo.

---

## 1. Anish: the problem (45 s)

> "Ma'am, at 6 PM many electric cars plug into the same fast-charging station. Each one pulls up to 350 kilowatts.
> The local transformer was never built for that, so it overloads, the breaker trips, and the whole area loses power.
>
> The grid usually has enough power. The real problem is that **chargers and the power company can't talk to each other fast enough**.
> They use different languages (OCPP and OpenADR), and today's systems take 15 to 30 seconds to react, which is far too slow."

## 2. Anish: our solution (45 s)

> "We built **GridSync**, a cloud system on **AWS** that sits between the power company and the chargers.
> Every 2 seconds it reads the transformer load, decides how much power each car can safely take, and sends
> the new limits to the chargers, in **under one second**.
>
> Three AI models make the decisions:
> - a **neural network** that predicts next-hour demand,
> - a **reinforcement-learning agent** that learns how much safety margin to keep,
> - an **anomaly detector** that spots hacked chargers."

## 3. Neeraj: live AWS demo (3 min)

> "Everything you'll see now is running live on our AWS account."

*(Follow the 5 screens in the table below.)*

## 4. Anish: what's new, and close (30 s)

> "What makes this new: other systems either predict *or* control *or* secure. We do all three in one loop.
> When our AI finds a hacked charger, it doesn't just raise an alert. It **revokes the charger's identity in AWS and cuts its power**, so the grid stays safe.
> And because it's fully serverless, it costs almost nothing when idle and scales to thousands of chargers.
> Thank you. We're happy to take questions."

---

## What to show in AWS (Neeraj)

Region: **Asia Pacific (Sydney)**, selected at the top right of the console.
Start the chargers 10 minutes before:
```bash
cd $HOME\OneDrive\Documents\GridSync\Cloud-power-grid-management\sim
node charger-sim.js
```

| # | Open this | Point at | Say |
|---|---|---|---|
| 1 | **CloudFormation** → `gridsync` → *Resources* | The list of ~30 resources | "Our whole architecture is code. One command builds it, one deletes it." |
| 2 | **IoT Core** → *Things* | `charger-01` … `charger-08`, `transformer-01` | "Nine real devices. Each has its own security certificate, so no password can leak." |
| 3 | **Dashboard** https://dye305b97k5t7.cloudfront.net → *☁ Live on AWS* | Green "Live" pill, load below 100%, Step Functions time ≈ 0.2 s, the 💡 AI explanation | "This data comes straight from AWS. The AI explains every decision." |
| 4 | Dashboard: click **⚠ POST /openadr −30%** | The result line "Cloud reaction ≈ 0.5 s" | "The power company asked for a 30% cut, and all chargers obeyed in half a second. Our target was 2 seconds." |
| 5 | Dashboard: click **☠ Cyber attack**, then **IoT Core** → *Security* → *Certificates* | The bay turns **QUARANTINED**, and one certificate shows **Inactive** | "A charger was hacked. Our AI caught it in about a second, switched off its certificate, and cut its power. The grid never tripped." |

Then click **↺ Restore certificates**.

**If there's extra time:**
- **Step Functions** → `gridsync-control` → *Graph*: "These are the 6 decision steps."
- **IoT Core** → *MQTT test client* → subscribe to `gridsync/+/cmd`: live commands going to the chargers.
- **CloudWatch** → Dashboards → *GridSync*: monitoring.

---

## Likely questions, with short answers

- **Why Sydney and not Mumbai?** Our AWS account's organization policy only allows Sydney.
- **Why SQS and not Kinesis like the report?** Kinesis is blocked on our account. SQS does the same job of buffering the data stream.
- **Is the data real?** The chargers are simulated on our laptop, but they are real AWS IoT devices with real certificates, and everything else runs on real AWS services.
- **Where is the AI running?** The models were trained offline. Their weights are stored in S3 and run inside AWS Lambda during each decision.
- **What does it cost?** About $2–3 a day while the chargers run, and almost $0 when they're stopped. A $10 budget alarm protects us.

## After the demo
Press **Ctrl+C** in the charger window. After grading, run `.\aws\scripts\teardown.ps1` and delete the old access key in IAM.

# GridSync: Live AWS Demo Guide

Region: **Asia Pacific (Sydney) ap-southeast-2** · Dashboard: **https://dye305b97k5t7.cloudfront.net** → **☁ Live on AWS**

---

## A. 15 minutes before class

1. **Check AWS access.** Open PowerShell and run:
   ```bash
   aws sts get-caller-identity
   ```
   It should show `user/gridsync-admin`.

2. **Start the 8 chargers and the transformer.** Run this from the project folder that has `sim\certs`:
   ```bash
   cd sim
   node charger-sim.js
   ```
   Wait until you see 9 × `connected to AWS IoT Core (mTLS ok)`. Leave this window open the whole demo.
   > On a fresh clone, first run `.\aws\scripts\deploy.ps1 -BudgetEmail <your email>` and `npm install` in `sim`. The deploy re-creates the certificates.

3. **Open the dashboard** at https://dye305b97k5t7.cloudfront.net and click **☁ Live on AWS**. The status pill should turn green and say **Live · chargers streaming to AWS IoT Core**. Check that the mode is **🧠 GridSync AI**.

4. **Open these AWS console tabs** in Sydney (choose the region at the top right):

   | Tab | Where |
   |---|---|
   | 1. CloudFormation | Stacks → `gridsync` → **Resources** |
   | 2. IoT Core: Things | IoT Core → Manage → All devices → **Things** |
   | 3. IoT Core: MQTT test client | IoT Core → **MQTT test client** → Subscribe to `gridsync/+/cmd` |
   | 4. Step Functions | State machines → `gridsync-control` → **Definition / Graph** |
   | 5. DynamoDB | Tables → `gridsync-charger-state` → **Explore table items** |
   | 6. IoT Core: Certificates | IoT Core → Security → **Certificates** |
   | 7. CloudWatch | Dashboards → **GridSync** |

---

## B. The demo (about 8 minutes)

### 1. Architecture is code (1 min) · CloudFormation tab
> "The whole architecture from our report is one CloudFormation stack: IoT Core policy and rule, SQS,
> four Lambda functions, an Express Step Functions workflow, API Gateway, two DynamoDB tables, S3,
> CloudFront, a CloudWatch dashboard and a budget alarm. One command deploys it, one command deletes it."

Scroll through the **Resources** list.

### 2. Real devices, zero-trust (1 min) · IoT Things + PowerShell window
> "These are 9 real IoT things. Each charger has its own X.509 certificate and connects over mutual TLS.
> The policy lets a charger publish only to its own topic."

Show the 9 things, then the PowerShell window with `connected … (mTLS ok)` and the live status line.

### 3. The AI control loop (2 min) · dashboard + MQTT test client
> "Every second the chargers send meter data. An IoT rule pushes it through SQS to a Lambda that runs our
> Isolation Forest. Every 2 seconds Step Functions runs: read the load, read the chargers, run the neural-network
> forecast and the reinforcement-learning policy, compute fair limits, and publish OCPP commands back through IoT Core."

- On the dashboard, point at **Step Functions run ≈ 0.2 s**, the 6 steps with milliseconds, and the 💡 explanation with Q-values.
- In the **MQTT test client**, show the `SetChargingProfile` messages arriving live.
- In **DynamoDB**, click *Run* to show the live `limit` and `score` values.
- Click **🚗 Evening rush**. All bays fill up, and the load stays **below 100%**.

### 4. OpenADR from the utility in under 2 s (1 min) · dashboard
Click **⚠ POST /openadr −30%**.
> "This is the utility calling our API Gateway. Lambda translates OpenADR into a cap and runs the workflow
> synchronously. The reply comes back after the OCPP commands have already been published."

Read out the result line, e.g. **Cloud reaction 0.51 s** (target < 2 s ✓). Also show the cap line in the event log.

*Optional:* run the same request from PowerShell to show it's a real public API:
```powershell
Invoke-RestMethod -Method Post -Uri https://ue7gxy5ssf.execute-api.ap-southeast-2.amazonaws.com/openadr -ContentType application/json -Body '{"signal":{"value":-30},"demoSeconds":60}'
```

### 5. Cyber attack → AI quarantine (2 min) · dashboard + Certificates tab
Click **☠ Cyber attack**.
> "A charger is hacked: it ignores its limit and fakes its meter data. Watch its anomaly score."

- In about 1–3 s the bay turns **QUARANTINED** and the log shows *Isolation Forest flagged … certificate set INACTIVE, bay contactor opened*.
- In the PowerShell window you'll see `⛔ site controller opened the contactor`.
- In the **Certificates** tab, refresh: one certificate is now **Inactive**.

> "The AI didn't just raise an alert. It revoked the device's identity in IoT Core and cut its power, and the grid never tripped."

Click **↺ Restore certificates** to bring it back.

### 6. Why AI matters (1 min) · dashboard
Switch to **Cloud rules** and click **☠ Cyber attack** again.
> "Without the AI guard, the same attack is never caught. The rogue charger keeps pulling power and the feeder can trip."

Then switch back to **🧠 GridSync AI** and click **Restore certificates**.

### 7. Operations and cost (30 s) · CloudWatch tab
> "CloudWatch shows message volume, Step Functions executions and Lambda latency. Everything is serverless and
> pay-per-use, with a $10 budget alarm. When the chargers stop, the cost drops to almost zero."

---

## C. Honest design notes (if asked)
- **Sydney, not Mumbai:** the account's AWS Organization policy (SCP) only allows ap-southeast-2.
- **SQS instead of Kinesis:** the SCP denies Kinesis. IoT Rule → SQS → Lambda gives the same batched stream.
- **DynamoDB instead of Timestream:** Timestream is denied here and no longer accepts new customers.
- **Models served in Lambda:** the models are trained offline (a SageMaker-style job, `aws/scripts/export-models.js`) and the weights are stored in S3. An always-on SageMaker endpoint would bill 24/7.
- **Step Functions history:** Express workflows don't keep a console execution history. That's why the dashboard shows each run's step timings, which Lambda records in DynamoDB.

## D. After the demo
1. Press **Ctrl+C** in the simulator window to stop costs.
2. After grading, delete everything:
   ```bash
   .\aws\scripts\teardown.ps1
   ```
3. In IAM, **delete the access key ending …X6NZR**, which was shared in screenshots.

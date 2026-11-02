"""Builds docs/GridSync-Project-Report.pdf, the complete project report.
Reads real numbers from docs/media/metrics.json, results.json, stack.json, lambdas.json and the
screenshots captured by docs/record_demo.py.  Usage: python docs/make_report_pdf.py"""
import json
from pathlib import Path

from reportlab.graphics.shapes import Drawing, Line, Polygon, Rect, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (Image, KeepTogether, ListFlowable, ListItem, PageBreak, Paragraph, SimpleDocTemplate,
                                Spacer, Table, TableStyle)

DOCS = Path(__file__).parent
MEDIA = DOCS / "media"
OUT = DOCS / "GridSync-Project-Report.pdf"
M = json.loads((MEDIA / "metrics.json").read_text())
LIVE = json.loads((MEDIA / "results.json").read_text())
STACK = json.loads((MEDIA / "stack.json").read_text())
LAMBDAS = json.loads((MEDIA / "lambdas.json").read_text())

PURPLE = colors.HexColor("#5b34d6")
CYAN = colors.HexColor("#0f8f86")
INK = colors.HexColor("#1d1b33")
MUTED = colors.HexColor("#5d5b78")
SOFT = colors.HexColor("#f2effd")
LINE = colors.HexColor("#d9d4f5")
CONTENT_W = 170 * mm

ss = getSampleStyleSheet()
TITLE = ParagraphStyle("T", parent=ss["Title"], fontName="Helvetica-Bold", fontSize=26, leading=31, textColor=INK)
SUBT = ParagraphStyle("ST", parent=ss["Normal"], fontSize=13, leading=18, textColor=MUTED, alignment=TA_CENTER)
H1 = ParagraphStyle("H1", parent=ss["Heading1"], fontName="Helvetica-Bold", fontSize=17, leading=22, textColor=PURPLE, spaceBefore=4, spaceAfter=8)
H2 = ParagraphStyle("H2", parent=ss["Heading2"], fontName="Helvetica-Bold", fontSize=12.5, leading=16, textColor=INK, spaceBefore=8, spaceAfter=4)
P = ParagraphStyle("P", parent=ss["Normal"], fontSize=10.3, leading=15, textColor=INK, alignment=TA_JUSTIFY, spaceAfter=6)
CELL = ParagraphStyle("C", parent=ss["Normal"], fontSize=8.8, leading=11.5, textColor=INK)
CELLB = ParagraphStyle("CB", parent=CELL, fontName="Helvetica-Bold", textColor=colors.white)
CAP = ParagraphStyle("Cap", parent=ss["Normal"], fontSize=8.8, leading=11, textColor=MUTED, alignment=TA_CENTER, spaceBefore=3, spaceAfter=10)
MONO = ParagraphStyle("Mono", parent=ss["Normal"], fontName="Courier", fontSize=8.3, leading=10.5, textColor=INK)

fig_no = [0]
tab_no = [0]


def para(t):
    return Paragraph(t, P)


def bullets(items):
    return ListFlowable([ListItem(Paragraph(i, P), leftIndent=12, value="circle") for i in items], bulletType="bullet",
                        start="•", leftIndent=14, bulletFontSize=9)


def table(rows, widths, caption=None, header=PURPLE):
    data = [[Paragraph(str(c), CELLB) for c in rows[0]]] + [[Paragraph(str(c), CELL) for c in r] for r in rows[1:]]
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), header), ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, SOFT]),
        ("GRID", (0, 0), (-1, -1), 0.4, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    out = [t]
    if caption:
        tab_no[0] += 1
        out.append(Paragraph(f"Table {tab_no[0]}: {caption}", CAP))
    return out


def figure(flowable_or_path, caption, width=CONTENT_W):
    if isinstance(flowable_or_path, (str, Path)):
        from PIL import Image as PILImage
        with PILImage.open(flowable_or_path) as im:
            iw, ih = im.size
        flowable_or_path = Image(str(flowable_or_path), width=width, height=width * ih / iw)
    fig_no[0] += 1
    return KeepTogether([flowable_or_path, Paragraph(f"Figure {fig_no[0]}: {caption}", CAP)])


# ------------------------------------------------------------------ architecture diagram
def architecture_diagram():
    w, h = CONTENT_W, 118 * mm
    d = Drawing(w, h)
    def box(x, y, bw, bh, text, fill="#ece7ff", stroke="#5b34d6", sub=None):
        d.add(Rect(x, y, bw, bh, rx=5, ry=5, fillColor=colors.HexColor(fill), strokeColor=colors.HexColor(stroke), strokeWidth=1))
        d.add(String(x + bw / 2, y + bh / 2 + (2 if sub else -3), text, fontName="Helvetica-Bold", fontSize=7.6, textAnchor="middle", fillColor=INK))
        if sub:
            d.add(String(x + bw / 2, y + bh / 2 - 8, sub, fontName="Helvetica", fontSize=6.3, textAnchor="middle", fillColor=MUTED))
    def arrow(x1, y1, x2, y2, color="#5b34d6", label=None, label_dx=0, label_dy=3):
        c = colors.HexColor(color)
        d.add(Line(x1, y1, x2, y2, strokeColor=c, strokeWidth=1.1))
        import math
        a = math.atan2(y2 - y1, x2 - x1)
        d.add(Polygon([x2, y2, x2 - 6 * math.cos(a - 0.4), y2 - 6 * math.sin(a - 0.4), x2 - 6 * math.cos(a + 0.4), y2 - 6 * math.sin(a + 0.4)],
                      fillColor=c, strokeColor=c))
        if label:
            d.add(String((x1 + x2) / 2 + label_dx, (y1 + y2) / 2 + label_dy, label, fontName="Helvetica", fontSize=6, textAnchor="middle", fillColor=MUTED))
    pt = mm
    # row y positions
    y1, y2, y3, y4 = 98 * pt, 70 * pt, 40 * pt, 8 * pt
    bw, bh = 34 * pt, 14 * pt
    # edge
    box(2 * pt, y1, 38 * pt, bh, "8 chargers + meter", "#e3f6f4", "#0f8f86", "MQTT, X.509, mutual TLS")
    box(50 * pt, y1, bw, bh, "AWS IoT Core", sub="things, policy, rule")
    box(94 * pt, y1, 22 * pt, bh, "SQS", sub="buffer")
    box(126 * pt, y1, 42 * pt, bh, "Lambda: AI guard", sub="Isolation Forest")
    arrow(40 * pt, y1 + bh / 2, 50 * pt, y1 + bh / 2, "#0f8f86")
    arrow(84 * pt, y1 + bh / 2, 94 * pt, y1 + bh / 2, label="IoT Rule", label_dy=9)
    arrow(116 * pt, y1 + bh / 2, 126 * pt, y1 + bh / 2)
    # storage + workflow
    box(126 * pt, y2, 42 * pt, bh, "Amazon DynamoDB", sub="state, time series, events")
    arrow(147 * pt, y1, 147 * pt, y2 + bh)
    box(2 * pt, y2 - 4 * pt, 108 * pt, 22 * pt, "AWS Step Functions (EXPRESS): gridsync-control", "#f6f3ff",
        sub="ReadLoad > ReadChargers > AI inference (MLP + RL) > ComputeLimits > WriteState > PublishOCPP")
    arrow(126 * pt, y1 + 3 * pt, 95 * pt, y2 + 18 * pt, label="start every 2 s", label_dx=24, label_dy=-6)
    arrow(110 * pt, y2 + 7 * pt, 126 * pt, y2 + 7 * pt)
    arrow(30 * pt, y2 + 18 * pt, 60 * pt, y1, "#0f8f86", "OCPP SetChargingProfile", label_dx=-34, label_dy=2)
    # utility path
    box(2 * pt, y3, 30 * pt, bh, "Utility (OpenADR)", "#fff4e0", "#b86e00")
    box(42 * pt, y3, 36 * pt, bh, "API Gateway", sub="HTTP API /openadr")
    box(88 * pt, y3, 34 * pt, bh, "Lambda: OpenADR", sub="translate + sync run")
    arrow(32 * pt, y3 + bh / 2, 42 * pt, y3 + bh / 2, "#b86e00")
    arrow(78 * pt, y3 + bh / 2, 88 * pt, y3 + bh / 2)
    arrow(105 * pt, y3 + bh, 80 * pt, y2 - 4 * pt)
    box(132 * pt, y3, 36 * pt, bh, "Lambda: API", sub="/state /mode /demo")
    arrow(150 * pt, y3 + bh, 150 * pt, y2, label="")
    # web + ops
    box(2 * pt, y4, 30 * pt, bh, "Browser", "#e3f6f4", "#0f8f86")
    box(42 * pt, y4, 30 * pt, bh, "CloudFront", sub="HTTPS, OAC")
    box(82 * pt, y4, 22 * pt, bh, "S3", sub="website")
    arrow(32 * pt, y4 + bh / 2, 42 * pt, y4 + bh / 2, "#0f8f86")
    arrow(72 * pt, y4 + bh / 2, 82 * pt, y4 + bh / 2)
    arrow(17 * pt, y4 + bh, 132 * pt, y3 + 2 * pt, "#0f8f86", "fetch /state every 2 s")
    return d


def ops_strip():
    w = CONTENT_W
    d = Drawing(w, 18 * mm)
    names = [("CloudFormation", "entire stack as code"), ("IAM", "least-privilege roles"), ("CloudWatch", "dashboard + logs"), ("AWS Budgets", "$10/month alert")]
    bw = (w - 3 * 6 * mm) / 4
    for i, (t, s) in enumerate(names):
        x = i * (bw + 6 * mm)
        d.add(Rect(x, 2 * mm, bw, 13 * mm, rx=5, ry=5, fillColor=colors.HexColor("#f4f4f8"), strokeColor=colors.HexColor("#8b89ad")))
        d.add(String(x + bw / 2, 10 * mm, t, fontName="Helvetica-Bold", fontSize=8, textAnchor="middle", fillColor=INK))
        d.add(String(x + bw / 2, 5.5 * mm, s, fontName="Helvetica", fontSize=6.8, textAnchor="middle", fillColor=MUTED))
    return d


def page_frame(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(PURPLE)
    canvas.rect(0, A4[1] - 5 * mm, A4[0], 5 * mm, stroke=0, fill=1)
    if doc.page > 1:
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(20 * mm, 10 * mm, "GridSync: AI-Driven AWS Cloud for Smart EV Fast-Charging and Power Grid Management · Team 4")
        canvas.drawRightString(A4[0] - 20 * mm, 10 * mm, f"{doc.page}")
    canvas.restoreState()


# ------------------------------------------------------------------ content
f, rl, ids = M["f"], M["rl"], M["ids"]
pct = lambda x: f"{x * 100:.0f}%"
story = []

# Cover
story += [Spacer(1, 40 * mm), Paragraph("GridSync", TITLE),
          Paragraph("AI-Driven AWS Cloud Infrastructure for Smart EV Fast-Charging and Power Grid Management", SUBT),
          Spacer(1, 10 * mm), Paragraph("A Case Study and Implementation Report", SUBT), Spacer(1, 4 * mm),
          Paragraph("Cloud Architecture Design · Final Project", SUBT), Spacer(1, 22 * mm)]
story += table([["Team 4", ""], ["Anish P", "24BCE2394"], ["Neeraj K", "24BCE2393"]], [60 * mm, 50 * mm])
story += [Spacer(1, 22 * mm),
          Paragraph("Deployed on Amazon Web Services, region ap-southeast-2 (Sydney)<br/>"
                    "Live dashboard: https://dye305b97k5t7.cloudfront.net<br/>"
                    "Source code: github.com/Anish-p-creator/Cloud-power-grid-management", SUBT),
          PageBreak()]

# Contents
contents = ["Abstract", "1. Introduction: a real-time problem", "2. Problem statement: four pillars", "3. Objectives",
            "4. Literature survey (2020 to 2026)", "5. Analysis of existing research and research gap", "6. Challenges",
            "7. AWS services used", "8. Proposed and deployed architecture", "9. AI and machine-learning models",
            "10. Implementation on AWS", "11. Security design", "12. Cost analysis", "13. Results and evaluation",
            "14. Novelty", "15. Limitations and future work", "16. Conclusion", "References", "Appendix A: repository layout and how to run"]
story += [Paragraph("Contents", H1)] + [Paragraph(c, P) for c in contents] + [PageBreak()]

# Abstract
story += [Paragraph("Abstract", H1), para(
    "Evening fast-charging peaks, with many 150 to 350 kW chargers ramping up on the same distribution transformer, overload local grid "
    "equipment and cause breaker trips. The underlying issue is coordination rather than energy supply: utilities signal demand response "
    "with OpenADR, chargers are controlled with OCPP, and existing back-ends take 15 to 30 seconds to react. This project designs and "
    "deploys <b>GridSync</b>, a fully serverless AWS platform that bridges the two protocols and recomputes every charger's power limit "
    "every two seconds. Decisions are made by three machine-learning models implemented from scratch: a neural-network demand forecaster, "
    "a Q-learning reinforcement-learning charging agent, and an Isolation Forest intrusion detector that revokes a compromised charger's "
    "identity in AWS IoT Core. The system runs on a real AWS account as a single CloudFormation stack of "
    f"{len(STACK)} resources (IoT Core, SQS, Lambda, Step Functions, API Gateway, DynamoDB, S3, CloudFront, IAM, CloudWatch and Budgets). "
    f"Measured live, a control decision takes about <b>{LIVE['step']}</b>, a utility OpenADR request reaches all chargers in "
    f"<b>{LIVE['adr']}</b> (target under 2 s), and a hacked charger is detected and isolated within about one second, with zero "
    "feeder trips in AI mode."), PageBreak()]

# 1 Introduction
story += [Paragraph("1. Introduction: a real-time problem", H1),
          para("At a highway rest stop or city fast-charging hub around 6 or 7 PM, five to ten EVs are often plugged in at once, each drawing "
               "150 to 350 kW from the same local feeder. Each charger is rated for that power, but the transformer and substation feeding the "
               "site were never designed to carry the combined load at the same peak hour every day."),
          para("When several ultra-fast chargers ramp up together, the current drawn from the local distribution transformer spikes. If the "
               "transformer is already carrying neighbourhood load (air conditioners, shops closing, streetlights switching on), the extra EV "
               "load pushes it past its rating. Voltage sags, and protection relays and breakers trip, taking the whole feeder offline until "
               "someone resets it."),
          para("The core of the problem is <b>timing and coordination</b>, not raw power availability. Dozens of chargers switch on and off "
               "independently with no shared, real-time view of how much headroom the transformer has left. This project builds a cloud "
               "system that gives the grid and the chargers a fast, shared and secure way to coordinate <i>before</i> a trip happens.")]

# 2 Problem statement
story += [Paragraph("2. Problem statement: four pillars", H1)]
story += table([["Pillar", "What goes wrong"],
                ["1. Protocol disconnect", "Utilities use OpenADR (price and load-shedding signals); chargers use OCPP (sessions, meter values). No native real-time bridge exists, so every deployment relies on one-off glue code."],
                ["2. Latency at scale", "Traditional web back-ends queue up when many chargers report at once; deciding and pushing an action can take 15 to 30 s, while protection equipment reacts in a fraction of that."],
                ["3. Inefficient static allocation", "Each charger has a fixed power ceiling set at installation, ignoring time of day, grid state and each car's state of charge."],
                ["4. Vulnerable edge security", "Chargers sit in public places on cellular links, often with weak authentication. A compromised charger is an entry point to systems that talk to the grid."]],
               [45 * mm, 125 * mm], "The four pillars of the fast-charging overload problem")
story += [para("Together these show that installing more chargers or writing more integration code will not fix overloads. What is needed is "
               "a purpose-built cloud platform that speaks both protocols, reacts in near real time, allocates power dynamically and treats "
               "security as a first-class requirement.")]

# 3 Objectives
story += [Paragraph("3. Objectives", H1)]
story += table([["#", "Objective", "Measure"],
                ["O1", "Fast reaction during grid stress", "New limits pushed to chargers in under 2 seconds"],
                ["O2", "Lower peak demand", "Reduce the site's EV demand peak versus an uncoordinated baseline (report target: at least 35% lower demand charges)"],
                ["O3", "Protect the transformer", "Load kept below 100% of rating, zero tripping events"],
                ["O4", "High availability", "99.99% cloud uptime for charger connections"],
                ["O5", "Zero-trust security", "Every device, message and service call authenticated; compromised devices isolated"]],
               [12 * mm, 55 * mm, 103 * mm], "Project objectives")

# 4 Literature
story += [PageBreak(), Paragraph("4. Literature survey (2020 to 2026)", H1),
          para("Ten works relevant to cloud infrastructure for EV charging, dynamic load balancing, cloud battery management and grid "
               "coordination were reviewed.")]
lit = [["Work", "Architecture", "Focus", "Advantage / disadvantage"],
       ["Gao et al. (2020): remote monitoring and fault detection for EV charging devices", "Centralised cloud streaming of charger data", "Preventive maintenance, fault detection", "+ Proved cloud streaming of telemetry. − Narrow fault logic, no reaction to grid load"],
       ["Concept review of a cloud-based smart BMS, MDPI Batteries (2022)", "Split between local BMS and cloud compute", "Limited on-board compute and storage", "+ Clear cloud vs local framework. − Conceptual, no deployment"],
       ["Karnehm et al. (2023): cloud framework for battery analytics", "Cloud telemetry with Extended Kalman Filter SoC estimation", "Fleet-scale real-time SoC", "+ Moved to predictive analytics. − EKF assumptions break for aged batteries"],
       ["Saner, Saha and Srinivasan (2023), IEEE T-ITS: charge-curve-aware scheduling", "Per-vehicle condition-aware scheduling", "Optimal scheduling at one site", "+ Dynamic per-bay limits. − No coordination with the upstream grid"],
       ["Ismail and Ahmed (2024), IEEE Access: review of cloud Li-ion BMS", "Survey of cloud BMS frameworks", "Limits of on-board BMS", "+ Broad comparison. − Review only"],
       ["Key technologies for cloud BMS, J. Electronic Materials (2024)", "Survey: data, protocols, AI, digital twins, edge", "Layer-by-layer comparison", "+ Useful technology map. − Layers treated separately"],
       ["AI + blockchain demand response, Scientific Reports (2024)", "AI forecasting with blockchain trust", "Scalability, privacy, real-time DR", "+ Load balancing and trust together. − Consensus overhead hurts sub-second targets"],
       ["Cloud AI framework for EV charging forecasting, Electronics (2026)", "ARIMA + LightGBM microservices", "Demand forecasting, station placement", "+ Strong accuracy on real data. − Planning tool, not live control"],
       ["Edge-intelligent EV charging coordination, Cluster Computing (2026)", "CNN+LSTM, XGBoost on edge hardware", "Cutting cloud latency", "+ 27.6% better utilisation, 24.5% lower peak. − Edge hardware cost and complexity"],
       ["Autonomous edge AI agents for EV charging (2026)", "Domain AI agents at the edge, < 100 ms", "Reliability of DC fast charging", "+ Very fast response. − Hard to audit and coordinate grid-wide"]]
story += table(lit, [48 * mm, 38 * mm, 34 * mm, 50 * mm], "Literature survey summary")

# 5 Gap
story += [Paragraph("5. Analysis of existing research and research gap", H1),
          para("Read in order, the works show a shift from the cloud as an <b>observer</b> (2020 to 2022: collect data, flag faults) to the "
               "cloud as a <b>decision-maker</b> (2023 to 2024: predictive analytics, condition-aware scheduling, trust). By 2026 the field "
               "splits: cloud-hosted ML for forecasting and planning on one side, and edge intelligence for split-second decisions on the other."),
          para("Three consistent findings stand out. Systems that rely on polling or batch processing struggle to react within seconds. "
               "Almost no work treats the utility side (OpenADR) and the charger side (OCPP) as one connected system. And security is usually "
               "added as a separate topic rather than designed in."),
          para("<b>Research gap:</b> none of the ten works combines (1) a real-time OpenADR to OCPP bridge, (2) a cloud-native pipeline fast "
               "enough to push new limits in under two seconds, (3) power allocation that adapts per vehicle and per moment, and (4) zero-trust "
               "security that can act on the grid itself. GridSync is designed to close this gap, and adds explainable AI decisions.")]

# 6 Challenges
story += [Paragraph("6. Challenges", H1), bullets([
    "<b>Live connections for thousands of chargers:</b> devices on unreliable cellular links must stay reachable and reconnect cleanly.",
    "<b>Translating grid signals instantly:</b> an OpenADR event must be mapped to the right site and chargers and turned into OCPP limits within seconds.",
    "<b>Decisions in under 2 s:</b> the system must read live transformer load, active sessions and states of charge, then compute a fair and safe split.",
    "<b>Securing remote hardware:</b> every message must prove it comes from a genuine device, and a compromised device must be cut off without trusting it to cooperate.",
    "<b>Real-world constraints:</b> the AWS account's organisation policy limited the available regions and services, so the design had to adapt (Section 10.4)."])]

# 7 Services
story += [PageBreak(), Paragraph("7. AWS services used", H1),
          para("Each service was chosen to solve a specific challenge. All are managed or serverless, so nothing runs idle on a provisioned server.")]
svc = [["Service", "Definition", "Role in GridSync"],
       ["AWS CloudFormation", "Infrastructure as code: AWS resources defined in a template and deployed as a stack.", f"One template creates all {len(STACK)} resources; one script deploys, one tears down."],
       ["AWS IoT Core", "Managed service for securely connecting IoT devices over MQTT, with registry, X.509 authentication, policies and a rules engine.", "9 things (8 chargers + transformer meter), mutual TLS, per-device policy, rule forwarding telemetry to SQS, OCPP commands to chargers."],
       ["Amazon SQS", "Fully managed message queue that decouples producers and consumers and absorbs bursts.", "Buffers telemetry between the IoT rule and the guard Lambda (batches of up to 100)."],
       ["AWS Lambda", "Serverless compute that runs code in response to events; pay per use.", "4 functions: telemetry guard (AI), control steps (AI inference), OpenADR, dashboard API."],
       ["AWS Step Functions", "Serverless workflow orchestration as a state machine with retries; Express type for high-volume, fast runs.", "6-step decision workflow every ~2 s, synchronous for OpenADR events."],
       ["Amazon DynamoDB", "Serverless NoSQL key-value database with millisecond latency.", "Charger state table and a single-table site store (time series, hourly history, events) with TTL."],
       ["Amazon API Gateway", "Managed service to create and secure HTTP/REST APIs in front of back-ends.", "HTTP API: POST /openadr, GET /state, POST /mode, POST /demo."],
       ["Amazon S3", "Durable object storage.", "Website files, Lambda package and the trained model artifact."],
       ["Amazon CloudFront", "Global content delivery network with HTTPS.", "Serves the dashboard from a private S3 bucket via Origin Access Control."],
       ["AWS IAM", "Identity and access management: users, roles and policies.", "Least-privilege roles for Lambda, IoT rule and Step Functions."],
       ["Amazon CloudWatch", "Monitoring: metrics, logs, dashboards.", "GridSync dashboard (messages, executions, latency, errors) and Lambda logs."],
       ["AWS Budgets", "Cost tracking with alerts.", "$10/month budget with email alerts."]]
story += table(svc, [32 * mm, 66 * mm, 72 * mm], "AWS services: definition and role")

# 8 Architecture
story += [PageBreak(), Paragraph("8. Proposed and deployed architecture", H1),
          figure(architecture_diagram(), "GridSync architecture as deployed in ap-southeast-2"),
          figure(ops_strip(), "Cross-cutting services")]
story += [Paragraph("8.1 Data flows", H2), bullets([
    "<b>Telemetry:</b> every second each charger publishes voltage, current, power, limit and state of charge to <font name='Courier'>gridsync/&lt;thing&gt;/telemetry</font>. "
    "The IoT rule <font name='Courier'>SELECT *, topic(2) AS deviceId FROM 'gridsync/+/telemetry'</font> sends it to SQS, and the guard Lambda scores and stores it.",
    "<b>Control loop:</b> at most every 2 s the guard starts the Express state machine: ReadTransformerLoad, ReadChargerStatus, AIInference, ComputeLimits, "
    "WriteChargerState, PublishOcppCommands (OCPP SetChargingProfile on <font name='Courier'>gridsync/&lt;thing&gt;/cmd</font>).",
    "<b>Utility event:</b> POST /openadr on API Gateway invokes the OpenADR Lambda, which converts the requested reduction into an EV power cap and runs the workflow "
    "synchronously, so the HTTP reply reports the real end-to-end reaction time.",
    "<b>Security event:</b> when two of a charger's last three messages are anomalous, the guard sets its certificate INACTIVE, detaches its IoT policy and orders "
    "the trusted site controller to open that bay's contactor; the next control cycle reallocates power.",
    "<b>Dashboard:</b> the browser loads the site from CloudFront and polls GET /state every 2 s."])]

# 9 AI
story += [PageBreak(), Paragraph("9. AI and machine-learning models", H1),
          para("All three models are implemented from scratch in JavaScript (no ML libraries), trained on synthetic data generated from the "
               "same grid model, and evaluated on held-out data. The trained parameters are exported by a training job "
               "(<font name='Courier'>aws/scripts/export-models.js</font>, the role a SageMaker training job would play), stored in S3 and served inside Lambda.")]
story += [Paragraph("9.1 Demand forecaster: neural network (supervised)", H2),
          para("A multilayer perceptron (7 inputs, hidden layers of 16 and 12 tanh units, 1 output) trained with backpropagation and the Adam "
               "optimiser predicts next-hour site demand. Inputs: hour of day (sine and cosine), weekend flag, temperature, current load, load at "
               "the same hour yesterday and current EV demand. It was trained on 100 days and tested on 20 unseen days.")]
story += table([["Metric (20 unseen days)", "Value"], ["MLP mean absolute error", f"{f['mae']:.0f} kW"],
                ["Seasonal-naive baseline MAE", f"{f['seasonalMAE']:.0f} kW"], ["Error reduction", pct(f["improvement"])], ["R²", f"{f['r2']:.2f}"]],
               [90 * mm, 40 * mm], "Forecaster accuracy")
story += [Paragraph("9.2 Charging agent: Q-learning (reinforcement learning)", H2),
          para("A tabular Q-learning agent chooses what share of the transformer's headroom (55%, 70%, 80%, 90% or 100%) to give EV charging. "
               "Its state combines time of day, neighbourhood load, requested EV demand, the forecaster's predicted trend and today's peak "
               "(1,152 states). The reward is energy delivered, minus penalties for overloads, new demand peaks and waiting customers. "
               "It was trained on 6,000 simulated days and compared on 30 unseen days with the same random seed for every policy.")]
story += table([["Policy (30 unseen days)", "Overloads", "EV peak (kW)", "Energy (MWh)"],
                ["Static per-charger limits", rl["static"]["overloads"], f"{rl['static']['peakKW']:.0f}", f"{rl['static']['energyMWh']:.1f}"],
                ["Cloud rule (950 kW − base load)", rl["rules"]["overloads"], f"{rl['rules']['peakKW']:.0f}", f"{rl['rules']['energyMWh']:.1f}"],
                ["GridSync RL agent", rl["ai"]["overloads"], f"{rl['ai']['peakKW']:.0f}", f"{rl['ai']['energyMWh']:.1f}"]],
               [70 * mm, 30 * mm, 35 * mm, 35 * mm], "Reinforcement-learning agent versus baselines")
story += [para(f"Against the fixed cloud rule, the agent cut overload events by {pct(1 - rl['ai']['overloads'] / rl['rules']['overloads'])} and the EV "
               f"peak by {pct(1 - rl['ai']['peakKW'] / rl['rules']['peakKW'])}, while delivering {pct(rl['ai']['energyMWh'] / rl['rules']['energyMWh'])} of "
               "the energy: it learns to trade a little charging speed for a safety margin against neighbourhood load spikes. When a live "
               "situation was never seen in training (all Q-values zero), the controller falls back to the nearest learned state and says so "
               "in its explanation.")]
story += [Paragraph("9.3 Telemetry guard: Isolation Forest (unsupervised)", H2),
          para("An Isolation Forest of 200 random trees scores every charger message. It is fitted on an unlabelled slice of the message stream "
               "(with about 2% unknown attacks), so no labelled attack data is needed. Its features are physics-informed: voltage deviation, the "
               "residual between reported power and voltage times current, compliance with the commanded limit and message cadence. "
               "A charger is quarantined when two of its last three messages exceed the threshold.")]
story += table([["Metric (held-out messages)", "Value"], ["False-positive rate", f"{ids['fpr'] * 100:.1f}%"],
                ["Overall attack recall (per message)", pct(ids["recall"])], ["False data injection", pct(ids["tpr"]["fdi"])],
                ["Replay / message flooding", pct(ids["tpr"]["flood"])], ["Limit bypass + meter spoofing", pct(ids["tpr"]["bypass"])]],
               [90 * mm, 40 * mm], "Intrusion detector accuracy")
story += [para("<b>Lesson from live testing.</b> The first version, trained only on chargers drawing 40 to 100% of a limit of at least 15% of their rating, "
               "raised false alarms on the live system: cars waiting for their first limit (about 0 kW), heavily throttled sessions and cars "
               "drawing far less than allowed are all normal. The training data was widened to include these states, and a power-level feature "
               "that made high-power charging look like an outlier was removed. The false-positive rate on live-like states dropped to 0%, and "
               "a 60-second evening-rush soak test on AWS produced no false quarantines while a real attack was still caught. Limit-bypass "
               "detection is lowest because when a charger's limit is already near its rating, cheating changes almost nothing physically."),
          Paragraph("9.4 Explainable decisions", H2),
          para("Every AI decision is stored with its explanation: the forecast and its main drivers (feature attributions by perturbation), "
               "the Q-value for every action, and a plain-language sentence. The dashboard shows this for every Step Functions run, which "
               "supports operator trust and auditability, a gap noted in the 2026 edge-agent literature.")]

# 10 Implementation
story += [PageBreak(), Paragraph("10. Implementation on AWS", H1), Paragraph("10.1 Infrastructure as code", H2),
          para(f"The whole backend is <font name='Courier'>aws/template.yaml</font>. The deployed stack <b>gridsync</b> contains {len(STACK)} resources:")]
counts = {}
for r in STACK:
    counts[r["t"]] = counts.get(r["t"], 0) + 1
rows = [["Resource type", "Count"]] + [[k.replace("AWS::", ""), v] for k, v in sorted(counts.items(), key=lambda x: (-x[1], x[0]))]
story += table(rows, [100 * mm, 25 * mm], "Resources in the deployed CloudFormation stack (exported from the live account)")
story += table([["Lambda function", "Runtime", "Memory", "Trigger"]] +
               [[l["n"], l["r"], f"{l['m']} MB", {"gridsync-telemetry-guard": "SQS", "gridsync-control-steps": "Step Functions",
                                                   "gridsync-openadr": "API Gateway", "gridsync-dashboard-api": "API Gateway"}[l["n"]]] for l in LAMBDAS],
               [60 * mm, 30 * mm, 25 * mm, 45 * mm], "Lambda functions")
story += [Paragraph("10.2 Data model (DynamoDB)", H2), bullets([
    "<b>gridsync-charger-state</b> (key: deviceId): live status of each charger: reported power, state of charge, AI limit, anomaly score, recent flags, ACTIVE or QUARANTINED.",
    "<b>gridsync-site</b> (keys: pk, sk), single-table design: site state (mode, last decision and its timeline), the load time series, hourly "
    "aggregates used as forecaster inputs, and the event log. Time-series and event rows expire automatically after one day (TTL)."]),
    Paragraph("10.3 Deployment and devices", H2), bullets([
        "<font name='Courier'>aws/scripts/deploy.ps1</font>: trains and exports the models, packages and uploads the Lambda code to S3, deploys the "
        "stack, creates the 9 IoT things with their own certificates, and publishes the website.",
        "<font name='Courier'>sim/charger-sim.js</font>: the edge simulator. Each of the 9 devices opens its own MQTT connection with its certificate, "
        "publishes telemetry every second and obeys SetChargingProfile commands. The transformer device also acts as the trusted site controller that "
        "opens or closes bay contactors.",
        "<font name='Courier'>aws/scripts/teardown.ps1</font> removes everything; <font name='Courier'>reset-demo.sh</font> restores a clean demo state."]),
    Paragraph("10.4 Adapting to account constraints", H2),
    para("The AWS account belongs to an AWS Organization whose service control policy (SCP) denies most services outside one region and denies "
         "Kinesis and Timestream entirely. The design was adapted rather than abandoned:")]
story += table([["Original design", "Deployed", "Reason"],
                ["Region ap-south-1 (Mumbai)", "ap-southeast-2 (Sydney)", "The SCP only allows this region"],
                ["Kinesis Data Streams", "IoT Rule → SQS → Lambda", "Kinesis denied; SQS gives the same buffered, batched stream"],
                ["Amazon Timestream", "DynamoDB time series with TTL", "Timestream denied, and closed to new customers"],
                ["SageMaker real-time endpoint", "Models trained offline, served in Lambda", "No always-on cost; inference inside the 2 s path"]],
               [45 * mm, 55 * mm, 70 * mm], "Design adaptations")

# 11 Security
story += [Paragraph("11. Security design", H1), bullets([
    "<b>Device identity:</b> every charger has its own X.509 certificate and private key and connects with mutual TLS; there are no shared passwords.",
    "<b>Least-privilege IoT policy:</b> policy variables restrict each device to connecting as itself, publishing only to its own telemetry topic and receiving only its own commands.",
    "<b>AI enforcement:</b> the Isolation Forest guard revokes a compromised device's certificate, detaches its policy and has the site controller cut its power within the same control cycle.",
    "<b>Least-privilege IAM:</b> Lambda can only reach the two project tables, the gridsync topics and the project state machine; the IoT rule can only send to one queue.",
    "<b>Private storage:</b> the website bucket blocks all public access and is readable only by CloudFront through Origin Access Control; all traffic is HTTPS.",
    "<b>Encryption:</b> DynamoDB, S3 and SQS encrypt data at rest by default; MQTT and HTTPS encrypt data in transit."])]

# 12 Cost
story += [Paragraph("12. Cost analysis", H1),
          para("Every component is pay-per-use. With the simulator running (9 devices, one message per second each, a control run every 2 s) "
               "the deployment costs roughly US$2 to $3 per day, dominated by IoT messages, DynamoDB writes and Lambda invocations. With the "
               "devices stopped, cost falls to almost zero (storage only). An AWS Budget emails the team at 80% of a $10 monthly limit. "
               "Old telemetry expires automatically through DynamoDB TTL, so storage does not grow. At larger scale the same design scales "
               "horizontally with no servers to provision, unlike an always-on fleet sized for the evening peak.")]

# 13 Results
story += [Spacer(1, 6), Paragraph("13. Results and evaluation", H1),
          para("All live figures below were measured on the deployed AWS system while recording the demo video.")]
story += table([["Objective", "Result", "Status"],
                ["O1: reaction under 2 s", f"Control decision {LIVE['step']}; OpenADR −30% reached all chargers in {LIVE['adr']}", "Met"],
                ["O2: lower peak demand", f"RL agent: EV peak −{pct(1 - rl['ai']['peakKW'] / rl['rules']['peakKW'])} vs fixed rule; live EV load held to the AI budget during the rush", "Met (simulation)"],
                ["O3: transformer < 100%, zero trips", "Load stayed below 100% in AI mode; no trips during rush, OpenADR and attack demos", "Met"],
                ["O4: 99.99% uptime", "Managed serverless services; devices reconnect automatically through IoT Core", "By design (not measured long-term)"],
                ["O5: zero-trust security", "Attack detected in about 1 s, certificate revoked, bay isolated; 0% false alarms in soak test", "Met"]],
               [45 * mm, 95 * mm, 30 * mm], "Results against objectives")
shots = [("shot-steps.png", "Live control room: transformer load from the IoT meter, Step Functions timeline and the AI's explanation"),
         ("shot-bays.png", "Evening rush: all eight chargers active and sharing the AI-computed budget"),
         ("shot-openadr.png", f"OpenADR −30% request answered by the cloud in {LIVE['adr']}"),
         ("shot-quarantine.png", "Cyber attack: the compromised charger is quarantined and its certificate set INACTIVE"),
         ("shot-ailab.png", "AI Lab: the three models trained and evaluated on held-out data"),
         ("shot-rl.png", "Reinforcement-learning agent compared with static limits and fixed cloud rules")]
for fn, cap in shots:
    if (MEDIA / fn).exists():
        story.append(figure(MEDIA / fn, cap, width=150 * mm))

# 14 Novelty
story += [PageBreak(), Paragraph("14. Novelty", H1), bullets([
    "<b>Forecast-informed reinforcement-learning control:</b> a neural forecast feeds an RL agent that learns its own safety margin, instead of a hand-tuned limit.",
    "<b>Security that acts on the grid:</b> an unsupervised, physics-informed detector revokes the device's identity in IoT Core and reallocates its power in the same cycle, joining the security and grid-control loops.",
    "<b>Explainable decisions:</b> every action is logged with Q-values, forecast drivers and a plain-language reason.",
    "<b>OpenADR to OCPP in under 2 s, fully serverless:</b> deployed as code, scaling from one site to thousands of chargers with no servers to manage."])]

# 15 Limitations
story += [Paragraph("15. Limitations and future work", H1), bullets([
    "Grid, vehicles and attacks are simulated; a pilot with real OCPP 2.0.1 chargers and real utility OpenADR 3.0 events is the next step.",
    "Telemetry uses SQS because of account policy; with Kinesis available, ordered per-device streams would allow longer real-time analytics windows.",
    "The RL agent is tabular; a deep RL policy (trained on SageMaker) could handle many sites and finer actions.",
    "Limit-bypass attacks near a charger's full rating are hard to detect from telemetry alone; adding the transformer's measured current per feeder would close this gap.",
    "Long-term availability (99.99%) was designed for but not measured over weeks."])]

# 16 Conclusion
story += [Paragraph("16. Conclusion", H1),
          para("GridSync shows that a fully serverless AWS architecture can coordinate EV fast chargers with the grid fast enough to prevent "
               "overloads. Deployed as a single CloudFormation stack on a real account, it bridges OpenADR and OCPP in about half a second, "
               "recomputes every charger's limit every two seconds with a neural-network forecast and a reinforcement-learning policy, and "
               "isolates a compromised charger within about a second. Testing on the live system also exposed and fixed a real false-alarm "
               "problem in the intrusion detector, which strengthened the final design. The result is a system that is fast enough to protect "
               "the grid, flexible enough to use spare capacity, and secure by design.")]

# References
refs = ["Gao et al., remote monitoring and fault detection for EV charging devices, 2020.",
        "Concept review of a cloud-based smart battery management system for lithium-ion batteries, MDPI Batteries, 2022.",
        "Karnehm et al., cloud-based framework for scalable, centralised battery analytics, 2023.",
        "Saner, Saha and Srinivasan, charge-curve and BMS-aware optimal charging scheduling framework, IEEE Transactions on Intelligent Transportation Systems, 2023.",
        "Ismail and Ahmed, a comprehensive review of cloud-based lithium-ion battery management systems for EV applications, IEEE Access, 2024.",
        "A brief review of key technologies for cloud-based battery management systems, Journal of Electronic Materials, 2024.",
        "Optimizing demand response and load balancing in smart EV charging networks using an AI-integrated blockchain framework, Scientific Reports, 2024.",
        "Cloud-based AI framework for EV charging forecasting and infrastructure optimization, Electronics (MDPI), 2026.",
        "Edge-intelligent EV charging coordination for grid load balancing and renewable integration, Cluster Computing, 2026.",
        "Autonomous edge-deployed AI agents for electric vehicle charging infrastructure management, 2026.",
        "F. T. Liu, K. M. Ting and Z.-H. Zhou, Isolation Forest, IEEE International Conference on Data Mining, 2008.",
        "Amazon Web Services documentation: AWS IoT Core, Amazon SQS, AWS Lambda, AWS Step Functions, Amazon DynamoDB, Amazon API Gateway, Amazon CloudFront, AWS CloudFormation."]
story += [PageBreak(), Paragraph("References", H1)] + [Paragraph(f"[{i + 1}] {r}", P) for i, r in enumerate(refs)]

# Appendix
story += [PageBreak(), Paragraph("Appendix A: repository layout and how to run", H1)]
story += table([["Path", "Contents"],
                ["aws/template.yaml", "CloudFormation template for the whole backend"],
                ["aws/lambda/", "guard.js (AI guard), control.js (workflow steps), openadr.js, api.js, lib.js"],
                ["aws/scripts/", "export-models.js (training job), deploy.ps1, teardown.ps1, reset-demo.sh"],
                ["sim/charger-sim.js", "Edge simulator: 8 chargers + transformer over MQTT and mutual TLS"],
                ["ml.js, ai.js", "From-scratch MLP, Q-learning and Isolation Forest; grid model and training"],
                ["index.html, app.js, aws-live.js", "Dashboard: live AWS control room, simulation and AI Lab"],
                ["docs/", "This report, pitch, presentation script and demo video"]],
               [50 * mm, 120 * mm], "Repository layout")
story += [Paragraph("Run the demo", H2), Paragraph(
    "cd sim<br/>node charger-sim.js<br/># then open https://dye305b97k5t7.cloudfront.net and choose Live on AWS<br/><br/>"
    "# redeploy from scratch<br/>.\\aws\\scripts\\deploy.ps1 -BudgetEmail &lt;email&gt;<br/># remove everything<br/>.\\aws\\scripts\\teardown.ps1", MONO)]

doc = SimpleDocTemplate(str(OUT), pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm, topMargin=16 * mm, bottomMargin=18 * mm,
                        title="GridSync - Project Report", author="Anish P & Neeraj K (Team 4)")
doc.build(story, onFirstPage=page_frame, onLaterPages=page_frame)
print(f"wrote {OUT}")

"""Builds docs/GridSync-Pitch.pdf (the team pitch + AWS demo checklist).
Usage: python docs/make_pitch_pdf.py"""
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table,
                                TableStyle)

OUT = Path(__file__).with_name("GridSync-Pitch.pdf")
PURPLE = colors.HexColor("#5b34d6")
CYAN = colors.HexColor("#0f8f86")
AMBER = colors.HexColor("#b86e00")
INK = colors.HexColor("#1d1b33")
MUTED = colors.HexColor("#5d5b78")
SOFT = colors.HexColor("#f2effd")
SOFT2 = colors.HexColor("#e9f7f5")
LINE = colors.HexColor("#d9d4f5")

ss = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=ss["Title"], fontName="Helvetica-Bold", fontSize=24, leading=28, textColor=INK, spaceAfter=2)
SUB = ParagraphStyle("Sub", parent=ss["Normal"], fontSize=10.5, leading=14, textColor=MUTED, alignment=TA_CENTER)
H2 = ParagraphStyle("H2", parent=ss["Heading2"], fontName="Helvetica-Bold", fontSize=14, leading=18, textColor=PURPLE, spaceBefore=10, spaceAfter=6)
BODY = ParagraphStyle("Body", parent=ss["Normal"], fontSize=10.5, leading=15, textColor=INK)
QUOTE = ParagraphStyle("Quote", parent=BODY, fontSize=11, leading=16, leftIndent=4)
SMALL = ParagraphStyle("Small", parent=BODY, fontSize=9, leading=12.5, textColor=MUTED)
CELL = ParagraphStyle("Cell", parent=BODY, fontSize=9.3, leading=12.5)
CELLB = ParagraphStyle("CellB", parent=CELL, fontName="Helvetica-Bold", textColor=colors.white)
CODE = ParagraphStyle("Code", parent=BODY, fontName="Courier", fontSize=9, leading=12, textColor=INK)


def speaker_block(who, title, timing, color, paras):
    head = Paragraph(f'<font color="{color.hexval()}"><b>{who}</b></font> &nbsp;·&nbsp; <b>{title}</b> '
                     f'<font color="#5d5b78" size="9">({timing})</font>', BODY)
    body = [Paragraph(p, QUOTE) for p in paras]
    t = Table([[head]] + [[b] for b in body], colWidths=[170 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), SOFT),
        ("LINEBEFORE", (0, 0), (0, -1), 3, color),
        ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, 0), 8), ("BOTTOMPADDING", (0, -1), (-1, -1), 9),
        ("TOPPADDING", (0, 1), (-1, -1), 3),
    ]))
    return KeepTogether([t, Spacer(1, 8)])


def grid(rows, widths, header_color=PURPLE):
    data = [[Paragraph(c, CELLB) for c in rows[0]]] + [[Paragraph(c, CELL) for c in r] for r in rows[1:]]
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), header_color),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, SOFT]),
        ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return t


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(PURPLE)
    canvas.rect(0, A4[1] - 6 * mm, A4[0], 6 * mm, stroke=0, fill=1)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(20 * mm, 10 * mm, "GridSync · Team 4 · Anish P (24BCE2394) & Neeraj K (24BCE2393)")
    canvas.drawRightString(A4[0] - 20 * mm, 10 * mm, f"Page {doc.page}")
    canvas.restoreState()


story = [
    Spacer(1, 4 * mm),
    Paragraph("GridSync", H1),
    Paragraph("AI-driven AWS cloud for smart EV fast-charging &amp; power grid management", SUB),
    Spacer(1, 2),
    Paragraph("Team Pitch &nbsp;·&nbsp; about 5 minutes &nbsp;·&nbsp; Anish explains, Neeraj drives the AWS demo", SUB),
    Spacer(1, 10),
]

kpis = grid([
    ["&lt; 1 s", "~0.5 s", "~1 s", "0"],
    ["control decision on AWS", "OpenADR cut reaches all chargers (target 2 s)", "AI catches a hacked charger", "feeder trips with GridSync AI"],
], [42.5 * mm] * 4, header_color=CYAN)
kpis.setStyle(TableStyle([("ALIGN", (0, 0), (-1, -1), "CENTER"), ("FONTSIZE", (0, 0), (-1, 0), 14)]))
story += [kpis, Spacer(1, 6)]

story += [Paragraph("The pitch", H2)]
story.append(speaker_block("ANISH", "1. The problem", "45 s", PURPLE, [
    "“Ma’am, at 6 PM many electric cars plug into the same fast-charging station. Each one pulls up to "
    "<b>350 kW</b>. The local transformer was never built for that, so it overloads, the breaker trips, and the whole area loses power.”",
    "“The grid usually has enough power. The real problem is that <b>chargers and the power company can’t talk to each other "
    "fast enough</b>. They use different languages (OCPP and OpenADR), and today’s systems take 15 to 30 seconds to react.”",
]))
story.append(speaker_block("ANISH", "2. Our solution", "45 s", PURPLE, [
    "“We built <b>GridSync</b>, a cloud system on <b>AWS</b> between the power company and the chargers. Every 2 seconds "
    "it reads the transformer load, decides how much power each car can safely take, and sends new limits to the chargers in <b>under one second</b>.”",
    "“Three AI models make the decisions: a <b>neural network</b> that predicts demand, a <b>reinforcement-learning agent</b> "
    "that learns how much safety margin to keep, and an <b>anomaly detector</b> that spots hacked chargers.”",
]))
story.append(speaker_block("NEERAJ", "3. Live AWS demo", "3 min", CYAN, [
    "“Everything you’ll see now is running live on our AWS account.” Follow the 5 screens on the next page.",
]))
story.append(speaker_block("ANISH", "4. What’s new, and close", "30 s", PURPLE, [
    "“Other systems either predict, or control, or secure. We do all three in one loop. When our AI finds a hacked charger, "
    "it doesn’t just raise an alert: it <b>revokes the charger’s identity in AWS and cuts its power</b>, so the grid stays safe. "
    "It’s serverless, so it costs almost nothing when idle and scales to thousands of chargers. Thank you.”",
]))

story += [PageBreak(), Paragraph("What to show in AWS (Neeraj)", H2),
          Paragraph("<b>Region:</b> Asia Pacific (Sydney), selected at the top right of the AWS console. "
                    "<b>Dashboard:</b> https://dye305b97k5t7.cloudfront.net, then click <b>Live on AWS</b>.", BODY),
          Spacer(1, 6),
          Paragraph("<b>10 minutes before:</b> start the 8 chargers and the transformer in PowerShell, and wait for 9 “connected” lines:", BODY),
          Spacer(1, 3),
          Paragraph("cd $HOME\\OneDrive\\Documents\\GridSync\\Cloud-power-grid-management\\sim<br/>node charger-sim.js", CODE),
          Spacer(1, 8)]

story.append(grid([
    ["#", "Open this", "Point at", "Say"],
    ["1", "<b>CloudFormation</b> → gridsync → Resources", "The list of about 30 resources",
     "“Our whole architecture is code. One command builds it, one deletes it.”"],
    ["2", "<b>IoT Core</b> → Things", "charger-01 … charger-08, transformer-01",
     "“Nine real devices. Each has its own security certificate, so no password can leak.”"],
    ["3", "<b>Dashboard</b> → Live on AWS", "Green “Live” pill, load below 100%, Step Functions ≈ 0.2 s, AI explanation",
     "“This is live data from AWS. The AI explains every decision.”"],
    ["4", "Dashboard: <b>POST /openadr −30%</b>", "Result line: “Cloud reaction ≈ 0.5 s”",
     "“The power company asked for a 30% cut, and all chargers obeyed in half a second. Our target was 2 seconds.”"],
    ["5", "Dashboard: <b>Cyber attack</b>, then IoT Core → Security → <b>Certificates</b>",
     "Bay turns QUARANTINED, one certificate shows Inactive",
     "“A charger was hacked. Our AI caught it in about a second, switched off its certificate and cut its power. The grid never tripped.”"],
], [8 * mm, 42 * mm, 50 * mm, 70 * mm]))
story += [Spacer(1, 4), Paragraph("Finish by clicking <b>Restore certificates</b>.", SMALL), Spacer(1, 8)]

story += [Paragraph("If there’s extra time", H2),
          Paragraph("• <b>Step Functions</b> → gridsync-control → Graph: “These are the 6 decision steps.”<br/>"
                    "• <b>IoT Core</b> → MQTT test client → subscribe to <font name='Courier'>gridsync/+/cmd</font>: live commands to the chargers.<br/>"
                    "• <b>CloudWatch</b> → Dashboards → GridSync: monitoring.", BODY)]

story += [Paragraph("Likely questions", H2), grid([
    ["Question", "Short answer"],
    ["Why Sydney and not Mumbai?", "Our AWS account’s organization policy only allows the Sydney region."],
    ["Why SQS and not Kinesis like the report?", "Kinesis is blocked on our account. SQS does the same job of buffering the data stream into Lambda."],
    ["Is the data real?", "The chargers are simulated on our laptop, but they are real AWS IoT devices with real certificates, and everything else runs on real AWS services."],
    ["Where does the AI run?", "The models were trained offline. Their weights are stored in S3 and run inside AWS Lambda during each decision."],
    ["What does it cost?", "About $2–3 a day while the chargers run, and almost $0 when they’re stopped. A $10 budget alarm protects us."],
], [55 * mm, 115 * mm])]

story += [Spacer(1, 10), Paragraph("<b>After the demo:</b> press Ctrl+C in the charger window. After grading, run "
                                   "<font name='Courier'>.\\aws\\scripts\\teardown.ps1</font> and delete the old access key in IAM.", SMALL)]

doc = SimpleDocTemplate(str(OUT), pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm, topMargin=16 * mm, bottomMargin=18 * mm,
                        title="GridSync - Team Pitch", author="Anish P & Neeraj K (Team 4)")
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(f"wrote {OUT}")

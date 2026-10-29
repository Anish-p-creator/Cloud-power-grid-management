"""Builds docs/GridSync-Presentation-Script.pdf (word-for-word script for the live AWS presentation).
Usage: python docs/make_script_pdf.py"""
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

OUT = Path(__file__).with_name("GridSync-Presentation-Script.pdf")
PURPLE = colors.HexColor("#5b34d6")
CYAN = colors.HexColor("#0f8f86")
INK = colors.HexColor("#1d1b33")
MUTED = colors.HexColor("#5d5b78")
SOFT = colors.HexColor("#f2effd")
SOFT2 = colors.HexColor("#e9f7f5")

ss = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=ss["Title"], fontName="Helvetica-Bold", fontSize=22, leading=26, textColor=INK, spaceAfter=2)
SUB = ParagraphStyle("Sub", parent=ss["Normal"], fontSize=10.5, leading=14, textColor=MUTED, alignment=TA_CENTER)
H2 = ParagraphStyle("H2", parent=ss["Heading2"], fontName="Helvetica-Bold", fontSize=13.5, leading=17, textColor=INK, spaceBefore=8, spaceAfter=4)
CUE = ParagraphStyle("Cue", parent=ss["Normal"], fontName="Helvetica-Bold", fontSize=9.5, leading=13, textColor=CYAN)
SAY = ParagraphStyle("Say", parent=ss["Normal"], fontSize=11, leading=16, textColor=INK)
SMALL = ParagraphStyle("Small", parent=ss["Normal"], fontSize=9, leading=12.5, textColor=MUTED)


def section(title, speaker, color, beats):
    """beats: list of (cue or None, spoken text)."""
    head = Paragraph(f'{title} <font color="{color.hexval()}" size="10">({speaker})</font>', H2)
    rows = []
    for cue, text in beats:
        cell = []
        if cue:
            cell.append(Paragraph("SHOW: " + cue, CUE))
            cell.append(Spacer(1, 2))
        cell.append(Paragraph(text, SAY))
        rows.append([cell])
    t = Table(rows, colWidths=[170 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), SOFT if color == PURPLE else SOFT2),
        ("LINEBEFORE", (0, 0), (0, -1), 3, color),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, colors.white),
        ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return [KeepTogether([head, t]), Spacer(1, 6)]


def frame(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(PURPLE)
    canvas.rect(0, A4[1] - 6 * mm, A4[0], 6 * mm, stroke=0, fill=1)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(20 * mm, 10 * mm, "GridSync · Team 4 · Anish P (24BCE2394) & Neeraj K (24BCE2393) · Presentation script")
    canvas.drawRightString(A4[0] - 20 * mm, 10 * mm, f"Page {doc.page}")
    canvas.restoreState()


q = lambda s: f"“{s}”"

story = [
    Spacer(1, 3 * mm),
    Paragraph("GridSync: Presentation Script", H1),
    Paragraph("AI-driven AWS cloud for EV fast charging &amp; power grid management", SUB),
    Paragraph("Anish: opening, problem, solution, closing &nbsp;·&nbsp; Neeraj: live AWS demo", SUB),
    Spacer(1, 8),
]

story += section("1. Opening", "Anish", PURPLE, [
    ("Dashboard home page",
     q("Good morning ma’am. We are Anish and Neeraj, Team 4. Our project is <b>GridSync</b>, an AI-driven AWS cloud "
       "system for EV fast charging and power grid management.")),
])
story += section("2. The problem", "Anish", PURPLE, [
    (None, q("In the evening, many electric cars plug into the same charging station at once. Each one takes up to 350 kW. "
             "The local transformer can’t handle that much together, so it overloads, the breaker trips, and the whole area loses power.")),
    (None, q("The grid usually has enough electricity. The real problem is <b>coordination</b>. The power company and the chargers "
             "use different protocols, OpenADR and OCPP, and today’s systems take 15 to 30 seconds to react. That is far too slow.")),
])
story += section("3. Our solution", "Anish", PURPLE, [
    (None, q("GridSync sits on AWS between the power company and the chargers. Every 2 seconds it checks the transformer load, "
             "decides how much power each car can safely take, and sends new limits to the chargers in under one second.")),
    (None, q("Three AI models make those decisions: a <b>neural network</b> that predicts demand, a <b>reinforcement-learning agent</b> "
             "that decides how much safety margin to keep, and an <b>anomaly detector</b> that catches hacked chargers.")),
])
story += section("4. Live AWS demo", "Neeraj", CYAN, [
    ("Tab A: CloudFormation → gridsync → Resources",
     q("This is our real AWS account. Our entire architecture is written as code in one CloudFormation template, about 30 resources: "
       "IoT Core, Lambda, Step Functions, API Gateway, DynamoDB, SQS, S3 and CloudFront. One command builds it and one command deletes it.")),
    ("Tab B: IoT Core → Things",
     q("These are our 9 IoT devices: 8 fast chargers and 1 transformer meter. Each has its own X.509 certificate and connects with "
       "mutual TLS. That’s zero-trust security: no passwords that can leak.")),
    ("Dashboard → Live on AWS",
     q("This dashboard reads live data from AWS. Here is the transformer load, always kept under 100%. Here is the Step Functions run "
       "time, about 0.2 seconds. And here the AI <b>explains its decision</b>: the forecast, and how much power it gave the cars.")),
    ("Tab C: MQTT test client (messages arriving)",
     q("These messages are the AI’s commands going to each charger right now, the OCPP SetChargingProfile command.")),
    ("Tab D: Step Functions graph",
     q("This is the decision workflow. Read the load, read the chargers, run the AI, compute fair limits, save them to DynamoDB, "
       "and send the commands. It runs every 2 seconds.")),
    ("Dashboard: click “POST /openadr −30%”",
     q("Now the power company sends an emergency request: cut the load by 30%. Our API Gateway receives it, and all 8 chargers obeyed "
       "in about <b>0.5 seconds</b>. Our target was 2 seconds.")),
    ("Dashboard: click “Cyber attack”, then Tab E: Certificates (refresh)",
     q("Now a charger gets hacked: it ignores its limit and sends fake data. Our anomaly detector caught it in about a second. "
       "It <b>switched off that charger’s certificate</b>, which you can see is now Inactive here, and cut its power. The grid never tripped.")),
    ("Dashboard: click “Restore certificates”",
     q("After inspection, we restore it.")),
])
story += section("5. Closing", "Anish", PURPLE, [
    (None, q("To summarise: other systems only predict, or only control, or only secure. GridSync does all three in one loop, live on AWS. "
             "It’s fully serverless, so it costs almost nothing when idle and can scale to thousands of chargers.")),
    (None, q("Thank you ma’am. We’re happy to answer questions.")),
])

doc = SimpleDocTemplate(str(OUT), pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm, topMargin=16 * mm, bottomMargin=18 * mm,
                        title="GridSync - Presentation Script", author="Anish P & Neeraj K (Team 4)")
doc.build(story, onFirstPage=frame, onLaterPages=frame)
print(f"wrote {OUT}")

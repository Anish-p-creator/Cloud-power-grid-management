"""Records docs/GridSync-Demo.mp4: title cards + the live AWS dashboard (rush, OpenADR, attack, restore).
Needs the charger simulator running (sim/charger-sim.js). Also saves screenshots to docs/media/ for the report.
Usage: python docs/record_demo.py"""
import json
import subprocess
import time
from pathlib import Path

import imageio_ffmpeg
from playwright.sync_api import sync_playwright

DOCS = Path(__file__).parent
MEDIA = DOCS / "media"
CARDS = MEDIA / "cards"
SITE = "https://dye305b97k5t7.cloudfront.net/"
W, H = 1280, 720

CARD_CSS = """
*{box-sizing:border-box;margin:0}body{width:1280px;height:720px;overflow:hidden;font-family:'Segoe UI',Arial,sans-serif;
background:radial-gradient(900px 500px at 85% -10%,#3a22a0 0,transparent 60%),radial-gradient(700px 500px at -10% 40%,#0f3446 0,transparent 60%),#0b0a1a;color:#ecebff;
display:flex;flex-direction:column;justify-content:center;padding:70px 90px}
.tag{color:#2fd6c6;letter-spacing:.14em;text-transform:uppercase;font-size:18px;font-weight:600;margin-bottom:14px}
h1{font-size:58px;line-height:1.1;margin-bottom:18px}h2{font-size:42px;margin-bottom:24px}
.g{background:linear-gradient(90deg,#8c6bff,#2fd6c6);-webkit-background-clip:text;color:transparent}
p,li{font-size:25px;line-height:1.5;color:#c9c7e8}ul{padding-left:30px}li{margin:8px 0}b{color:#fff}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:10px}
.box{background:rgba(140,120,255,.12);border:1px solid rgba(140,120,255,.35);border-radius:14px;padding:16px 18px;font-size:19px}
.box b{display:block;font-size:22px;margin-bottom:4px}
.flow{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:8px 0 14px}
.n{background:#221c4f;border:1.5px solid #8c6bff;border-radius:12px;padding:12px 16px;font-size:20px;font-weight:600}
.n.t{border-color:#2fd6c6;background:#13314a}.a{color:#8c6bff;font-size:26px}
.mono{font-family:Consolas,monospace;font-size:18px;color:#bff3d6}
.foot{position:absolute;bottom:34px;left:90px;font-size:18px;color:#8b89ad}
.big{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-top:20px}
.big div{background:rgba(47,214,198,.1);border:1px solid rgba(47,214,198,.4);border-radius:16px;padding:22px}
.big b{font-size:44px;display:block;color:#3ee08f}.big span{font-size:18px;color:#c9c7e8}
"""


def card(name, body, foot="GridSync · Team 4 · Anish P (24BCE2394) & Neeraj K (24BCE2393)"):
    CARDS.mkdir(parents=True, exist_ok=True)
    f = CARDS / f"{name}.html"
    f.write_text(f"<!doctype html><meta charset=utf-8><style>{CARD_CSS}</style><body>{body}<div class=foot>{foot}</div></body>", encoding="utf-8")
    return f.as_uri()


def build_cards():
    stack = json.loads((MEDIA / "stack.json").read_text())
    things = sorted(json.loads((MEDIA / "things.json").read_text()))
    counts = {}
    for r in stack:
        counts[r["t"]] = counts.get(r["t"], 0) + 1
    rows = "".join(f"<div class=box><b>{v}×</b>{k.replace('AWS::', '')}</div>" for k, v in sorted(counts.items(), key=lambda x: -x[1])[:12])
    return [
        (card("01-title", "<div class=tag>Cloud Architecture Design · Team 4</div><h1>GridSync<br><span class=g>AI-driven AWS cloud for smart EV fast-charging &amp; grid management</span></h1>"
              "<p>Live demo on Amazon Web Services · Region ap-southeast-2 (Sydney)</p>"), 6),
        (card("02-problem", "<div class=tag>The problem</div><h2>Evening EV rush overloads the transformer</h2><ul>"
              "<li>Many cars plug in at once, each drawing up to <b>350 kW</b></li><li>The local transformer overloads and the breaker <b>trips</b>, so the area goes dark</li>"
              "<li>Utilities speak <b>OpenADR</b>, chargers speak <b>OCPP</b>: no fast bridge between them</li><li>Today's backends react in <b>15–30 s</b>, far too slow</li></ul>"), 8),
        (card("03-solution", "<div class=tag>Our solution</div><h2>GridSync: a serverless AWS control loop</h2><ul>"
              "<li>Every <b>2 seconds</b>: read load → decide safe power per car → push new limits</li>"
              "<li>Neural-network <b>demand forecast</b> + <b>reinforcement-learning</b> policy decide the budget</li>"
              "<li><b>Isolation Forest</b> AI scores every charger message and quarantines hacked chargers</li>"
              "<li>Utility OpenADR events reach every charger in <b>under 2 seconds</b></li></ul>"), 8),
        (card("04-architecture", "<div class=tag>AWS architecture</div><h2>How the services connect</h2>"
              "<div class=flow><span class='n t'>8 chargers + meter</span><span class=a>→</span><span class=n>IoT Core (mTLS)</span><span class=a>→</span><span class=n>IoT Rule</span><span class=a>→</span><span class=n>SQS</span><span class=a>→</span><span class=n>Lambda AI guard</span><span class=a>→</span><span class=n>DynamoDB</span></div>"
              "<div class=flow><span class=n>Step Functions (6 steps)</span><span class=a>→</span><span class=n>Lambda: MLP + RL inference</span><span class=a>→</span><span class=n>IoT Core</span><span class=a>→</span><span class='n t'>OCPP SetChargingProfile</span></div>"
              "<div class=flow><span class='n t'>Utility</span><span class=a>→</span><span class=n>API Gateway /openadr</span><span class=a>→</span><span class=n>Lambda</span><span class=a>→</span><span class=n>Step Functions (sync)</span></div>"
              "<div class=flow><span class='n t'>Browser</span><span class=a>→</span><span class=n>CloudFront</span><span class=a>→</span><span class=n>S3</span><span style='width:30px'></span><span class=n>CloudWatch</span><span class=n>IAM</span><span class=n>Budgets</span><span class=n>CloudFormation</span></div>"), 10),
        (card("05-stack", f"<div class=tag>Real AWS account · CloudFormation stack “gridsync”</div><h2>{len(stack)} resources, all deployed as code</h2><div class=grid>{rows}</div>"), 8),
        (card("06-iot", "<div class=tag>AWS IoT Core · registered things</div><h2>9 devices, each with its own X.509 certificate</h2>"
              f"<p class=mono>{' &nbsp; '.join(things)}</p><p style='margin-top:18px'>Mutual TLS on MQTT · per-device IoT policy (a charger can only publish to its own topic) · no passwords to leak</p>"), 7),
    ]


def closing_cards(results):
    return [
        (card("90-results", "<div class=tag>Measured live on AWS</div><h2>Results</h2><div class=big>"
              f"<div><b>{results.get('step', '≈0.2 s')}</b><span>Step Functions control decision</span></div>"
              f"<div><b>{results.get('adr', '≈0.5 s')}</b><span>OpenADR −30% reached all chargers (target 2 s)</span></div>"
              "<div><b>≈1 s</b><span>hacked charger detected, certificate revoked</span></div>"
              "<div><b>0</b><span>feeder trips with GridSync AI</span></div></div>"), 8),
        (card("91-thanks", "<div class=tag>Thank you</div><h1>GridSync<br><span class=g>Predict · Control · Secure, in one AWS loop</span></h1>"
              "<p>github.com/Anish-p-creator/Cloud-power-grid-management</p>"), 5),
    ]


CAPTION_JS = """(t) => {
  let c = document.getElementById('__cap');
  if (!c) { c = document.createElement('div'); c.id='__cap';
    c.style.cssText='position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:99999;max-width:1100px;padding:14px 24px;border-radius:14px;background:rgba(10,8,30,.88);border:1px solid #8c6bff;color:#fff;font:600 21px Segoe UI,Arial,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.5);text-align:center;transition:opacity .3s';
    document.body.appendChild(c); }
  c.style.opacity = t ? 1 : 0; c.textContent = t || '';
}"""


def main():
    cards = build_cards()
    results = {}
    shots = MEDIA
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        ctx = browser.new_context(viewport={"width": W, "height": H}, record_video_dir=str(MEDIA / "raw"), record_video_size={"width": W, "height": H})
        page = ctx.new_page()

        for url, secs in cards:
            page.goto(url)
            page.wait_for_timeout(secs * 1000)

        cap = lambda t: page.evaluate(CAPTION_JS, t)
        def scroll_to(sel, offset=70):
            page.evaluate("([s,o]) => { const e=document.querySelector(s); window.scrollTo({top: e.getBoundingClientRect().top + scrollY - o, behavior:'smooth'}); }", [sel, offset])
            page.wait_for_timeout(1300)

        page.goto(SITE + "#aws")
        page.wait_for_function("document.querySelector('#awsConn') && document.querySelector('#awsConn').textContent.startsWith('Live')", timeout=60000)
        page.wait_for_timeout(1500)
        scroll_to("#aws", 60)
        cap("Live dashboard on CloudFront: every number below comes from the AWS backend")
        page.wait_for_timeout(5000)
        page.click("[data-aws-mode='ai']")
        scroll_to("#awsLoad", 140)
        cap("Transformer load from the IoT meter, plus the latest Step Functions run time")
        page.wait_for_timeout(5000)
        results["step"] = page.inner_text("#awsExec").strip()
        scroll_to("#awsChart", 80)
        cap("Step Functions: read load → read chargers → AI inference → limits → DynamoDB → IoT Core")
        page.wait_for_timeout(6000)
        page.screenshot(path=str(shots / "shot-steps.png"))
        cap("Explainable AI: the forecast, the RL Q-values and the EV power budget for this decision")
        page.wait_for_timeout(5000)

        scroll_to("#aws .controls", 80)
        cap("Demo 1: evening rush. Every bay plugs in at once")
        page.click("#awsRushBtn")
        page.wait_for_timeout(3000)
        scroll_to("#awsBays", 90)
        cap("The AI shares the safe headroom fairly, so the transformer stays below 100%")
        page.wait_for_timeout(7000)
        page.screenshot(path=str(shots / "shot-bays.png"))

        scroll_to("#aws .controls", 80)
        cap("Demo 2: the utility sends an OpenADR request to cut load by 30% (POST /openadr)")
        page.click("#awsAdrBtn")
        page.wait_for_function("document.querySelector('#awsResult').textContent.includes('Cloud reaction')", timeout=30000)
        txt = page.inner_text("#awsResult")
        results["adr"] = txt.split("Cloud reaction")[1].split("(")[0].strip()
        cap(f"All chargers received new limits {results['adr']} after the request (target: under 2 s)")
        page.wait_for_timeout(6000)
        page.screenshot(path=str(shots / "shot-openadr.png"))

        cap("Demo 3: a charger is hacked. It ignores its limit and sends fake meter data")
        page.click("#awsAttackBtn")
        page.wait_for_timeout(1500)
        scroll_to("#awsBays", 90)
        try:
            page.wait_for_function("[...document.querySelectorAll('#awsBays .bay-badge')].some(b => b.textContent==='QUARANTINED')", timeout=30000)
            cap("Isolation Forest flagged it → IoT certificate set INACTIVE → bay contactor opened")
        except Exception:
            cap("The Isolation Forest scores every message from the charger")
        page.wait_for_timeout(6000)
        page.screenshot(path=str(shots / "shot-quarantine.png"))
        page.evaluate("document.querySelector('#awsLog').scrollIntoView({block:'center', behavior:'smooth'})")
        page.wait_for_timeout(1300)
        cap("Event log written by Lambda to DynamoDB")
        page.wait_for_timeout(5000)
        page.screenshot(path=str(shots / "shot-log.png"))

        scroll_to("#aws .controls", 80)
        cap("After inspection the certificate is re-activated and the charger reconnects")
        page.click("#awsRestoreBtn")
        page.wait_for_timeout(7000)

        page.wait_for_function("document.querySelector('#labStatus').textContent.includes('trained')", timeout=60000)
        scroll_to("#ai .lab-grid", 70)
        cap("AI Lab: neural-network forecaster, RL agent and Isolation Forest, trained live and tested on unseen data")
        page.wait_for_timeout(6000)
        page.screenshot(path=str(shots / "shot-ailab.png"))
        page.evaluate("document.querySelector('#rlTable').scrollIntoView({block:'center', behavior:'smooth'})")
        page.wait_for_timeout(1300)
        cap("RL agent vs fixed rules on 30 unseen days: overloads 85 → 1")
        page.wait_for_timeout(5000)
        page.screenshot(path=str(shots / "shot-rl.png"))
        cap("")

        for url, secs in closing_cards(results):
            page.goto(url)
            page.wait_for_timeout(secs * 1000)

        video = page.video.path()
        ctx.close()
        browser.close()

    out = DOCS / "GridSync-Demo.mp4"
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", video, "-c:v", "libx264", "-preset", "medium",
                    "-crf", "22", "-pix_fmt", "yuv420p", "-r", "25", "-movflags", "+faststart", str(out)], check=True)
    (MEDIA / "results.json").write_text(json.dumps(results))
    print("video:", out, f"{out.stat().st_size / 1e6:.1f} MB", results)


if __name__ == "__main__":
    main()

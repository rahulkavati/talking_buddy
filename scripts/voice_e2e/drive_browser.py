"""Hold a spoken turn with the app in a real Chromium, using a WAV file as the microphone.

    python scripts/voice_e2e/drive_browser.py                                   # WebRTC link
    python scripts/voice_e2e/drive_browser.py --url "http://127.0.0.1:8000/?voice=websocket&q=.1"

It opens the Talk page, taps the mic, plays the clip into the page and reports whether
your words were transcribed, a reply was written, and Pixel's voice was heard. Exit code
0 means all three happened. Needs: pip install playwright && playwright install chromium
"""
import argparse
import asyncio
import sys
from pathlib import Path

from playwright.async_api import async_playwright

parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
parser.add_argument("--url", default="http://127.0.0.1:8011/?voice=pipecat&q=.1")
parser.add_argument("--clip", default=str(Path(__file__).with_name("question.wav")))
parser.add_argument("--seconds", type=int, default=34)
args = parser.parse_args()

BROWSER_ARGS = [
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    f"--use-file-for-fake-audio-capture={args.clip}", "--autoplay-policy=no-user-gesture-required",
    # software WebGL, so this also runs on machines without a GPU
    "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
]
# Remember peer connections so the script can read how much of Pixel's voice arrived.
INIT = """
window.__pcs = [];
const RealPC = window.RTCPeerConnection;
window.RTCPeerConnection = function (...a) { const pc = new RealPC(...a); window.__pcs.push(pc); return pc; };
window.RTCPeerConnection.prototype = RealPC.prototype;
"""
SNAPSHOT = """async () => {
  const out = { voiceIn: null };
  const pc = window.__pcs[window.__pcs.length - 1];
  if (pc) (await pc.getStats()).forEach(s => { if (s.type === 'inbound-rtp' && s.kind === 'audio') out.voiceIn = +(s.totalAudioEnergy || 0).toFixed(4); });
  out.link = pc ? 'webrtc' : 'classic';
  out.ui = document.getElementById('px')?.dataset.state;
  out.you = document.getElementById('transcript')?.textContent || '';
  out.pixel = document.getElementById('reply')?.textContent || '';
  out.delay = document.getElementById('latency')?.textContent;
  out.hint = document.getElementById('hint')?.textContent;
  return out;
}"""


async def main():
    if not Path(args.clip).exists():
        sys.exit(f"Missing {args.clip}. Run scripts/voice_e2e/make_clip.py first.")
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=BROWSER_ARGS)
        page = await browser.new_page(viewport={"width": 480, "height": 320})
        problems = []
        page.on("pageerror", lambda e: problems.append(str(e)[:200]))
        page.on("console", lambda m: problems.append(m.text[:200]) if m.type == "error" else None)
        await page.add_init_script(INIT)
        await page.goto(args.url)
        await page.wait_for_timeout(7000)
        await page.evaluate("document.getElementById('talk').click()")
        seen = {"you": "", "pixel": "", "spoke": False, "delay": None, "error": None, "link": None, "voiceIn": None}
        last = None
        for second in range(1, args.seconds + 1):
            await page.wait_for_timeout(1000)
            try:
                s = await asyncio.wait_for(page.evaluate(SNAPSHOT), 6)
            except Exception:
                continue  # the page is busy rendering; try again next second
            seen.update(link=s["link"], you=s["you"] or seen["you"], pixel=s["pixel"] or seen["pixel"],
                        spoke=seen["spoke"] or s["ui"] == "speaking", voiceIn=s["voiceIn"] or seen["voiceIn"])
            if s["delay"] and s["delay"] != "—":
                seen["delay"] = s["delay"]
            if s["ui"] == "error":
                seen["error"] = s["hint"]
            if s["ui"] != last:
                print(f"t+{second:>2}s  {s['ui']:<10} you={s['you'][:50]!r}  pixel={s['pixel'][:40]!r}", flush=True)
                last = s["ui"]
        await browser.close()

    checks = [("your words were transcribed", bool(seen["you"])), ("a reply was written", bool(seen["pixel"])),
              ("Pixel spoke", seen["spoke"] and (seen["link"] != "webrtc" or (seen["voiceIn"] or 0) > 0))]
    print(f"\nlink: {seen['link']}   reply delay shown: {seen['delay']}   voice energy received: {seen['voiceIn']}")
    for label, ok in checks:
        print(("PASS  " if ok else "FAIL  ") + label)
    if seen["error"]:
        print("the app reported:", seen["error"])
    if problems:
        print("browser errors:", problems[:5])
    sys.exit(0 if all(ok for _, ok in checks) else 1)


asyncio.run(main())

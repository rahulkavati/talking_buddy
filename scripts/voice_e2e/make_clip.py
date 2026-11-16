"""Make the fake-microphone clip for drive_browser.py using the project's Kokoro voice.

    python scripts/voice_e2e/make_clip.py            # writes scripts/voice_e2e/question.wav

Chromium's fake microphone wants 48 kHz mono 16-bit WAV. The clip starts with
silence so the page has time to open the microphone before the speech begins.
"""
import argparse
import wave
from pathlib import Path

import numpy as np
from kokoro_onnx import Kokoro

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
parser.add_argument("--text", default="Hello Pixel, please tell me a short joke about a scarecrow.")
parser.add_argument("--out", default=str(Path(__file__).with_name("question.wav")))
parser.add_argument("--voice", default="am_michael")
parser.add_argument("--lead", type=float, default=14.0, help="seconds of silence before the speech")
parser.add_argument("--tail", type=float, default=16.0, help="seconds of silence after the speech")
args = parser.parse_args()

kokoro = Kokoro(str(ROOT / "models/kokoro-v1.0.onnx"), str(ROOT / "models/voices-v1.0.bin"))
samples, rate = kokoro.create(args.text, voice=args.voice, speed=1.0, lang="en-us")
speech = np.interp(np.arange(0, len(samples), rate / 48000), np.arange(len(samples)), samples) * 0.8
audio = np.concatenate([np.zeros(int(args.lead * 48000)), speech, np.zeros(int(args.tail * 48000))])
with wave.open(args.out, "wb") as out:
    out.setnchannels(1)
    out.setsampwidth(2)
    out.setframerate(48000)
    out.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
print(f"{args.out}: {len(audio) / 48000:.1f} s, speech {len(samples) / rate:.1f} s starting at {args.lead:.0f} s")

"""Run the real app with stand-ins for Whisper and Ollama, for machines that have neither.

    python scripts/voice_e2e/stand_in_server.py      # serves on http://127.0.0.1:8011

Everything else is the project's real code: the FastAPI routes, both voice links,
SmallWebRTC, Silero VAD, Smart Turn, the Pipecat pipeline and Kokoro. On a machine
with the full stack you do not need this: point drive_browser.py at the normal server.
"""
import asyncio
import importlib.util
import json
import os
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)

import uvicorn  # noqa: E402
from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import StreamingResponse  # noqa: E402

TRANSCRIPT = os.environ.get("FAKE_TRANSCRIPT", "Hello Pixel, please tell me a short joke about a scarecrow.")
REPLY = os.environ.get("FAKE_REPLY", "Sure! Why did the scarecrow win an award? Because he was outstanding in his field.")

ollama = FastAPI()


@ollama.get("/api/tags")
def tags():
    return {"models": [{"name": "gemma3:4b"}]}


@ollama.post("/api/chat")
def chat():
    return {"message": {"role": "assistant", "content": "hello"}}


@ollama.post("/v1/chat/completions")
async def completions(request: Request):
    body = await request.json()
    print("STAND-IN LLM asked:", repr(body["messages"][-1].get("content"))[:120], flush=True)

    def chunk(delta, finish=None):
        return "data: " + json.dumps({"id": "x", "object": "chat.completion.chunk", "created": 0, "model": "stand-in",
                                      "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}) + "\n\n"

    async def stream():
        for word in REPLY.split(" "):
            yield chunk({"content": word + " "})
            await asyncio.sleep(0.03)
        yield chunk({}, "stop")
        yield "data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


threading.Thread(target=lambda: uvicorn.run(ollama, host="127.0.0.1", port=11434, log_level="warning"), daemon=True).start()

# WebRTC link: same Pipecat base class and frame contract as the real Whisper adapter.
spec = importlib.util.spec_from_file_location("talking_buddy_voice_services", ROOT / "server" / "services.py")
services = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = services
spec.loader.exec_module(services)

from pipecat.frames.frames import TranscriptionFrame  # noqa: E402
from pipecat.transcriptions.language import Language  # noqa: E402
from pipecat.utils.time import time_now_iso8601  # noqa: E402


class StandInSTT(services.LocalMLXWhisperSTTService):
    async def run_stt(self, audio):
        seconds = len(audio) / 2 / 16000
        print(f"STAND-IN STT (WebRTC) heard {seconds:.2f} s", flush=True)
        if seconds > 0.4:
            yield TranscriptionFrame(TRANSCRIPT, "local", time_now_iso8601(), Language.EN)


services.build_stt = lambda cfg: StandInSTT(cfg)

import server  # noqa: E402  (the project's real app)


def stand_in_transcribe(audio, sample_rate, cfg):
    seconds = len(audio) / sample_rate
    print(f"STAND-IN STT (Classic) heard {seconds:.2f} s", flush=True)
    return TRANSCRIPT if seconds > 0.4 else ""


server.transcribe = stand_in_transcribe
uvicorn.run(server.app, host="127.0.0.1", port=int(os.environ.get("PORT", "8011")), log_level="info")

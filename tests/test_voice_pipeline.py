"""Run recorded speech through the real Pipecat conversation pipeline.

No microphone, browser, Whisper, Ollama or Kokoro is needed. The parts that
decide whether a spoken turn works are real: Silero VAD, Smart Turn, the turn
aggregators, the Ollama LLM service (talking to a local stand-in HTTP server)
and the pipeline order from ``server/pipecat_bot.py``. Only speech-to-text and
the voice are stand-ins, with the same Pipecat base classes as the real ones.

These tests exist because two wiring mistakes once made the WebRTC link
connect and then stay silent: the transport dropped all microphone audio, and
the voice sat behind a processor that swallowed the reply text.
"""

import asyncio
import contextlib
import importlib.util
import json
import sys
import threading
import unittest
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "question_16k.wav"
TRANSCRIPT = "Please tell me a short joke about a scarecrow."
REPLY = "Sure! Why did the scarecrow win an award? Because he was outstanding in his field."
HAVE_PIPECAT = importlib.util.find_spec("pipecat") is not None


def _load(name, filename):
    loaded = sys.modules.get(name)
    if loaded is not None:
        return loaded
    spec = importlib.util.spec_from_file_location(name, ROOT / "server" / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class _FakeOllama:
    """Minimal OpenAI-compatible streaming endpoint that records what it was asked."""

    def __init__(self):
        self.requests = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                owner.requests.append(body)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for word in REPLY.split(" "):
                    chunk = {"id": "t", "object": "chat.completion.chunk", "created": 0, "model": "test",
                             "choices": [{"index": 0, "delta": {"content": word + " "}, "finish_reason": None}]}
                    self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                done = {"id": "t", "object": "chat.completion.chunk", "created": 0, "model": "test",
                        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
                self.wfile.write(f"data: {json.dumps(done)}\n\ndata: [DONE]\n\n".encode())

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@unittest.skipUnless(HAVE_PIPECAT, "Pipecat is not installed")
class TransportWiringTests(unittest.TestCase):
    def test_transport_forwards_microphone_audio_into_the_pipeline(self):
        services = _load("talking_buddy_voice_services", "services.py")
        with patch.object(services, "SmallWebRTCTransport") as transport:
            services.build_transport(object())
        params = transport.call_args.args[1]
        self.assertTrue(params.audio_in_enabled)
        self.assertTrue(
            params.audio_in_passthrough,
            "The VAD and STT are pipeline processors; without passthrough they never hear the microphone.",
        )


@unittest.skipUnless(HAVE_PIPECAT, "Pipecat is not installed")
class RecordedSpeechTurnTests(unittest.IsolatedAsyncioTestCase):
    async def test_one_spoken_question_produces_a_spoken_reply(self):
        from pipecat.frames.frames import (
            InputAudioRawFrame, LLMFullResponseEndFrame, StartFrame, TranscriptionFrame,
            TTSAudioRawFrame, TTSTextFrame,
        )
        from pipecat.pipeline.worker import PipelineParams, PipelineWorker
        from pipecat.processors.frame_processor import FrameProcessor
        from pipecat.services.settings import TTSSettings
        from pipecat.services.tts_service import TTSService
        from pipecat.transcriptions.language import Language
        from pipecat.utils.time import time_now_iso8601
        from pipecat.workers.runner import WorkerRunner

        services = _load("talking_buddy_voice_services", "services.py")
        processors = _load("talking_buddy_voice_processors", "processors.py")
        bot = _load("talking_buddy_pipecat_bot", "pipecat_bot.py")

        with wave.open(str(FIXTURE)) as clip:
            self.assertEqual((clip.getframerate(), clip.getnchannels(), clip.getsampwidth()), (16000, 1, 2))
            pcm = clip.readframes(clip.getnframes())

        class ClipMicrophone(FrameProcessor):
            """Plays the recording into the pipeline in real time, like a transport input."""

            async def process_frame(self, frame, direction):
                await super().process_frame(frame, direction)
                await self.push_frame(frame, direction)
                if isinstance(frame, StartFrame):
                    self._player = self.create_task(self._play())

            async def cleanup(self):
                await super().cleanup()
                await self.cancel_task(self._player)

            async def _play(self):
                step = 640  # 20 ms of 16 kHz mono 16-bit audio
                for start in range(0, len(pcm), step):
                    await self.push_frame(InputAudioRawFrame(audio=pcm[start:start + step], sample_rate=16000, num_channels=1))
                    await asyncio.sleep(0.02)

        class Speaker(FrameProcessor):
            """Stands where the transport output is and records what would be played."""

            def __init__(self):
                super().__init__()
                self.audio_bytes = 0
                self.spoken = []
                self.reply_finished = asyncio.Event()

            async def process_frame(self, frame, direction):
                await super().process_frame(frame, direction)
                if isinstance(frame, TTSAudioRawFrame):
                    self.audio_bytes += len(frame.audio)
                elif isinstance(frame, TTSTextFrame):
                    self.spoken.append(frame.text)
                elif isinstance(frame, LLMFullResponseEndFrame):
                    self.reply_finished.set()
                await self.push_frame(frame, direction)

        class StandInSTT(services.LocalMLXWhisperSTTService):
            segments = []

            async def run_stt(self, audio):
                self.segments.append(len(audio) / 2 / 16000)
                yield TranscriptionFrame(TRANSCRIPT, "local", time_now_iso8601(), Language.EN)

        class StandInVoice(TTSService):
            def __init__(self):
                super().__init__(push_start_frame=True, push_stop_frames=True, sample_rate=24000,
                                 settings=TTSSettings(model=None, voice="test", language=Language.EN))

            def can_generate_metrics(self):
                return False

            async def run_tts(self, text, context_id):
                yield TTSAudioRawFrame(audio=b"\x00\x01" * 2400, sample_rate=24000, num_channels=1, context_id=context_id)

        ollama = _FakeOllama()
        self.addCleanup(ollama.close)
        cfg = bot._load_config()
        cfg["brain"]["base_url"] = ollama.base_url
        cfg["web"]["enabled"] = False
        stt = StandInSTT(cfg)
        providers = services.VoiceServices(
            vad=services.build_vad(), turn=services.build_smart_turn(), stt=stt,
            llm=services.build_ollama(cfg), tts=StandInVoice(),
        )
        speaker = Speaker()
        pipeline, context = bot.build_pipeline(ClipMicrophone(), speaker, providers, cfg, processors)
        worker = PipelineWorker(pipeline, params=PipelineParams(audio_in_sample_rate=16000, audio_out_sample_rate=24000))
        runner = WorkerRunner(handle_sigint=False, handle_sigterm=False)
        await runner.add_workers(worker)
        running = asyncio.create_task(runner.run())
        try:
            # On a timeout fall through: the assertions below say which stage went quiet.
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(speaker.reply_finished.wait(), timeout=20)
            await asyncio.sleep(0.5)  # let the last sentence and the history update flow through
        finally:
            await worker.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.wait_for(running, timeout=10)

        self.assertTrue(stt.segments, "The voice detector never handed speech to speech-to-text.")
        self.assertGreater(max(stt.segments), 1.5, "Speech-to-text received only a fragment of the question.")
        self.assertTrue(ollama.requests, "The language model was never asked.")
        asked = ollama.requests[-1]["messages"][-1]["content"]
        self.assertIn(TRANSCRIPT, asked if isinstance(asked, str) else json.dumps(asked))
        self.assertGreater(speaker.audio_bytes, 0, "No voice audio reached the output.")
        self.assertIn("scarecrow", " ".join(speaker.spoken))
        remembered = [m for m in context.get_messages() if m.get("role") == "assistant"]
        self.assertTrue(remembered and "outstanding" in json.dumps(remembered[-1]), "The reply was not saved to the conversation.")


if __name__ == "__main__":
    unittest.main()

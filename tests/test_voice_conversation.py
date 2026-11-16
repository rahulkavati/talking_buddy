"""Regression checks for the voice conversation loop itself.

The transport tests in ``test_voice_transport.py`` cover wiring; these cover the
behaviour that decides whether a conversation feels right: sentence splitting
for speech, per-session memory, the opt-in web gate, and a cancellable turn.
"""

from pathlib import Path
import asyncio
import contextlib
import importlib.util
import io
import sys
import time
import types
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
import numpy as np

import server


ROOT = Path(__file__).resolve().parent.parent


def _load_module(name, path):
    loaded = sys.modules.get(name)
    if loaded is not None:
        return loaded
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class SentenceSplitTests(unittest.TestCase):
    def test_keeps_abbreviations_and_decimals_together(self):
        sentences, remainder = server.split_complete_sentences(
            "Dr. Smith is here. Your temperature is 3.5 degrees. How do you feel?"
        )
        self.assertEqual(
            sentences,
            ["Dr. Smith is here.", "Your temperature is 3.5 degrees."],
        )
        self.assertEqual(remainder, "How do you feel?")

    def test_returns_text_without_a_terminator_as_remainder(self):
        sentences, remainder = server.split_complete_sentences("One. Two thre")
        self.assertEqual(sentences, ["One."])
        self.assertEqual(remainder, "Two thre")


class HistoryTests(unittest.TestCase):
    def test_sessions_do_not_share_history(self):
        first, second = server.Conversation(), server.Conversation()
        first.append("user", "hello")
        self.assertEqual(len(first), 1)
        self.assertEqual(len(second), 0)

    def test_history_is_bounded(self):
        history = server.Conversation(max_messages=4)
        for index in range(10):
            history.append("user", str(index))
        self.assertEqual(len(history), 4)
        self.assertEqual(history.messages()[-1]["content"], "9")


class WebGateTests(unittest.TestCase):
    def setUp(self):
        self.tools = _load_module("test_voice_tools", ROOT / "server" / "tools.py")
        self.cfg = {"web": {"enabled": True, "triggers": ["search the web"], "max_results": 2}}

    def test_trigger_attaches_results(self):
        with patch.object(self.tools, "web_search", return_value="- Result: body"):
            prompt, used = self.tools.build_prompt(self.cfg, "search the web for otters")
        self.assertTrue(used)
        self.assertIn("Result: body", prompt)

    def test_no_trigger_stays_offline(self):
        with patch.object(self.tools, "web_search") as search:
            prompt, used = self.tools.build_prompt(self.cfg, "tell me a joke")
        self.assertFalse(used)
        self.assertEqual(prompt, "tell me a joke")
        search.assert_not_called()

    def test_pipecat_processor_rewrites_transcription_frame(self):
        from pipecat.frames.frames import TranscriptionFrame
        from pipecat.processors.frame_processor import FrameDirection

        processors = _load_module(
            "test_voice_processors", ROOT / "server" / "processors.py"
        )
        pushed = []

        async def collect():
            processor = processors.WebGateProcessor(self.cfg)
            processor.push_frame = lambda frame, direction=None: _record(pushed, frame)
            with patch.object(processor._tools, "web_search", return_value="- Result: body"):
                frame = TranscriptionFrame("search the web for otters", "local", "now", "en")
                await processor.process_frame(frame, FrameDirection.DOWNSTREAM)

        asyncio.run(collect())
        self.assertEqual(len(pushed), 1)
        self.assertIn("Result: body", pushed[0].text)


async def _record(bucket, frame):
    bucket.append(frame)


class StatusTests(unittest.TestCase):
    def test_status_reports_the_whole_voice_stack(self):
        ids = {item["id"] for item in server._system_status()["items"]}
        self.assertTrue({"pipecat", "webrtc", "silero", "smart_turn"} <= ids)
        self.assertTrue({"ollama", "brain", "whisper", "kokoro"} <= ids)


class TranscriptionGuardTests(unittest.TestCase):
    """A noisy room must not start a conversation on its own."""

    cfg = {"stt": {"whisper_repo": "fake-repo", "language": "en"}}

    def test_near_silence_never_reaches_whisper(self):
        fake = types.SimpleNamespace(
            transcribe=unittest.mock.Mock(return_value={"text": "Thank you."})
        )
        with patch.dict(sys.modules, {"mlx_whisper": fake}):
            text = server.transcribe(np.zeros(16000, dtype=np.float32), 16000, self.cfg)
        self.assertEqual(text, "")
        fake.transcribe.assert_not_called()

    def test_quiet_short_artifact_is_dropped(self):
        fake = types.SimpleNamespace(transcribe=lambda *a, **k: {"text": "Thank you."})
        audio = np.full(int(16000 * 0.5), 0.01, dtype=np.float32)
        with patch.dict(sys.modules, {"mlx_whisper": fake}):
            self.assertEqual(server.transcribe(audio, 16000, self.cfg), "")

    def test_loud_short_reply_is_kept(self):
        fake = types.SimpleNamespace(transcribe=lambda *a, **k: {"text": "Okay."})
        audio = np.full(int(16000 * 0.5), 0.1, dtype=np.float32)
        with patch.dict(sys.modules, {"mlx_whisper": fake}):
            self.assertEqual(server.transcribe(audio, 16000, self.cfg), "Okay.")

    def test_real_speech_text_is_kept(self):
        fake = types.SimpleNamespace(
            transcribe=lambda *a, **k: {"text": "Thank you for the update."}
        )
        audio = np.full(int(16000 * 1.5), 0.05, dtype=np.float32)
        with patch.dict(sys.modules, {"mlx_whisper": fake}):
            self.assertEqual(
                server.transcribe(audio, 16000, self.cfg), "Thank you for the update."
            )


class TtsLoggingTests(unittest.TestCase):
    def test_empty_audio_leaves_a_log_trace(self):
        cfg = {"tts": {"engine": "kokoro", "say_voice": "Samantha"}}
        output = io.StringIO()
        with patch.object(server, "load_cfg", return_value=cfg), \
                patch.object(server, "tts_kokoro", return_value=b""), \
                patch.object(server, "tts_say", return_value=b""), \
                contextlib.redirect_stdout(output):
            wav = server.speak("Hello there.")
        self.assertEqual(wav, b"")
        self.assertIn("TTS", output.getvalue())
        self.assertIn("no audio produced", output.getvalue())


class VoiceSocketTests(unittest.TestCase):
    def test_turn_streams_audio_and_cancel_closes_the_brain_stream(self):
        closed = []

        async def fake_stream(cfg, messages):
            try:
                yield "Dr. Smith "
                yield "is here. How "
                yield "are you today?"
            finally:
                closed.append("turn")

        async def slow_stream(cfg, messages):
            try:
                yield "Thinking about it"
                await asyncio.sleep(30)
            finally:
                closed.append("cancelled")

        def fake_speak(text):
            return b"RIFF" + text.encode()

        with patch.object(server, "stream_llm_async", fake_stream), \
                patch.object(server, "speak", fake_speak):
            with TestClient(server.app) as client:
                with client.websocket_connect("/ws/realtime") as ws:
                    ws.send_json({"type": "user_text", "text": "hello"})
                    types, audio = [], 0
                    while True:
                        message = ws.receive_json()
                        types.append(message["type"])
                        if message["type"] == "audio":
                            audio += 1
                        if message["type"] in ("done", "error"):
                            break
        self.assertEqual(types[-1], "done", types)
        self.assertIn("token", types)
        # "Dr. Smith is here." and "How are you today?" are separate clips.
        self.assertEqual(audio, 2)

        with patch.object(server, "stream_llm_async", slow_stream), \
                patch.object(server, "speak", fake_speak):
            with TestClient(server.app) as client:
                with client.websocket_connect("/ws/realtime") as ws:
                    ws.send_json({"type": "user_text", "text": "stop me"})
                    ws.receive_json()   # user_text
                    ws.receive_json()   # state: THINKING
                    ws.receive_json()   # token
                    ws.send_json({"type": "cancel"})
                    while ws.receive_json()["type"] != "cancelled":
                        pass

        deadline = time.time() + 3
        while "cancelled" not in closed and time.time() < deadline:
            time.sleep(0.05)
        self.assertIn("cancelled", closed, "cancelling a turn must close the LLM stream")


    def test_audio_discard_does_not_cancel_the_turn(self):
        async def slow_stream(cfg, messages):
            yield "One. "
            await asyncio.sleep(0.6)
            yield "Two."

        with patch.object(server, "stream_llm_async", slow_stream), \
                patch.object(server, "speak", lambda text: b"RIFF" + text.encode()):
            with TestClient(server.app) as client:
                with client.websocket_connect("/ws/realtime") as ws:
                    ws.send_json({"type": "user_text", "text": "hello"})
                    ws.receive_json()   # user_text
                    ws.receive_json()   # state: THINKING
                    ws.receive_json()   # token
                    ws.send_json({"type": "audio_start", "sample_rate": 16000})
                    ws.send_json({"type": "audio_discard"})   # blip, not speech
                    types = []
                    while True:
                        message = ws.receive_json()
                        types.append(message["type"])
                        if message["type"] in ("done", "cancelled", "error"):
                            break
        self.assertNotIn("cancelled", types)
        self.assertEqual(types[-1], "done", types)


if __name__ == "__main__":
    unittest.main()

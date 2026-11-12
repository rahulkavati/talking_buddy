"""Regression checks for the Pipecat/WebRTC migration boundary."""

from pathlib import Path
import asyncio
import importlib.util
import sys
import types
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
import yaml

import server


ROOT = Path(__file__).resolve().parent.parent


class VoiceTransportTests(unittest.TestCase):
    def test_pinned_provider_adapters_construct(self):
        path = ROOT / "server" / "services.py"
        spec = importlib.util.spec_from_file_location("test_voice_services", path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        cfg = yaml.safe_load((ROOT / "config.yaml").read_text())
        services = module.build_services(cfg)
        self.assertEqual(type(services.vad).__name__, "SileroVADAnalyzer")
        self.assertEqual(type(services.turn).__name__, "LocalSmartTurnAnalyzerV3")
        self.assertEqual(type(services.stt).__name__, "LocalMLXWhisperSTTService")
        self.assertEqual(type(services.llm).__name__, "OLLamaLLMService")
        self.assertEqual(type(services.tts).__name__, "KokoroTTSService")

    def test_local_mlx_stt_adapter_emits_transcription_frame(self):
        path = ROOT / "server" / "services.py"
        spec = importlib.util.spec_from_file_location("test_voice_services_stt", path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        cfg = yaml.safe_load((ROOT / "config.yaml").read_text())
        fake_mlx = types.SimpleNamespace(
            transcribe=lambda audio, **kwargs: {"text": "hello pixel"}
        )

        async def collect():
            service = module.LocalMLXWhisperSTTService(cfg)
            return [frame async for frame in service.run_stt(b"\x00\x00" * 1600)]

        with patch.dict(sys.modules, {"mlx_whisper": fake_mlx}):
            frames = asyncio.run(collect())
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0].text, "hello pixel")

    def test_configured_primary_and_fallback(self):
        with TestClient(server.app) as client:
            response = client.get("/api/voice/status")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["transport"], "pipecat")
        self.assertEqual(response.json()["fallback"], "websocket")

    def test_index_exposes_pipecat_client(self):
        with TestClient(server.app) as client:
            html = client.get("/").text
        self.assertIn('window.PIXEL_VOICE_TRANSPORT="pipecat"', html)
        self.assertIn('/static/pipecat-webrtc.js', html)
        client = (ROOT / "static" / "pipecat-webrtc.js").read_text()
        self.assertIn("type: 'client-ready'", client)
        self.assertIn("version: '2.3.0'", client)

    def test_webrtc_routes_are_registered(self):
        paths = {route.path for route in server.app.routes}
        self.assertIn("/api/voice/webrtc/offer", paths)
        self.assertIn("/api/voice/webrtc/ice", paths)

    def test_desktop_scopes_microphone_permission(self):
        main = (ROOT / "desktop" / "main.js").read_text()
        self.assertIn("setPermissionRequestHandler", main)
        self.assertIn("audioCapture", main)
        self.assertIn("127\\.0\\.0\\.1:8000", main)


if __name__ == "__main__":
    unittest.main()

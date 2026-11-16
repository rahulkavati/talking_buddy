"""API contracts the UI screens depend on: pages, settings, system status, setup jobs, latency probe."""

from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

import server

ROOT = Path(__file__).resolve().parent.parent
PAGES = ("setup", "models", "engine", "latency", "look", "settings", "desktop")


class UiApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = patch.object(server, "SETTINGS_PATH", Path(self.tmp.name) / "settings.json")
        patcher.start()
        self.addCleanup(patcher.stop)
        server._jobs.clear()
        self.client = TestClient(server.app)

    def test_every_screen_is_served_and_uses_the_shared_kit(self):
        for page in PAGES:
            response = self.client.get(f"/{page}")
            self.assertEqual(response.status_code, 200, page)
            self.assertIn("/static/pixel-ui.css", response.text, page)
            self.assertIn("/static/pixel-ui.js", response.text, page)

    def test_every_asset_a_page_references_exists(self):
        import re
        for html in (ROOT / "static").glob("*.html"):
            for ref in re.findall(r'(?:src|href)="/static/([^"]+)"', html.read_text()):
                self.assertTrue((ROOT / "static" / ref).exists(), f"{html.name} -> {ref}")

    def test_talk_page_boots_with_settings_and_no_dead_scripts(self):
        html = self.client.get("/").text
        self.assertIn("window.PIXEL_SETTINGS=", html)
        self.assertIn('id="talk"', html)
        for gone in ("talk-header.js", "alien-theme.css", "VOICE COMM FREQUENCY"):
            self.assertNotIn(gone, html)

    def test_settings_round_trip_and_override_config(self):
        base = self.client.get("/api/settings").json()
        self.assertEqual(base["settings"]["patience"], 50)
        saved = self.client.post("/api/settings", json={"patience": 80, "theme": "neon", "speed": 1.2, "name": " Bolt "}).json()
        self.assertEqual((saved["settings"]["patience"], saved["settings"]["theme"]), (80, "neon"))
        cfg = server.load_cfg()
        self.assertEqual(cfg["tts"]["speed"], 1.2)
        self.assertEqual(cfg["character"]["name"], "Bolt")
        self.assertIn('"theme": "neon"', self.client.get("/").text)
        reset = self.client.delete("/api/settings").json()
        self.assertEqual(reset["settings"]["theme"], "golden")

    def test_settings_reject_bad_input(self):
        for patch_body in ({"speed": 9}, {"theme": "plaid"}, {"nope": 1}, {"patience": True}, {"model": "a b; rm"}):
            response = self.client.post("/api/settings", json=patch_body)
            self.assertEqual(response.status_code, 400, patch_body)
        self.assertEqual(self.client.get("/api/settings").json()["settings"]["speed"], server.load_cfg()["tts"]["speed"])

    def test_inline_settings_cannot_break_out_of_the_script_tag(self):
        self.client.post("/api/settings", json={"name": "</script><b>x"})
        self.assertNotIn("</script><b>x", self.client.get("/").text)

    def test_system_status_shape(self):
        data = self.client.get("/api/system/status").json()
        self.assertGreater(data["machine"]["disk_free_bytes"], 0)
        ids = {item["id"] for item in data["items"]}
        self.assertTrue({"whisper", "ollama", "brain", "kokoro", "pipecat", "moshi"} <= ids)
        for item in data["items"]:
            self.assertIn(item["group"], ("hearing", "thinking", "plumbing"))
            if item["ready"]:
                self.assertIsNone(item["action"])
        self.assertEqual(data["summary"]["required"], sum(item["required"] for item in data["items"]))

    def test_setup_runs_in_the_background_and_reports_failure(self):
        self.assertEqual(self.client.post("/api/system/setup", json={"action": "format-disk"}).status_code, 400)

        def boom(cfg, report):
            report(progress=.5, message="Halfway")
            raise RuntimeError("disk full")

        with patch.dict(server.SETUP_ACTIONS, {"kokoro": boom}):
            response = self.client.post("/api/system/setup", json={"action": "kokoro"})
            self.assertEqual(response.status_code, 202)
            for _ in range(50):
                job = self.client.get("/api/system/status").json()["jobs"]["kokoro"]
                if job["state"] == "error":
                    break
                time.sleep(.02)
        self.assertEqual((job["state"], job["error"]), ("error", "disk full"))

    def test_latency_probe_reports_an_unreachable_model(self):
        async def offline(cfg, messages):
            raise server.requests.exceptions.ConnectionError("down")
            yield  # pragma: no cover

        with patch.object(server, "stream_llm_async", offline):
            response = self.client.post("/api/latency/probe", json={"text": "hi"})
        self.assertEqual(response.status_code, 503)
        self.assertFalse(response.json()["ok"])

    def test_latency_probe_times_a_reply(self):
        async def fake_stream(cfg, messages):
            for piece in ("Hello there. ", "Second sentence."):
                yield piece

        with patch.object(server, "stream_llm_async", fake_stream), patch.object(server, "speak", lambda text: b"RIFF"):
            data = self.client.post("/api/latency/probe", json={"text": "hi"}).json()
        self.assertTrue(data["ok"])
        self.assertEqual(data["reply"], "Hello there. Second sentence.")
        timings = data["timings"]
        self.assertGreaterEqual(timings["first_audio_ms"], timings["first_sentence_ms"])
        self.assertTrue(data["audio"])


if __name__ == "__main__":
    unittest.main()

# Voice end-to-end check

Holds one spoken turn with the app in a real Chromium browser, with a recorded
clip as the microphone. It is how the WebRTC "connected but silent" bugs were
found, and it works with no one at the keyboard.

    pip install playwright && playwright install chromium
    python scripts/voice_e2e/make_clip.py                       # once: writes question.wav

**On your Mac, against the real stack** (Whisper, Ollama, Kokoro). Start the app
as usual, then:

    python scripts/voice_e2e/drive_browser.py --url "http://127.0.0.1:8000/?voice=pipecat&q=.1"
    python scripts/voice_e2e/drive_browser.py --url "http://127.0.0.1:8000/?voice=websocket&q=.1"

**Without Whisper or Ollama** (CI, Linux): run the stand-in server in one shell
and the driver in another.

    python scripts/voice_e2e/stand_in_server.py
    python scripts/voice_e2e/drive_browser.py

The driver prints PASS or FAIL for three things: your words were transcribed, a
reply was written, and Pixel's voice was heard. Its exit code is 0 only if all pass.
Reply delays measured this way include browser start-up noise; use the Latency
Lab for real numbers.

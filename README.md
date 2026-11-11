# Talking Buddy

A local, voice-driven companion with an animated avatar. Runs on your Mac.
Offline by default. The internet is used only when you say "search the web ..." (or another trigger phrase in config.yaml).

    mic -> live captions/VAD -> WebSocket -> streaming Ollama -> sentence Kokoro -> avatar page with lip-sync

## Setup (about 15 minutes, needs internet once for downloads)

1. Install Ollama from https://ollama.com
2. Pick and download a brain that fits your RAM:

       python3 pick_model.py --apply
       ollama pull <the model it prints>        # e.g. gemma3:12b for 18 GB

3. Python environment:

       python3 -m venv .venv && source .venv/bin/activate
       pip install -r requirements.txt

4. Run:

       python server.py

   Open http://localhost:8000, allow the microphone, hold the Talk button
   (or hold the Space bar), speak, release.
   The first voice request downloads the Whisper model (one time).

   Voice mode uses a realtime WebSocket for streamed tokens and sentence audio.
   The browser uses an AudioWorklet microphone meter for barge-in, so speaking
   while Pixel is talking cancels the current turn and starts a new one. The
   original HTTP + Whisper route remains available as a fallback.

## Changing the brain

Edit `brain.model` in config.yaml (or run `python3 pick_model.py --apply`), then `ollama pull` it.
No restart is needed. LM Studio or any OpenAI-compatible server works: change `brain.base_url`.

## Kokoro voice

    pip install kokoro-onnx soundfile

The required `kokoro-v1.0.onnx` and `voices-v1.0.bin` files are stored in `models/`.
The active voice is configured as `af_heart` in `config.yaml`. If Kokoro fails,
the app falls back to the macOS voice.

## Customising the character

Colors, hair, beard and eyes are plain SVG in `static/index.html` (look for the gradients at the top).
Name and personality live in config.yaml under `character`.

## Tips

- Use push-to-talk (hold) so the mic doesn't hear the bot's own voice.
- Replies are kept short for speed. Raise `max_tokens` if you want longer answers.
- Everything binds to 127.0.0.1 only; nothing is exposed to your network.

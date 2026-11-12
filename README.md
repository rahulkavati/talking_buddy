# Talking Buddy

A local, voice-driven companion with an animated avatar. Runs on your Mac.
Offline by default. The internet is used only when you say "search the web ..." (or another trigger phrase in config.yaml).

    mic -> live captions/VAD -> WebSocket -> streaming Ollama -> sentence Kokoro -> avatar page with lip-sync

## Desktop app (Mac first, Windows-ready)

The project now includes an Electron desktop shell. It opens the existing local UI as a native app, starts the Python service automatically when needed, and keeps the same code path available for Windows.

    npm install
    npm run desktop

Use the gear button in the app to inspect local dependency status. The setup actions can prepare the configured Ollama brain, download the Whisper model, and install Kokoro dependencies. The first setup may take a few minutes and requires internet access.

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

## v2: new scene

- `python3 fetch_vendor.py` once (internet) to make the 3D libraries local.
- Click the character, use the emote buttons, or press keys 1-7 for gestures.
- Say hi / thanks / haha / wow and the character reacts. Cursor movement makes it look at you.
- `/?local` forces offline Whisper speech input.

## Desktop architecture and technology stack

The desktop version is being developed on branch `codex/desktop-v1`. The application is local-first and split into a desktop shell, a browser-based avatar UI, and a Python voice service.

### Production target (currently active on `codex/desktop-v1`)

| Layer | Technology | Responsibility |
|---|---|---|
| Desktop shell | Electron during migration; Tauri for production | Native window, lifecycle, permissions, sidecar startup, settings UI |
| Audio transport | WebRTC | Duplex microphone/speaker tracks, echo cancellation, jitter handling, reconnects |
| Orchestrator | Pipecat | Streaming frames, turn state, cancellation, interruption, provider composition |
| Voice activity | Silero VAD + Smart Turn | Fast speech detection and semantic end-of-turn decisions |
| Speech to text | Whisper MLX initially; Moonshine as an alternative | Streaming user transcription |
| Talker LLM | Gemma or Qwen through Ollama | Fast conversational responses |
| Thinker LLM | Larger Gemma/Qwen through Ollama | Optional hard reasoning via a tool call |
| Text to speech | Kokoro ONNX | Streaming local speech output |
| Avatar | Three.js + VRM/scene modules | Rendering, lip-sync, gestures, and visual state |
| Observability | Per-stage timing events + golden conversations | Latency budgets, regressions, and failure diagnosis |
| Packaging | PyInstaller sidecar + signed Tauri installers | Mac `.dmg` and Windows `.msi`/`.exe` releases |

### Full-duplex flow

```text
microphone -> WebRTC -> Silero VAD -> Smart Turn -> streaming STT
           -> talker LLM -> sentence audio -> WebRTC -> speaker/avatar
                              └-> thinker tool or explicit web-search tool
```

The microphone remains open while Pixel speaks. A genuine barge-in cancels pending LLM/TTS work, flushes queued audio, and preserves only the assistant text that was actually heard. The client handles playback and avatar lip-sync; the server owns orchestration, model calls, cancellation, and metrics.

The current desktop build uses Pipecat/WebRTC as the configured primary transport. The original PCM WebSocket pipeline remains available as an automatic fallback while the browser microphone/audio round-trip is being exercised.

### Provider and security rules

- Providers are behind narrow interfaces so Whisper, Moonshine, Gemma, Qwen, Kokoro, or a future speech-to-speech model can be swapped without rewriting the pipeline.
- Ollama and model weights are local managed dependencies; they are not bundled into the desktop installer.
- Web access is opt-in through configured trigger phrases and a dedicated `WebGate` tool.
- Bind local services to `127.0.0.1`, do not log raw audio, pin versions, and report health before opening a conversation.
- The supplied `local-voice-assistant` archive is the Pipecat architecture reference. Its constructors and callback names must be validated against the pinned installed Pipecat version before they become production code.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the migration phases and target repository layout.

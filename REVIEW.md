# Review notes (v2)

## Fixed in this version
1. Web-on-request was missing from the realtime (WebSocket) path. Now shared via build_prompt().
2. max_tokens 48 cut replies mid-sentence -> 120.
3. Any non-connection error left the UI stuck on THINKING -> now reported; generator closed on cancel.
4. Empty TTS audio no longer sent; Kokoro init guarded by a lock and preloaded at startup.
5. Other websites could talk to ws://localhost:8000 -> Origin check (HTTP + WebSocket).
6. VRM was loaded 3 times into 3 renderers -> one renderer, one scene, one VRM, with bloom.
7. HTML was patched by string-replace in the route -> scripts/CSS now live in index.html.
8. three.js came from a CDN at runtime -> run `python3 fetch_vendor.py` once for true offline.

## Still open (recommended next)
- Chrome's SpeechRecognition sends audio to Google. It now falls back to local Whisper on a network
  error, and `http://localhost:8000/?local` forces Whisper. Proper fix: stream mic PCM to the server with VAD.
- `think` and `keep_alive` are sent to Ollama's OpenAI-compatible endpoint, which may ignore them.
  Use the OLLAMA_KEEP_ALIVE env var, or switch to /api/chat.
- Sentence splitting on "." breaks on "Dr." and "3.5".
- Poses were written without a live preview. Tune the numbers in the G table in pixel-life.js.

# UI review: what was wrong and what changed

## Problems found in the submitted UI

1. **Talk page froze on load.** `talk-header.js` rewrote the status text inside a `MutationObserver` watching that same node, which re-triggered itself forever.
2. **Talk page was the old layout.** It still had the "VOICE COMM FREQUENCY" label, the wave bars and the mic in the top corner, not the approved bottom dock, conversation card and reply-delay timer. It also carried a dead inline copy of the voice code.
3. **Wrong fonts.** Buttons and headings asked for `'DM Sans'` with no fallback and the font was never loaded, so they rendered in Times.
4. **Latency Lab was fake.** Every number, the "recent tests" and the A/B button were hard-coded.
5. **Conversation Engine did nothing.** No control was saved or sent anywhere; Moshi and Hybrid were selectable but not implemented.
6. **Setup and Models were partly hard-coded.** "Mac desktop · Apple Silicon" and "a few GB" were fixed text; Ollama showed "Installed" when it was not; Kokoro's Install button could never make it ready because the voice files were not downloaded; installs were one silent request of up to 30 minutes with no progress and no error shown.
7. **Dead navigation.** "Voice & Look" and "Settings" went nowhere, and the sidebar differed between pages.
8. **Eleven overlapping stylesheets** patched into pages by string replacement on the server.

## What changed

- New Talk page (approved design) with a real state machine, error states, and a measured reply delay.
- One UI kit (`pixel-ui.css`, `pixel-ui.js`) used by every screen; the old per-page and shell stylesheets are gone.
- Settings are persisted and validated on the server and actually change the conversation (see `docs/UI.md`).
- Installs are background jobs with progress and visible errors; Kokoro's voice files are downloaded; Ollama can be started.
- Latency Lab shows real recorded delays and a real timed test.
- Voice & Look (five themes, voice preview) and Settings (mic test, data reset) now exist.
- The desktop shell opens on Setup only when something required is missing.
- Tests: `tests/test_ui_api.py` (10) and `tests/ui/pixel-ui.test.js` (8).

## Not done / to verify on your Mac

- Voice was not exercised end to end here (no Ollama, Whisper, Kokoro or microphone in the build sandbox).
- Moshi and Hybrid remain unimplemented and are labelled as such.
- The Kokoro download URLs point at the `kokoro-onnx` GitHub release and were not fetched during this work.
- Three existing tests need Pipecat installed to run.

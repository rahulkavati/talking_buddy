# UI architecture

No build step: plain HTML, CSS and JavaScript served by `server.py` from `static/`.

## Files

| File | Role |
|---|---|
| `pixel-ui.css` | Design tokens and every shared component (shell, cards, buttons, status chips, forms, toast, drawer) |
| `pixel-ui.js` | `window.PixelUI`: navigation, API client, settings binding, install watcher, reply-delay history, pure helpers |
| `pixel-hud.css`, `talk.js` | Talk page chrome on top of the 3D scene |
| `pixel-life.js`, `scene/*.js` | The 3D scene, themes, and the HUD state machine (`#px[data-state]`) |
| `realtime.js`, `pipecat-webrtc.js`, `fast-chat.js` | Voice and chat transport (unchanged contracts) |
| `<page>.html` + `<page>.js` | One pair per screen; each script is a small IIFE that uses `PixelUI` |
| `desktop.html`, `desktop-shell.js` | Electron shell: sidebar plus an iframe; pages post `pixel:navigate` to it |

## Rules the screens follow

- **Nothing is faked.** Every enabled control reads from and writes to the server. Features that do not exist yet (Moshi, Hybrid, early thinking, backchannel) are shown disabled and labelled as planned.
- **One source of settings.** `GET/POST/DELETE /api/settings`. The server validates every key, stores only what the user changed in `settings.json`, and injects the effective values into the Talk page as `window.PIXEL_SETTINGS`.
- **Long work is a job.** `POST /api/system/setup` returns immediately; `GET /api/system/status` carries job progress and the UI polls only while a job is active. Installs run one at a time.
- **State drives style.** The Talk HUD is styled entirely from `data-state` (`idle`, `listening`, `thinking`, `speaking`, `error`) and `data-conv`.
- **Embedded or standalone.** A page hides its own sidebar when loaded with `?embedded=1`; `?inset=1` makes room for the macOS traffic lights.

## Conversation feel mapping (`realtime.js`)

| Setting | Effect |
|---|---|
| Turn patience 0-100 | Pause that ends your turn: `350 + 7 x value` ms (default 50 = 700 ms) |
| Interrupt sensitivity 0-100 | Talk-over time `320 - 2 x value` ms and level `0.09 - 0.0005 x value` (default 72) |
| Echo cancellation | `getUserMedia` constraint |
| Barge-in | Whether talking over Pixel stops playback |

These apply to the Classic (WebSocket) link. The WebRTC link uses Pipecat's own turn detection.

## Reply delay

`realtime.js` calls `window.pixelTurnEnd(time, kind)` when your turn ends (for speech, the moment you went quiet). `pixel-life.js` stops the clock when the first audio starts playing, shows it in the top bar and stores it in `localStorage` (`pixel.turns`, last 200). The Latency Lab reads that history. `POST /api/latency/probe` times one real model reply and its speech without touching the conversation.

"""Talking Buddy backend: mic -> Whisper -> local LLM -> TTS -> browser avatar.

Everything is local. The web is touched only when the user says a trigger phrase.
"""
import base64
import asyncio
import collections
import contextlib
import io
import importlib.util
import json
import os
import platform
import re
import subprocess
import shutil
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path
from urllib.parse import urlparse

import httpx
import numpy as np
import requests
import uvicorn
import yaml
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.websockets import WebSocketDisconnected

ROOT = Path(__file__).parent
app = FastAPI()
class Conversation:
    """Bounded message history for a single conversation.

    Keeping history per transport session stops one conversation's turns from
    leaking into another (or into the HTTP fallback) and stops a long-running
    server from growing its memory without limit.
    """

    def __init__(self, max_messages: int = 48):
        self._messages: collections.deque = collections.deque(maxlen=max_messages)

    def messages(self, limit: int | None = None) -> list[dict]:
        items = list(self._messages)
        return items[-limit:] if limit else items

    def append(self, role: str, content: str) -> None:
        self._messages.append({"role": role, "content": content})

    def clear(self) -> None:
        self._messages.clear()

    def __len__(self) -> int:
        return len(self._messages)


HISTORY = Conversation()   # HTTP fallback path; WebSocket sessions own one each
_kokoro = None
_kokoro_lock = threading.Lock()
_pipecat_sessions = set()


def load_cfg():
    """Re-read config on every request so you can swap the brain without restarting.

    ``config.yaml`` stays the hand-edited base. Choices made in the app are kept
    in ``settings.json`` and layered on top, so the UI never rewrites the YAML
    (and never loses its comments).
    """
    cfg = yaml.safe_load((ROOT / "config.yaml").read_text())
    stored = _read_settings()
    for key, (section, field) in _CFG_OVERRIDES.items():
        if stored.get(key) is not None:
            cfg.setdefault(section, {})[field] = stored[key]
    return cfg


# ----------------------------- app settings --------------------------
SETTINGS_PATH = ROOT / "settings.json"
THEMES = ("golden", "blossom", "autumn", "moonlit", "neon")
KOKORO_VOICES = (
    ("af_heart", "Heart · warm"), ("af_bella", "Bella · bright"), ("af_nicole", "Nicole · soft"),
    ("af_sarah", "Sarah · clear"), ("af_sky", "Sky · light"), ("am_adam", "Adam · deep"),
    ("am_michael", "Michael · calm"), ("bf_emma", "Emma · British"), ("bm_george", "George · British"),
)
# Settings that override a config.yaml value: key -> (section, field).
_CFG_OVERRIDES = {
    "model": ("brain", "model"), "voice": ("tts", "kokoro_voice"), "speed": ("tts", "speed"),
    "web": ("web", "enabled"), "name": ("character", "name"), "transport": ("voice", "transport"),
}
# Settings that only the browser uses, with their defaults.
_CLIENT_DEFAULTS = {
    "patience": 50, "interrupt": 72, "echo": True, "barge_in": True,
    "theme": "golden", "quality": "auto", "reduce_motion": False, "show_delay": True,
}


def _is_int_range(lo, hi):
    return lambda v: isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


_SETTING_RULES = {
    "patience": _is_int_range(0, 100), "interrupt": _is_int_range(0, 100),
    "echo": lambda v: isinstance(v, bool), "barge_in": lambda v: isinstance(v, bool),
    "reduce_motion": lambda v: isinstance(v, bool), "show_delay": lambda v: isinstance(v, bool),
    "web": lambda v: isinstance(v, bool),
    "theme": lambda v: v in THEMES, "quality": lambda v: v in ("auto", "high", "medium", "low"),
    "transport": lambda v: v in ("websocket", "pipecat"),
    "voice": lambda v: v in {voice for voice, _ in KOKORO_VOICES},
    "speed": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and 0.8 <= v <= 1.3,
    "model": lambda v: isinstance(v, str) and re.fullmatch(r"[\w.:/-]{1,80}", v) is not None,
    "name": lambda v: isinstance(v, str) and 1 <= len(v.strip()) <= 24,
}
_settings_lock = threading.Lock()


def _read_settings():
    """Stored choices, dropping anything that no longer validates."""
    try:
        data = json.loads(SETTINGS_PATH.read_text())
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items() if k in _SETTING_RULES and _SETTING_RULES[k](v)}


def _write_settings(data):
    tmp = SETTINGS_PATH.with_name(SETTINGS_PATH.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True))
    tmp.replace(SETTINGS_PATH)


def _effective_settings(cfg=None):
    """What the UI should show: stored choices over config.yaml over defaults."""
    cfg = cfg or load_cfg()
    out = {**_CLIENT_DEFAULTS, **{k: v for k, v in _read_settings().items() if k in _CLIENT_DEFAULTS}}
    out.update({
        "model": cfg["brain"]["model"], "voice": cfg["tts"].get("kokoro_voice", "af_heart"),
        "speed": float(cfg["tts"].get("speed", 1.0)), "web": bool(cfg["web"]["enabled"]),
        "name": cfg["character"]["name"], "transport": cfg.get("voice", {}).get("transport", "websocket"),
        "engine": "cascade",
    })
    return out


# ----------------------------- brain ---------------------------------
def llm_chat(cfg, messages):
    b = cfg["brain"]
    r = requests.post(
        b["base_url"].rstrip("/") + "/chat/completions",
        json={
            "model": b["model"],
            "messages": messages,
            "temperature": b.get("temperature", 0.8),
            "max_tokens": b.get("max_tokens", 300),
            # Qwen3 can spend many seconds generating a hidden reasoning trace.
            # Voice chat should answer directly unless thinking is explicitly enabled.
            "think": b.get("think", False),
            "keep_alive": b.get("keep_alive", "10m"),
            "stream": False,
        },
        headers={"Authorization": "Bearer " + str(b.get("api_key", "local"))},
        timeout=180,
    )
    r.raise_for_status()
    text = r.json()["choices"][0]["message"]["content"]
    # some models (e.g. Qwen3) print their reasoning in <think> tags; hide it
    return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()


def _delta_from_line(line):
    """Parse one OpenAI-compatible SSE line (or a bare JSON object)."""
    line = (line or "").strip()
    if not line:
        return None
    if line.startswith("data:"):
        line = line[5:].strip()
    if not line or line == "[DONE]":
        return None
    try:
        data = json.loads(line)
    except ValueError:
        return None
    if isinstance(data, dict) and data.get("error"):
        raise RuntimeError(str(data["error"]))
    delta = data.get("choices", [{}])[0].get("delta", {}).get("content")
    return delta or None


async def stream_llm_async(cfg, messages):
    """Yield text deltas and stop generating when the turn is cancelled.

    The old blocking ``requests`` stream kept a worker thread (and the Ollama
    generation behind it) alive after a barge-in until the model finished on its
    own. An async client closes the socket on cancellation, so Ollama drops the
    request too and the next turn is not queued behind stale generation.
    """
    b = cfg["brain"]
    url = b["base_url"].rstrip("/") + "/chat/completions"
    payload = {
        "model": b["model"],
        "messages": messages,
        "temperature": b.get("temperature", 0.8),
        "max_tokens": b.get("max_tokens", 300),
        "think": b.get("think", False),
        "stream": True,
    }
    headers = {"Authorization": "Bearer " + str(b.get("api_key", "local"))}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=10.0)) as client:
            async with client.stream("POST", url, json=payload, headers=headers) as response:
                if response.status_code >= 400:
                    body = (await response.aread()).decode("utf-8", "replace")
                    raise RuntimeError(
                        f"brain returned {response.status_code}: {body[:300]}"
                    )
                async for line in response.aiter_lines():
                    delta = _delta_from_line(line)
                    if delta:
                        yield delta
    except httpx.ConnectError as exc:
        # Keep the error the UI already knows how to explain.
        raise requests.exceptions.ConnectionError(str(exc)) from exc


# The web gate lives in server/tools.py so the Pipecat pipeline applies exactly
# the same trigger rules without importing this HTTP compatibility server.
def _load_tools():
    name = "talking_buddy_tools"
    loaded = sys.modules.get(name)
    if loaded is not None:
        return loaded
    path = ROOT / "server" / "tools.py"
    spec = importlib.util.spec_from_file_location(name, path)
    if not spec or not spec.loader:
        raise RuntimeError(f"Cannot load web tools from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


TOOLS = _load_tools()


def web_search(query, n):
    return TOOLS.web_search(query, n)


def wants_web(cfg, text):
    return TOOLS.wants_web(cfg, text)


def build_prompt(cfg, text):
    """Offline by default. Touches the web ONLY when a trigger phrase is spoken.
    Shared by the HTTP path, the realtime WebSocket path, and Pipecat."""
    return TOOLS.build_prompt(cfg, text)


def answer(text, history=None):
    history = HISTORY if history is None else history
    cfg = load_cfg()
    name = cfg["character"]["name"]
    system = cfg["character"]["system_prompt"].replace("{name}", name)
    prompt, used_web = build_prompt(cfg, text)

    turns = cfg["brain"].get("history_turns", 8) * 2
    messages = [{"role": "system", "content": system}] + history.messages(turns) + [
        {"role": "user", "content": prompt}]
    try:
        reply = llm_chat(cfg, messages)
    except requests.exceptions.ConnectionError:
        return "I can't reach my brain. Is Ollama running?", False
    except Exception as e:
        return f"Something went wrong with my brain: {e}", False

    history.append("user", text)        # keep history clean of web dumps
    history.append("assistant", reply)
    return reply, used_web


# ----------------------------- voice out -----------------------------
def tts_say(text, voice):
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "out.wav")
        cmd = ["say", "-o", out, "--file-format=WAVE", "--data-format=LEI16@22050"]
        if voice:
            cmd += ["-v", voice]
        rate = load_cfg().get("tts", {}).get("say_rate")
        if rate:
            cmd += ["-r", str(rate)]
        subprocess.run(cmd + ["-f", "-"], input=text.encode(), check=True)
        return Path(out).read_bytes()


def tts_kokoro(text, cfg):
    global _kokoro
    import soundfile as sf
    from kokoro_onnx import Kokoro
    t = cfg["tts"]
    # Kokoro's ONNX session is not safe for concurrent inference and sentences
    # are synthesized in parallel, so guard the load and the call together.
    with _kokoro_lock:
        if _kokoro is None:
            _kokoro = Kokoro(str(ROOT / "models/kokoro-v1.0.onnx"),
                             str(ROOT / "models/voices-v1.0.bin"))
        samples, sr = _kokoro.create(text, voice=t.get("kokoro_voice", "af_heart"),
                                     speed=t.get("speed", 1.0), lang="en-us")
    buf = io.BytesIO()
    sf.write(buf, samples, sr, format="WAV")
    return buf.getvalue()


def speak(text):
    cfg = load_cfg()
    clean = re.sub(r"[*_#`>]", "", text).strip()
    if not clean:
        print("TTS: nothing to synthesize (empty text)")
        return b""
    # Sentences are already synthesized separately upstream; this only guards a
    # single runaway sentence. Cut on a word boundary instead of mid-word.
    if len(clean) > 2000:
        clean = clean[:2000].rsplit(" ", 1)[0].rstrip(",;:") + "…"

    wav = b""
    try:
        if cfg["tts"].get("engine") == "kokoro":
            wav = tts_kokoro(clean, cfg)
            if not wav:
                print("TTS: Kokoro returned empty audio for", repr(clean[:60]))
    except Exception as e:
        print("Kokoro failed, falling back to say:", e)
    if not wav:
        try:
            wav = tts_say(clean, cfg["tts"].get("say_voice"))
        except Exception as e:
            print("TTS failed:", e)
    if not wav:
        # Without this a silent reply leaves no trace anywhere.
        print(f"TTS: no audio produced for {clean[:60]!r} (engine "
              f"{cfg['tts'].get('engine')!r}, {len(clean)} chars)")
    return wav


# ----------------------------- voice in ------------------------------
# Whisper invents words from noise. These are the classic no-speech artifacts,
# plus the short utterances it produces from a click or a breath.
_HALLUCINATION = re.compile(
    r"^(?:\[?\(?(?:music|applause|silence|blank_audio|inaudible|no speech)\)?\]?"
    r"|thanks? for watching[.!]?"
    r"|subtitles? (?:by|created by).*"
    r"|amara\.org.*"
    r"|www\..*)$",
    re.I,
)
_SHORT_HALLUCINATION = re.compile(r"^(?:thank you|thanks|bye|you|okay|ok)[.!]?$", re.I)
# A real "okay" is spoken at normal volume. Whisper only invents those words
# from audio that is quiet, so the filter needs both a short buffer and a low
# level; loud short replies must survive.
_SHORT_ARTIFACT_MAX_LEVEL = 0.02


def transcribe(audio, sr, cfg):
    """Transcribe one utterance, but refuse silence instead of inventing words.

    The voice loop treats any returned text as a real turn, so a noisy room could
    start a conversation on its own. Near-silent buffers never reach the model,
    and the usual silence artifacts are filtered before they reach the UI.
    """
    import mlx_whisper
    if sr != 16000:
        n = int(len(audio) * 16000 / sr)
        audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio)
    audio = audio.astype(np.float32)
    duration = len(audio) / 16000
    if duration < 0.3:
        return ""
    level = float(np.sqrt(np.mean(np.square(audio))))
    if level < 0.004:
        return ""                       # only the noise floor, nothing spoken
    kw = {"path_or_hf_repo": cfg["stt"]["whisper_repo"]}
    if cfg["stt"].get("language"):
        kw["language"] = cfg["stt"]["language"]
    text = mlx_whisper.transcribe(audio, **kw)["text"].strip()
    if _HALLUCINATION.match(text):
        return ""
    if duration < 0.9 and level < _SHORT_ARTIFACT_MAX_LEVEL and _SHORT_HALLUCINATION.match(text):
        return ""
    return text


_ABBREVIATIONS = {
    "dr", "mr", "mrs", "ms", "prof", "sr", "jr", "st", "vs", "etc", "no",
    "fig", "approx", "e.g", "i.e", "a.m", "p.m", "u.s", "u.k", "ph.d",
}
_SENTENCE_END = re.compile(r"[.!?…]+[\"')\]]*(?=\s)")


def split_complete_sentences(text):
    """Return finished sentences and the unfinished remainder of ``text``.

    Streaming synthesis used to split on any period, which cut "Dr. Smith" and
    "3.5" in half and produced audible false stops. A split is only accepted
    when the terminator is followed by whitespace and the preceding token is not
    a known abbreviation or a single initial.
    """
    sentences = []
    start = 0
    for match in _SENTENCE_END.finditer(text):
        preceding = re.search(r"([A-Za-z][A-Za-z.]*)\s*$", text[start:match.start()])
        token = (preceding.group(1) if preceding else "").rstrip(".")
        if token.lower() in _ABBREVIATIONS or len(token) == 1:
            continue
        sentences.append(text[start:match.end()].strip())
        start = match.end()
    remainder = text[start:].lstrip() if start else text[start:]
    return [sentence for sentence in sentences if sentence], remainder


# ----------------------------- routes --------------------------------
def _origin_ok(origin):
    """Block other websites from talking to your local server (cross-site requests)."""
    return not origin or urlparse(origin).hostname in ("localhost", "127.0.0.1")


@app.middleware("http")
async def local_only(request: Request, call_next):
    if not _origin_ok(request.headers.get("origin")):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    return await call_next(request)


@app.on_event("startup")
def warm_up():
    """Keep both local models warm so the first voice turn starts quickly."""
    def go():
        try:
            cfg = load_cfg()
            b = cfg["brain"]
            base = b["base_url"].rstrip("/")
            if base.endswith("/v1") and "11434" in base:
                requests.post(
                    base[:-3] + "/api/chat",
                    json={
                        "model": b["model"],
                        "messages": [{"role": "user", "content": "Reply with hello."}],
                        "stream": False,
                        "think": False,
                        "keep_alive": b.get("keep_alive", "30m"),
                        "options": {"num_predict": 2},
                    },
                    timeout=30,
                )
            if cfg["tts"].get("engine") == "kokoro":
                tts_kokoro("Hello.", cfg)
            # Load/download Whisper before the user starts talking so model
            # setup never appears as a mysterious pause after the first word.
            import mlx_whisper
            mlx_whisper.transcribe(
                np.zeros(16000, dtype=np.float32),
                path_or_hf_repo=cfg["stt"]["whisper_repo"],
                language=cfg["stt"].get("language", "en"),
            )
        except Exception as e:
            print("warm-up skipped:", e)
    threading.Thread(target=go, daemon=True).start()


def _pipecat_session_finished(task):
    """Drop a finished WebRTC session and surface crashes instead of hiding them."""
    _pipecat_sessions.discard(task)
    if task.cancelled():
        return
    error = task.exception()
    if error is not None:
        print("Pipecat session failed:", repr(error))
        traceback.print_exception(type(error), error, error.__traceback__)


@app.on_event("shutdown")
async def shutdown_voice_sessions():
    """Stop Pipecat workers and close peer connections with the local service."""
    tasks = list(_pipecat_sessions)
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    handler = getattr(app.state, "pipecat_webrtc_handler", None)
    if handler is not None:
        await handler.close()
    _pipecat_sessions.clear()


def _inline_json(value):
    """JSON that is safe inside a <script> element."""
    return json.dumps(value).replace("</", "<\\/")


@app.get("/")
def index():
    cfg = load_cfg()
    html = (ROOT / "static" / "index.html").read_text()
    boot = (f"<script>window.PIXEL_VOICE_TRANSPORT={_inline_json(cfg.get('voice', {}).get('transport', 'websocket'))};"
            f"window.PIXEL_SETTINGS={_inline_json(_effective_settings(cfg))};</script></head>")
    html = html.replace("</head>", boot, 1)
    # If you ran fetch_vendor.py, load three.js locally so the app works fully offline.
    if (ROOT / "static" / "vendor" / "three" / "build" / "three.module.js").exists():
        html = (html
                .replace("https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js", "/static/vendor/three/build/three.module.js")
                .replace("https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/", "/static/vendor/three/examples/jsm/"))
    return HTMLResponse(html)


def _static_page(name):
    def page():
        return HTMLResponse((ROOT / "static" / f"{name}.html").read_text())
    page.__name__ = f"{name}_page"
    return page


# Every screen is a plain static page; the shell and the pages decide for
# themselves whether they are embedded, so the server does no HTML rewriting.
for _page_name in ("setup", "models", "engine", "latency", "look", "settings", "desktop"):
    app.add_api_route(f"/{_page_name}", _static_page(_page_name), methods=["GET"], include_in_schema=False)


@app.get("/api/config")
def api_config():
    cfg = load_cfg()
    try:
        version = json.loads((ROOT / "package.json").read_text()).get("version", "")
    except (OSError, ValueError):
        version = ""
    return {"version": version, "name": cfg["character"]["name"], "model": cfg["brain"]["model"],
            "tts": cfg["tts"]["engine"], "web": cfg["web"]["enabled"],
            "voice_transport": cfg.get("voice", {}).get("transport", "websocket"),
            "voice_fallback": cfg.get("voice", {}).get("fallback_transport", "websocket")}


@app.get("/api/voice/preflight")
def api_voice_preflight():
    """Report whether the production voice dependencies are ready to start."""
    try:
        module_spec = importlib.util.spec_from_file_location("talking_buddy_preflight", ROOT / "server" / "preflight.py")
        module = importlib.util.module_from_spec(module_spec)
        sys.modules[module_spec.name] = module
        module_spec.loader.exec_module(module)
        return module.preflight_report()
    except Exception as exc:
        return JSONResponse({"ready": False, "checks": [], "error": str(exc)}, status_code=503)


@app.get("/api/voice/status")
def api_voice_status():
    """Return the configured voice path and current Pipecat session state."""
    cfg = load_cfg()
    return {
        "transport": cfg.get("voice", {}).get("transport", "websocket"),
        "fallback": cfg.get("voice", {}).get("fallback_transport", "websocket"),
        "active_sessions": len(_pipecat_sessions),
        "webrtc_handler_ready": getattr(app.state, "pipecat_webrtc_handler", None) is not None,
    }


@app.post("/api/voice/webrtc/offer")
async def api_voice_webrtc_offer(request: Request):
    """Start the parallel Pipecat SmallWebRTC voice path."""
    try:
        from pipecat.transports.smallwebrtc.request_handler import (
            SmallWebRTCRequest,
            SmallWebRTCRequestHandler,
        )

        payload = await request.json()
        handler = getattr(app.state, "pipecat_webrtc_handler", None)
        if handler is None:
            handler = SmallWebRTCRequestHandler()
            app.state.pipecat_webrtc_handler = handler

        async def on_connection(connection):
            module_spec = importlib.util.spec_from_file_location(
                "talking_buddy_pipecat_bot", ROOT / "server" / "pipecat_bot.py"
            )
            module = importlib.util.module_from_spec(module_spec)
            sys.modules[module_spec.name] = module
            module_spec.loader.exec_module(module)
            task = asyncio.create_task(module.run_session(connection))
            _pipecat_sessions.add(task)
            task.add_done_callback(_pipecat_session_finished)

        answer = await handler.handle_web_request(
            SmallWebRTCRequest.from_dict(payload), on_connection
        )
        return answer or JSONResponse({"error": "No WebRTC answer"}, status_code=502)
    except Exception as exc:
        return JSONResponse({"error": f"Pipecat WebRTC setup failed: {exc}"}, status_code=503)


@app.patch("/api/voice/webrtc/ice")
async def api_voice_webrtc_ice(request: Request):
    """Forward trickle ICE candidates for the parallel Pipecat path."""
    try:
        from pipecat.transports.smallwebrtc.request_handler import (
            IceCandidate,
            SmallWebRTCPatchRequest,
        )

        handler = getattr(app.state, "pipecat_webrtc_handler", None)
        if handler is None:
            return JSONResponse({"error": "No active WebRTC session"}, status_code=404)
        payload = await request.json()
        candidates = [IceCandidate(**candidate) for candidate in payload.get("candidates", [])]
        await handler.handle_patch_request(
            SmallWebRTCPatchRequest(pc_id=payload["pc_id"], candidates=candidates)
        )
        return {"ok": True}
    except Exception as exc:
        return JSONResponse({"error": f"ICE update failed: {exc}"}, status_code=503)


@app.post("/api/stt")
async def api_stt(request: Request):
    body = await request.body()
    sr = int(request.headers.get("x-sample-rate", "48000"))
    if len(body) < 4 * 1600:
        return {"text": ""}
    audio = np.frombuffer(body[: len(body) // 4 * 4], dtype=np.float32)
    text = await run_in_threadpool(transcribe, audio, sr, load_cfg())
    return {"text": text}


@app.post("/api/chat")
async def api_chat(request: Request):
    data = await request.json()
    text = (data.get("text") or "").strip()
    if not text:
        return {"reply": "", "audio": "", "used_web": False}
    reply, used_web = await run_in_threadpool(answer, text)
    return {"reply": reply, "audio": "", "used_web": used_web}


@app.post("/api/tts")
async def api_tts(request: Request):
    data = await request.json()
    text = (data.get("text") or "").strip()
    if not text:
        return {"audio": ""}
    wav = await run_in_threadpool(speak, text)
    return {"audio": base64.b64encode(wav).decode()}


@app.post("/api/reset")
def api_reset():
    HISTORY.clear()
    return {"ok": True}


_module_cache: dict[str, bool] = {}


def _module_available(name):
    if name not in _module_cache:
        try:
            _module_cache[name] = importlib.util.find_spec(name) is not None
        except (ImportError, ValueError):
            _module_cache[name] = False
    return _module_cache[name]


def _ollama_api_base(base_url):
    """Return the native Ollama API root for an Ollama endpoint, else None."""
    parsed = urlparse(base_url or "")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if port != 11434:
        return None
    host = parsed.hostname or "127.0.0.1"
    return f"{parsed.scheme or 'http'}://{host}:{port}"


def _ollama_state(cfg):
    """(binary found, API base or None, server answering, local model names)."""
    binary = shutil.which("ollama")
    api = _ollama_api_base(cfg["brain"].get("base_url", ""))
    if api:
        try:
            response = requests.get(api + "/api/tags", timeout=1.5)
            if response.ok:
                return binary, api, True, [m.get("name", "") for m in response.json().get("models", [])]
        except (requests.RequestException, ValueError):
            pass
    return binary, api, False, []


def _machine_info():
    try:
        memory = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (ValueError, OSError, AttributeError):
        memory = None
    system, arch = platform.system(), platform.machine()
    return {
        "os": "macOS" if system == "Darwin" else system,
        "os_version": platform.mac_ver()[0] or platform.release(),
        "chip": "Apple Silicon" if system == "Darwin" and arch == "arm64" else arch,
        "memory_bytes": memory,
        "disk_free_bytes": shutil.disk_usage(ROOT).free,
    }


def _model_size(name):
    """Rough download size for a quantised chat model, from its parameter count."""
    match = re.search(r"(\d+(?:\.\d+)?)b\b", name.lower())
    return int(float(match.group(1)) * 0.82e9) if match else None


def _whisper_size(repo):
    sizes = (("tiny", .08e9), ("base", .15e9), ("small", .5e9), ("medium", 1.5e9), ("turbo", 1.6e9), ("large", 3.1e9))
    return next((int(size) for key, size in sizes if key in repo.lower()), None)


KOKORO_FILES = {
    "kokoro-v1.0.onnx": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
    "voices-v1.0.bin": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
}


def _system_status():
    cfg = load_cfg()
    model = cfg["brain"]["model"]
    ollama_bin, ollama_api, ollama_online, models = _ollama_state(cfg)
    has_model = model in models or f"{model}:latest" in models
    whisper_ok = _module_available("mlx_whisper")
    kokoro_pkg = _module_available("kokoro_onnx")
    kokoro_files = all((ROOT / "models" / name).exists() for name in KOKORO_FILES)
    pipecat_ok = _module_available("pipecat")
    webrtc_ok = _module_available("pipecat.transports.smallwebrtc")
    silero_ok = _module_available("pipecat.audio.vad.silero")
    turn_ok = _module_available("pipecat.audio.turn.smart_turn")
    whisper_repo = cfg["stt"]["whisper_repo"]

    def item(id, name, kind, group, ready, detail, *, installed=None, required=False, action=None,
             hint=None, size=None, optional=False, url=None):
        return {"id": id, "name": name, "kind": kind, "group": group, "ready": bool(ready),
                "installed": bool(ready if installed is None else installed), "detail": detail,
                "required": required, "optional": optional, "action": None if ready else action,
                "hint": None if ready else hint, "size_bytes": size, "url": url}

    upgrade = "Part of the full-duplex upgrade"
    items = [
        item("whisper", f"Whisper ({whisper_repo.split('/')[-1]})", "Speech to text", "hearing", whisper_ok,
             "Ready" if whisper_ok else "Not installed", required=True, action="whisper", size=_whisper_size(whisper_repo)),
        item("silero", "Silero VAD", "Hears when you start and stop talking", "hearing", silero_ok,
             "Ready" if silero_ok else upgrade, action="voice_stack"),
        item("smart_turn", "Smart Turn v3", "Knows if you are done or just pausing", "hearing", turn_ok,
             "Ready" if turn_ok else upgrade, action="voice_stack"),
        item("ollama", "Ollama", "Runs the language model", "thinking", ollama_online,
             "Running" if ollama_online else ("Installed, not running" if ollama_bin else "Not installed"),
             installed=bool(ollama_bin), required=True, action="ollama" if ollama_bin else None,
             hint=None if ollama_bin else "Install Ollama from ollama.com, then press Re-check.",
             url=None if ollama_bin else "https://ollama.com/download"),
        item("brain", model, "Language model", "thinking", has_model,
             "Downloaded" if has_model else "Needs download", required=True,
             action="brain" if ollama_online else None,
             hint=None if ollama_online else "Start Ollama first.", size=_model_size(model)),
        item("kokoro", "Kokoro", "Natural voice", "thinking", kokoro_pkg and kokoro_files,
             "Ready" if kokoro_pkg and kokoro_files else ("Voice files missing" if kokoro_pkg else "Not installed"),
             installed=kokoro_pkg, required=True, action="kokoro", size=int(.36e9)),
        item("pipecat", "Pipecat", "Voice orchestrator", "plumbing", pipecat_ok and webrtc_ok,
             f"Ready · {len(_pipecat_sessions)} active session(s)" if pipecat_ok and webrtc_ok else upgrade,
             installed=pipecat_ok, action="voice_stack", size=int(.5e9)),
        item("webrtc", "WebRTC transport", "Echo-cancelled two-way audio", "plumbing", webrtc_ok,
             "Ready" if webrtc_ok else upgrade, action="voice_stack"),
        item("moshi", "Moshi (Kyutai)", "Speech-to-speech engine", "plumbing", False,
             "Not part of this build yet", optional=True, hint="Planned. Nothing to install today."),
    ]
    required = [entry for entry in items if entry["required"]]
    with _jobs_lock:
        jobs = {name: dict(job) for name, job in _jobs.items()}
    return {"machine": _machine_info(), "items": items, "jobs": jobs,
            "summary": {"required": len(required), "ready": sum(entry["ready"] for entry in required)}}


@app.get("/api/system/status")
def api_system_status():
    return _system_status()


# ----------------------------- setup jobs ----------------------------
# Installs run in the background, one at a time, and report progress so the UI
# never sits on a silent thirty-minute request.
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
_setup_serial = threading.Lock()


def _pip_install(packages, report):
    report(message="Installing Python packages…")
    proc = subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", *packages],
                          capture_output=True, text=True, timeout=1800)
    if proc.returncode:
        lines = (proc.stderr or proc.stdout).strip().splitlines()
        raise RuntimeError((lines[-1] if lines else "pip failed")[:240])
    importlib.invalidate_caches()
    _module_cache.clear()


def _download(url, dest, report):
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    with requests.get(url, stream=True, timeout=(10, 60)) as response:
        response.raise_for_status()
        total, done = int(response.headers.get("content-length") or 0), 0
        with open(part, "wb") as handle:
            for chunk in response.iter_content(1 << 20):
                handle.write(chunk)
                done += len(chunk)
                report(progress=done / total if total else None, message=f"Downloading {dest.name}…")
    part.replace(dest)


def _setup_ollama(cfg, report):
    if not shutil.which("ollama"):
        raise RuntimeError("Ollama is not installed. Get it from ollama.com, then press Re-check.")
    report(message="Starting Ollama…")
    subprocess.Popen(["ollama", "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)
    for _ in range(30):
        if _ollama_state(cfg)[2]:
            return
        time.sleep(.5)
    raise RuntimeError("Ollama did not start. Open the Ollama app, then press Re-check.")


def _setup_brain(cfg, report):
    _, api, online, _ = _ollama_state(cfg)
    if not api:
        raise RuntimeError("The language model endpoint is not Ollama, so Pixel can't download models for it.")
    if not online:
        raise RuntimeError("Ollama isn't running. Start it first.")
    model = cfg["brain"]["model"]
    report(message=f"Downloading {model}…")
    with requests.post(api + "/api/pull", json={"model": model, "stream": True}, stream=True,
                       timeout=(5, 300)) as response:
        if response.status_code >= 400:
            raise RuntimeError(f"Ollama refused the download ({response.status_code}).")
        for line in response.iter_lines():
            if not line:
                continue
            event = json.loads(line)
            if event.get("error"):
                raise RuntimeError(str(event["error"])[:240])
            total, done = event.get("total"), event.get("completed")
            report(progress=done / total if total and done is not None else None,
                   message=str(event.get("status") or "Downloading").capitalize())


def _setup_whisper(cfg, report):
    if not _module_available("mlx_whisper"):
        if not (sys.platform == "darwin" and platform.machine() == "arm64"):
            raise RuntimeError("MLX Whisper needs a Mac with Apple Silicon.")
        _pip_install(["mlx-whisper"], report)
    report(message="Downloading the speech model…")
    import mlx_whisper
    mlx_whisper.transcribe(np.zeros(16000, dtype=np.float32), path_or_hf_repo=cfg["stt"]["whisper_repo"],
                           language=cfg["stt"].get("language", "en"))


def _setup_kokoro(cfg, report):
    if not (_module_available("kokoro_onnx") and _module_available("soundfile")):
        _pip_install(["kokoro-onnx", "soundfile"], report)
    for name, url in KOKORO_FILES.items():
        if not (ROOT / "models" / name).exists():
            _download(url, ROOT / "models" / name, report)


def _setup_voice_stack(cfg, report):
    pinned = next((line.strip() for line in (ROOT / "requirements.txt").read_text().splitlines()
                   if line.strip().startswith("pipecat-ai")), "pipecat-ai[webrtc,local-smart-turn,silero]")
    _pip_install([pinned], report)


SETUP_ACTIONS = {"ollama": _setup_ollama, "brain": _setup_brain, "whisper": _setup_whisper,
                 "kokoro": _setup_kokoro, "voice_stack": _setup_voice_stack}


def _start_job(action):
    with _jobs_lock:
        job = _jobs.get(action)
        if job and job["state"] in ("queued", "running"):
            return dict(job)
        job = _jobs[action] = {"action": action, "state": "queued", "progress": None,
                               "message": "Waiting for the previous install…", "error": None,
                               "started": time.time()}

    def update(**fields):
        with _jobs_lock:
            _jobs[action].update(fields)

    def report(progress=None, message=None):
        update(progress=progress, **({"message": message} if message else {}))

    def run():
        with _setup_serial:
            update(state="running", message="Starting…")
            try:
                SETUP_ACTIONS[action](load_cfg(), report)
                update(state="done", progress=1.0, message="Done")
            except Exception as exc:  # surfaced to the UI, never swallowed
                update(state="error", progress=None, message="Failed", error=str(exc)[:300] or type(exc).__name__)
            finally:
                importlib.invalidate_caches()
                _module_cache.clear()

    threading.Thread(target=run, daemon=True, name=f"setup-{action}").start()
    return dict(job)


@app.post("/api/system/setup")
async def api_system_setup(request: Request):
    action = (await request.json()).get("action")
    if action not in SETUP_ACTIONS:
        return JSONResponse({"ok": False, "error": "Unknown setup action"}, status_code=400)
    return JSONResponse({"ok": True, "job": _start_job(action)}, status_code=202)


# ----------------------------- settings API --------------------------
def _settings_payload():
    cfg = load_cfg()
    _, _, online, models = _ollama_state(cfg)
    return {
        "ok": True,
        "settings": _effective_settings(cfg),
        "options": {
            "models": sorted(set(models) | {cfg["brain"]["model"]}),
            "models_live": online,
            "voices": [{"id": voice, "label": label} for voice, label in KOKORO_VOICES],
            "themes": list(THEMES),
            "stt": cfg["stt"]["whisper_repo"].split("/")[-1],
            "tts_engine": cfg["tts"].get("engine", "kokoro"),
            "pipecat_ready": _module_available("pipecat") and _module_available("pipecat.transports.smallwebrtc"),
            "web_triggers": cfg["web"].get("triggers", [])[:3],
        },
    }


@app.get("/api/settings")
def api_settings():
    return _settings_payload()


@app.post("/api/settings")
async def api_settings_update(request: Request):
    patch = await request.json()
    if not isinstance(patch, dict):
        return JSONResponse({"ok": False, "error": "Expected an object of settings"}, status_code=400)
    with _settings_lock:
        stored = _read_settings()
        for key, value in patch.items():
            if key not in _SETTING_RULES:
                return JSONResponse({"ok": False, "error": f"Unknown setting '{key}'"}, status_code=400)
            if value is None:
                stored.pop(key, None)
                continue
            if isinstance(value, str):
                value = value.strip()
            if not _SETTING_RULES[key](value):
                return JSONResponse({"ok": False, "error": f"Invalid value for '{key}'"}, status_code=400)
            if key == "transport" and value == "pipecat" and not _module_available("pipecat"):
                return JSONResponse({"ok": False, "error": "Install the full-duplex upgrade first."}, status_code=400)
            stored[key] = value
        _write_settings(stored)
    return _settings_payload()


@app.delete("/api/settings")
def api_settings_reset():
    with _settings_lock:
        with contextlib.suppress(FileNotFoundError):
            SETTINGS_PATH.unlink()
    return _settings_payload()


# ----------------------------- latency probe -------------------------
@app.post("/api/latency/probe")
async def api_latency_probe(request: Request):
    """Time one real reply: first token, first full sentence, and its speech.

    This is the same model stream and the same voice the conversation uses, so
    the numbers are the "thinking + speaking" share of a real turn. It leaves
    the conversation history untouched and never uses the web.
    """
    text = str((await request.json()).get("text") or "Tell me a quick joke.").strip()[:300]
    cfg = load_cfg()
    system = cfg["character"]["system_prompt"].replace("{name}", cfg["character"]["name"])
    messages = [{"role": "system", "content": system}, {"role": "user", "content": text}]
    started = time.perf_counter()
    first_token = first_sentence = None
    reply = pending = sentence = ""
    iterator = stream_llm_async(cfg, messages)
    try:
        async for delta in iterator:
            first_token = first_token or time.perf_counter()
            reply += delta
            pending += delta
            if not sentence:
                complete, pending = split_complete_sentences(pending)
                if complete:
                    sentence, first_sentence = complete[0], time.perf_counter()
            if len(reply) > 600:
                break
    except requests.exceptions.ConnectionError:
        return JSONResponse({"ok": False, "error": "The language model isn't reachable. Is Ollama running?"}, status_code=503)
    except Exception as exc:
        return JSONResponse({"ok": False, "error": f"The language model failed: {exc}"[:300]}, status_code=502)
    finally:
        with contextlib.suppress(Exception):
            await iterator.aclose()
    finished = time.perf_counter()
    reply = re.sub(r"<think>.*?</think>", "", reply, flags=re.S).strip()
    if not sentence:
        sentence, first_sentence = reply, finished
    if not sentence or first_token is None:
        return JSONResponse({"ok": False, "error": "The model returned an empty reply."}, status_code=502)
    tts_started = time.perf_counter()
    wav = await synthesize_sentence(sentence)
    tts = time.perf_counter() - tts_started

    def ms(seconds):
        return round(seconds * 1000)

    return {"ok": True, "prompt": text, "reply": reply, "model": cfg["brain"]["model"],
            "audio": base64.b64encode(wav).decode() if wav else "",
            "timings": {"first_token_ms": ms(first_token - started),
                        "first_sentence_ms": ms(first_sentence - started),
                        "tts_ms": ms(tts), "first_audio_ms": ms(first_sentence - started + tts),
                        "reply_ms": ms(finished - started)}}


@app.websocket("/ws/realtime")
async def realtime_socket(websocket: WebSocket):
    """Full-duplex voice session with audio frames, partial STT, and cancellable turns."""
    if not _origin_ok(websocket.headers.get("origin")):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    history = Conversation()          # one conversation per socket
    current_turn = None
    turn_id = 0
    audio_buffer = bytearray()
    audio_sample_rate = 48000
    audio_active = False
    partial_task = None

    async def partial_transcript(snapshot, sample_rate):
        try:
            samples = np.frombuffer(snapshot, dtype=np.float32).copy()
            if len(samples) < sample_rate * 0.35:
                return
            text = await run_in_threadpool(transcribe, samples, sample_rate, load_cfg())
            if text:
                await websocket.send_json({"type": "partial_transcript", "text": text})
        except asyncio.CancelledError:
            raise
        except Exception:
            # Partial captions are best-effort; final transcription still runs.
            pass

    try:
        while True:
            packet = await websocket.receive()
            if packet.get("type") == "websocket.disconnect":
                raise WebSocketDisconnect()
            if packet.get("bytes") is not None:
                if audio_active:
                    audio_buffer.extend(packet["bytes"])
                    # Re-transcribe a rolling window while the user is speaking.
                    # Whisper remains local and the final pass below produces the
                    # authoritative utterance text.
                    if len(audio_buffer) >= audio_sample_rate * 4 * 1.2:
                        if partial_task is None or partial_task.done():
                            snapshot = bytes(audio_buffer[-audio_sample_rate * 4:])
                            partial_task = asyncio.create_task(
                                partial_transcript(snapshot, audio_sample_rate))
                continue
            event = __import__("json").loads(packet.get("text", "{}"))
            kind = event.get("type")
            if kind == "audio_start":
                audio_sample_rate = int(event.get("sample_rate") or 48000)
                audio_buffer.clear()
                audio_active = True
                continue
            if kind == "audio_end":
                audio_active = False
                if partial_task and not partial_task.done():
                    # Partial captions are disposable. Never make the final
                    # answer wait for a rolling Whisper pass to finish.
                    partial_task.cancel()
                    try:
                        await partial_task
                    except asyncio.CancelledError:
                        pass
                partial_task = None
                snapshot = bytes(audio_buffer)
                audio_buffer.clear()
                if len(snapshot) >= audio_sample_rate * 4 * 0.15:
                    samples = np.frombuffer(snapshot, dtype=np.float32).copy()
                    text = await run_in_threadpool(transcribe, samples, audio_sample_rate, load_cfg())
                    if text:
                        await websocket.send_json({"type": "transcript", "text": text})
                continue
            if kind == "audio_discard":
                # The client dropped a blip it decided was not speech. Forget the
                # captured audio without touching the turn in progress.
                audio_active = False
                audio_buffer.clear()
                if partial_task and not partial_task.done():
                    partial_task.cancel()
                    try:
                        await partial_task
                    except asyncio.CancelledError:
                        pass
                partial_task = None
                continue
            if kind == "cancel":
                if current_turn and not current_turn.done():
                    current_turn.cancel()
                current_turn = None
                await websocket.send_json({"type": "cancelled"})
                continue
            if kind != "user_text":
                continue
            turn_id += 1
            if current_turn and not current_turn.done():
                current_turn.cancel()
            text = (event.get("text") or "").strip()
            if text:
                current_turn = asyncio.create_task(
                    stream_turn(websocket, text, turn_id, history))
                current_turn.add_done_callback(_log_turn_failure)
    except (WebSocketDisconnect, WebSocketDisconnected):
        if current_turn and not current_turn.done():
            current_turn.cancel()


def _log_turn_failure(task):
    """A failed background turn must never disappear silently."""
    if task.cancelled():
        return
    error = task.exception()
    if error is not None:
        print("Voice turn failed:", repr(error))
        traceback.print_exception(type(error), error, error.__traceback__)


async def stream_turn(websocket, text, turn_id, history=None):
    history = HISTORY if history is None else history
    cfg = load_cfg()
    name = cfg["character"]["name"]
    system = cfg["character"]["system_prompt"].replace("{name}", name)
    turns = cfg["brain"].get("history_turns", 8) * 2
    await websocket.send_json({"type": "user_text", "text": text, "turn": turn_id})
    await websocket.send_json({"type": "state", "value": "THINKING", "turn": turn_id})
    prompt, used_web = await run_in_threadpool(build_prompt, cfg, text)
    if used_web:
        await websocket.send_json({"type": "web", "used": True, "turn": turn_id})
    messages = [{"role": "system", "content": system}] + history.messages(turns) + [
        {"role": "user", "content": prompt}]
    full_reply = ""
    pending = ""
    audio_tasks = []
    iterator = None
    try:
        iterator = stream_llm_async(cfg, messages)
        async for delta in iterator:
            full_reply += delta
            pending += delta
            await websocket.send_json({"type": "token", "text": delta, "turn": turn_id})
            sentences, pending = split_complete_sentences(pending)
            for sentence in sentences:
                if len(sentence) > 1:
                    audio_tasks.append(asyncio.create_task(synthesize_sentence(sentence)))
            if len(pending) > 220:
                # A long clause with no terminator still needs audio moving.
                cut = pending.rfind(" ", 0, 220)
                if cut > 60:
                    audio_tasks.append(asyncio.create_task(
                        synthesize_sentence(pending[:cut].strip())))
                    pending = pending[cut:]
            # Send any sentence whose audio is already ready while tokens continue.
            while audio_tasks and audio_tasks[0].done():
                await send_audio_result(websocket, await audio_tasks.pop(0), turn_id)
        if pending.strip():
            audio_tasks.append(asyncio.create_task(synthesize_sentence(pending.strip())))
        # Preserve sentence order, but synthesis itself happened in parallel.
        for task in audio_tasks:
            await send_audio_result(websocket, await task, turn_id)
        full_reply = re.sub(r"<think>.*?</think>", "", full_reply, flags=re.S).strip()
        history.append("user", text)
        history.append("assistant", full_reply)
        await websocket.send_json({"type": "done", "turn": turn_id})
    except asyncio.CancelledError:
        for task in audio_tasks:
            task.cancel()
        if iterator is not None:
            # Closing the generator closes the HTTP stream, which stops Ollama.
            with contextlib.suppress(Exception):
                await iterator.aclose()
        raise
    except (WebSocketDisconnect, WebSocketDisconnected):
        return
    except requests.exceptions.ConnectionError:
        await websocket.send_json({"type": "error", "message": "I can't reach Ollama. Is it running?"})
    except Exception as e:                  # never leave the UI hanging on THINKING
        await websocket.send_json({"type": "error", "message": f"Brain error: {e}"})
    finally:
        if iterator is not None:
            with contextlib.suppress(Exception):
                await iterator.aclose()


async def synthesize_sentence(sentence):
    return await run_in_threadpool(speak, sentence)


async def send_audio_result(websocket, wav, turn_id):
    if not wav:
        return
    await websocket.send_json({"type": "state", "value": "SPEAKING", "turn": turn_id})
    await websocket.send_json({"type": "audio", "audio": base64.b64encode(wav).decode(), "turn": turn_id})


app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=load_cfg().get("server", {}).get("port", 8000))

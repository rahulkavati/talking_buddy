"""Talking Buddy backend: mic -> Whisper -> local LLM -> TTS -> browser avatar.

Everything is local. The web is touched only when the user says a trigger phrase.
"""
import base64
import asyncio
import io
import os
import re
import subprocess
import shutil
import sys
import tempfile
import threading
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
import requests
import uvicorn
import yaml
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).parent
app = FastAPI()
HISTORY = []          # [{"role": "...", "content": "..."}]
_kokoro = None
_kokoro_lock = threading.Lock()


def load_cfg():
    """Re-read config on every request so you can swap the brain without restarting."""
    return yaml.safe_load((ROOT / "config.yaml").read_text())


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


def stream_llm(cfg, messages):
    """Yield OpenAI-compatible Ollama text deltas as they are generated."""
    b = cfg["brain"]
    r = requests.post(
        b["base_url"].rstrip("/") + "/chat/completions",
        json={"model": b["model"], "messages": messages,
              "temperature": b.get("temperature", 0.8),
              "max_tokens": b.get("max_tokens", 300),
              "think": b.get("think", False),
              "keep_alive": b.get("keep_alive", "30m"), "stream": True},
        headers={"Authorization": "Bearer " + str(b.get("api_key", "local"))},
        timeout=180, stream=True,
    )
    r.raise_for_status()
    # Ollama's streamed JSON is UTF-8; requests can otherwise guess Latin-1
    # for the event-stream response, corrupting punctuation such as curly quotes.
    r.encoding = "utf-8"
    for line in r.iter_lines(decode_unicode=True):
        if not line:
            continue
        if line.startswith("data:"):
            line = line[5:].strip()
        if line == "[DONE]":
            break
        try:
            data = __import__("json").loads(line)
            delta = data.get("choices", [{}])[0].get("delta", {}).get("content", "")
            if delta:
                yield delta
        except ValueError:
            continue


def web_search(query, n):
    try:
        from ddgs import DDGS
        res = DDGS().text(query, max_results=n)
        lines = [f"- {x.get('title', '')}: {x.get('body', '')}" for x in res]
        return "\n".join(lines) or None
    except Exception:
        return None


def wants_web(cfg, text):
    w = cfg.get("web", {})
    if not w.get("enabled"):
        return None
    low = text.lower()
    for t in w.get("triggers", []):
        if t in low:
            return t
    return None


def build_prompt(cfg, text):
    """Offline by default. Touches the web ONLY when a trigger phrase is spoken.
    Shared by the HTTP path and the realtime WebSocket path."""
    trig = wants_web(cfg, text)
    if not trig:
        return text, False
    query = re.sub(re.escape(trig), "", text, flags=re.I).strip(" ,.?!") or text
    results = web_search(query, cfg["web"].get("max_results", 5))
    if results:
        return (f"{text}\n\n[Web search results, use these and mention you looked it up]\n{results}", True)
    return (f"{text}\n\n[The user asked for a web search but the internet is "
            "unavailable. Say so briefly, then answer from memory if you can.]", False)


def answer(text):
    cfg = load_cfg()
    name = cfg["character"]["name"]
    system = cfg["character"]["system_prompt"].replace("{name}", name)
    prompt, used_web = build_prompt(cfg, text)

    turns = cfg["brain"].get("history_turns", 8) * 2
    messages = [{"role": "system", "content": system}] + HISTORY[-turns:] + [
        {"role": "user", "content": prompt}]
    try:
        reply = llm_chat(cfg, messages)
    except requests.exceptions.ConnectionError:
        return "I can't reach my brain. Is Ollama running?", False
    except Exception as e:
        return f"Something went wrong with my brain: {e}", False

    HISTORY.append({"role": "user", "content": text})        # keep history clean of web dumps
    HISTORY.append({"role": "assistant", "content": reply})
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
    with _kokoro_lock:                     # preload + parallel sentences must not double-load
        if _kokoro is None:
            _kokoro = Kokoro(str(ROOT / "models/kokoro-v1.0.onnx"),
                             str(ROOT / "models/voices-v1.0.bin"))
    t = cfg["tts"]
    samples, sr = _kokoro.create(text, voice=t.get("kokoro_voice", "af_heart"),
                                 speed=t.get("speed", 1.0), lang="en-us")
    buf = io.BytesIO()
    sf.write(buf, samples, sr, format="WAV")
    return buf.getvalue()


def speak(text):
    cfg = load_cfg()
    clean = re.sub(r"[*_#`>]", "", text)[:700]
    try:
        if cfg["tts"].get("engine") == "kokoro":
            return tts_kokoro(clean, cfg)
    except Exception as e:
        print("Kokoro failed, falling back to say:", e)
    try:
        return tts_say(clean, cfg["tts"].get("say_voice"))
    except Exception as e:
        print("TTS failed:", e)
        return b""


# ----------------------------- voice in ------------------------------
def transcribe(audio, sr, cfg):
    import mlx_whisper
    if sr != 16000:
        n = int(len(audio) * 16000 / sr)
        audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio)
    audio = audio.astype(np.float32)
    kw = {"path_or_hf_repo": cfg["stt"]["whisper_repo"]}
    if cfg["stt"].get("language"):
        kw["language"] = cfg["stt"]["language"]
    return mlx_whisper.transcribe(audio, **kw)["text"].strip()


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


@app.get("/")
def index(request: Request):
    html = (ROOT / "static" / "index.html").read_text()
    # If you ran fetch_vendor.py, load three.js locally so the app works fully offline.
    if (ROOT / "static" / "vendor" / "three" / "build" / "three.module.js").exists():
        html = (html
                .replace("https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js", "/static/vendor/three/build/three.module.js")
                .replace("https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/", "/static/vendor/three/examples/jsm/")
                .replace("https://cdn.jsdelivr.net/npm/@pixiv/three-vrm@3/lib/three-vrm.module.min.js", "/static/vendor/three-vrm/lib/three-vrm.module.min.js"))
    if request.query_params.get("embedded") == "1":
        html = html.replace("<body>", '<body class="embedded"><link rel="stylesheet" href="/static/embedded.css">')
    html = html.replace("</body>", '<script src="/static/desktop-drawer.js"></script></body>')
    return HTMLResponse(html)


@app.get("/setup")
def setup_page():
    return HTMLResponse((ROOT / "static" / "setup.html").read_text())


@app.get("/models")
def models_page(request: Request):
    html = (ROOT / "static" / "models.html").read_text()
    if request.query_params.get("embedded") == "1":
        html = html.replace('<body>', '<body class="embedded">').replace('</head>', '<link rel="stylesheet" href="/static/embedded.css"></head>')
    return HTMLResponse(html)

@app.get("/engine")
def engine_page(request: Request):
    html = (ROOT / "static" / "engine.html").read_text()
    if request.query_params.get("embedded") == "1":
        html = html.replace('<body>', '<body class="embedded">').replace('</head>', '<link rel="stylesheet" href="/static/embedded.css"></head>')
    return HTMLResponse(html)


@app.get("/latency")
def latency_page(request: Request):
    html = (ROOT / "static" / "latency.html").read_text()
    if request.query_params.get("embedded") == "1":
        html = html.replace('<body>', '<body class="embedded">').replace('</head>', '<link rel="stylesheet" href="/static/embedded.css"></head>')
    return HTMLResponse(html)


@app.get("/desktop")
def desktop_page():
    html = (ROOT / "static" / "desktop.html").read_text()
    return HTMLResponse(html.replace('</head>', '<link rel="stylesheet" href="/static/desktop-shell-motion.css"><link rel="stylesheet" href="/static/navigation-standard.css"></head>'))


@app.get("/api/config")
def api_config():
    cfg = load_cfg()
    return {"name": cfg["character"]["name"], "model": cfg["brain"]["model"],
            "tts": cfg["tts"]["engine"], "web": cfg["web"]["enabled"]}


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


def _system_status():
    cfg = load_cfg()
    model = cfg["brain"]["model"]
    ollama_bin = shutil.which("ollama")
    ollama_online = False
    models = []
    if ollama_bin:
        try:
            response = requests.get("http://127.0.0.1:11434/api/tags", timeout=1.5)
            if response.ok:
                ollama_online = True
                models = [item.get("name", "") for item in response.json().get("models", [])]
        except requests.RequestException:
            pass
    try:
        import mlx_whisper  # noqa: F401
        whisper_installed = True
    except ImportError:
        whisper_installed = False
    try:
        import kokoro_onnx  # noqa: F401
        kokoro_installed = True
    except ImportError:
        kokoro_installed = False
    return {
        "items": [
            {"id": "ollama", "name": "Ollama", "kind": "LLM runtime",
             "installed": bool(ollama_bin), "ready": ollama_online,
             "detail": "Running" if ollama_online else ("Installed, not running" if ollama_bin else "Not installed")},
            {"id": "brain", "name": model, "kind": "Conversation model",
             "installed": model in models, "ready": model in models,
             "detail": "Available locally" if model in models else "Needs download"},
            {"id": "whisper", "name": "Whisper Small", "kind": "Speech to text",
             "installed": whisper_installed, "ready": whisper_installed,
             "detail": "Python package ready" if whisper_installed else "Needs installation"},
            {"id": "kokoro", "name": "Kokoro ONNX", "kind": "Text to speech",
             "installed": kokoro_installed, "ready": kokoro_installed and (ROOT / "models/kokoro-v1.0.onnx").exists(),
             "detail": "Ready" if kokoro_installed and (ROOT / "models/kokoro-v1.0.onnx").exists() else "Needs setup"},
        ]
    }


@app.get("/api/system/status")
def api_system_status():
    return _system_status()


@app.post("/api/system/setup")
async def api_system_setup(request: Request):
    action = (await request.json()).get("action")
    cfg = load_cfg()

    def setup():
        if action == "brain":
            if not shutil.which("ollama"):
                raise RuntimeError("Ollama is not installed")
            subprocess.run(["ollama", "pull", cfg["brain"]["model"]], check=True, timeout=1800)
        elif action == "kokoro":
            subprocess.run([sys.executable, "-m", "pip", "install", "kokoro-onnx", "soundfile"],
                           check=True, timeout=1800)
        elif action == "whisper":
            import mlx_whisper
            mlx_whisper.transcribe(np.zeros(16000, dtype=np.float32),
                                   path_or_hf_repo=cfg["stt"]["whisper_repo"],
                                   language=cfg["stt"].get("language", "en"))
        else:
            raise ValueError("Unknown setup action")

    try:
        await run_in_threadpool(setup)
        return {"ok": True, **_system_status()}
    except Exception as exc:
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)


@app.websocket("/ws/realtime")
async def realtime_socket(websocket: WebSocket):
    """Full-duplex voice session with audio frames, partial STT, and cancellable turns."""
    if not _origin_ok(websocket.headers.get("origin")):
        await websocket.close(code=1008)
        return
    await websocket.accept()
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
                current_turn = asyncio.create_task(stream_turn(websocket, text, turn_id))
    except WebSocketDisconnect:
        if current_turn and not current_turn.done():
            current_turn.cancel()


async def stream_turn(websocket, text, turn_id):
    cfg = load_cfg()
    name = cfg["character"]["name"]
    system = cfg["character"]["system_prompt"].replace("{name}", name)
    turns = cfg["brain"].get("history_turns", 8) * 2
    await websocket.send_json({"type": "user_text", "text": text, "turn": turn_id})
    await websocket.send_json({"type": "state", "value": "THINKING", "turn": turn_id})
    prompt, used_web = await run_in_threadpool(build_prompt, cfg, text)
    if used_web:
        await websocket.send_json({"type": "web", "used": True, "turn": turn_id})
    messages = [{"role": "system", "content": system}] + HISTORY[-turns:] + [
        {"role": "user", "content": prompt}]
    full_reply = ""
    sentence = ""
    audio_tasks = []
    iterator = None
    try:
        iterator = stream_llm(cfg, messages)
        while True:
            delta = await run_in_threadpool(next_or_none, iterator)
            if delta is None:
                break
            full_reply += delta
            sentence += delta
            await websocket.send_json({"type": "token", "text": delta, "turn": turn_id})
            if sentence.rstrip().endswith((".", "!", "?", ":", ";")) and len(sentence.strip()) > 8:
                audio_tasks.append(asyncio.create_task(synthesize_sentence(sentence.strip())))
                sentence = ""
            # Send any sentence whose audio is already ready while tokens continue.
            while audio_tasks and audio_tasks[0].done():
                await send_audio_result(websocket, await audio_tasks.pop(0), turn_id)
        if sentence.strip():
            audio_tasks.append(asyncio.create_task(synthesize_sentence(sentence.strip())))
        # Preserve sentence order, but synthesis itself happened in parallel.
        for task in audio_tasks:
            await send_audio_result(websocket, await task, turn_id)
        full_reply = re.sub(r"<think>.*?</think>", "", full_reply, flags=re.S).strip()
        HISTORY.append({"role": "user", "content": text})
        HISTORY.append({"role": "assistant", "content": full_reply})
        await websocket.send_json({"type": "done", "turn": turn_id})
    except asyncio.CancelledError:
        for task in audio_tasks:
            task.cancel()
        raise
    except WebSocketDisconnect:
        return
    except requests.exceptions.ConnectionError:
        await websocket.send_json({"type": "error", "message": "I can't reach Ollama. Is it running?"})
    except Exception as e:                  # never leave the UI hanging on THINKING
        await websocket.send_json({"type": "error", "message": f"Brain error: {e}"})
    finally:
        if iterator is not None:
            try:
                iterator.close()
            except Exception:
                pass


async def synthesize_sentence(sentence):
    return await run_in_threadpool(speak, sentence)


async def send_audio_result(websocket, wav, turn_id):
    if not wav:
        return
    await websocket.send_json({"type": "state", "value": "SPEAKING", "turn": turn_id})
    await websocket.send_json({"type": "audio", "audio": base64.b64encode(wav).decode(), "turn": turn_id})


def next_or_none(iterator):
    try:
        return next(iterator)
    except StopIteration:
        return None


app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=load_cfg().get("server", {}).get("port", 8000))

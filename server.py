"""Talking Buddy backend: mic -> Whisper -> local LLM -> TTS -> browser avatar.

Everything is local. The web is touched only when the user says a trigger phrase.
"""
import base64
import asyncio
import io
import os
import re
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import requests
import uvicorn
import yaml
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).parent
app = FastAPI()
HISTORY = []          # [{"role": "...", "content": "..."}]
_kokoro = None


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


def answer(text):
    cfg = load_cfg()
    name = cfg["character"]["name"]
    system = cfg["character"]["system_prompt"].replace("{name}", name)
    used_web = False
    prompt = text

    trig = wants_web(cfg, text)
    if trig:
        query = re.sub(re.escape(trig), "", text, flags=re.I).strip(" ,.?!") or text
        results = web_search(query, cfg["web"].get("max_results", 5))
        if results:
            used_web = True
            prompt = f"{text}\n\n[Web search results, use these and mention you looked it up]\n{results}"
        else:
            prompt = (f"{text}\n\n[The user asked for a web search but the internet is "
                      "unavailable. Say so briefly, then answer from memory if you can.]")

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
@app.get("/")
def index():
    html = (ROOT / "static" / "index.html").read_text()
    html = html.replace("ARES // VRM", "ALIEN // VRM")
    html = html.replace("</head>", '<link rel="stylesheet" href="/static/alien-theme.css"></head>')
    html = html.replace("</body>", '<script type="module" src="/static/scene-enhancements.js"></script><script src="/static/fast-chat.js"></script><script src="/static/realtime.js"></script></body>')
    return HTMLResponse(html)


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


@app.websocket("/ws/realtime")
async def realtime_socket(websocket: WebSocket):
    """Duplex stream with cancellable LLM generation and queued sentence audio."""
    await websocket.accept()
    current_turn = None
    try:
        while True:
            event = await websocket.receive_json()
            kind = event.get("type")
            if kind == "cancel":
                if current_turn and not current_turn.done():
                    current_turn.cancel()
                current_turn = None
                await websocket.send_json({"type": "cancelled"})
                continue
            if kind != "user_text":
                continue
            if current_turn and not current_turn.done():
                current_turn.cancel()
            text = (event.get("text") or "").strip()
            if text:
                current_turn = asyncio.create_task(stream_turn(websocket, text))
    except WebSocketDisconnect:
        if current_turn and not current_turn.done():
            current_turn.cancel()


async def stream_turn(websocket, text):
    cfg = load_cfg()
    name = cfg["character"]["name"]
    system = cfg["character"]["system_prompt"].replace("{name}", name)
    turns = cfg["brain"].get("history_turns", 8) * 2
    messages = [{"role": "system", "content": system}] + HISTORY[-turns:] + [
        {"role": "user", "content": text}]
    await websocket.send_json({"type": "user_text", "text": text})
    await websocket.send_json({"type": "state", "value": "THINKING"})
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
            await websocket.send_json({"type": "token", "text": delta})
            if sentence.rstrip().endswith((".", "!", "?", ":", ";")) and len(sentence.strip()) > 8:
                audio_tasks.append(asyncio.create_task(synthesize_sentence(sentence.strip())))
                sentence = ""
            # Send any sentence whose audio is already ready while tokens continue.
            while audio_tasks and audio_tasks[0].done():
                await send_audio_result(websocket, await audio_tasks.pop(0))
        if sentence.strip():
            audio_tasks.append(asyncio.create_task(synthesize_sentence(sentence.strip())))
        # Preserve sentence order, but synthesis itself happened in parallel.
        for task in audio_tasks:
            await send_audio_result(websocket, await task)
        full_reply = re.sub(r"<think>.*?</think>", "", full_reply, flags=re.S).strip()
        HISTORY.append({"role": "user", "content": text})
        HISTORY.append({"role": "assistant", "content": full_reply})
        await websocket.send_json({"type": "done"})
    except asyncio.CancelledError:
        for task in audio_tasks:
            task.cancel()
        raise
    except requests.exceptions.ConnectionError:
        await websocket.send_json({"type": "error", "message": "I can't reach Ollama."})


async def synthesize_sentence(sentence):
    return await run_in_threadpool(speak, sentence)


async def send_audio_result(websocket, wav):
    await websocket.send_json({"type": "state", "value": "SPEAKING"})
    await websocket.send_json({"type": "audio", "audio": base64.b64encode(wav).decode()})


def next_or_none(iterator):
    try:
        return next(iterator)
    except StopIteration:
        return None


app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=load_cfg().get("server", {}).get("port", 8000))

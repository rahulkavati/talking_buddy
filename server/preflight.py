"""Dependency and model checks used before starting a Pipecat voice session."""

from __future__ import annotations

import importlib.util
import shutil
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import requests
import yaml


ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Check:
    id: str
    label: str
    ready: bool
    detail: str
    required: bool = True


def _config() -> dict[str, Any]:
    return yaml.safe_load((ROOT / "config.yaml").read_text())


def _module(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def run_preflight() -> list[Check]:
    cfg = _config()
    model = cfg["brain"]["model"]
    checks = [
        Check("pipecat", "Pipecat 1.15.0", _module("pipecat"), "Python package available"),
        Check("webrtc", "SmallWebRTC transport", _module("pipecat.transports.smallwebrtc"), "Transport import available"),
        Check("silero", "Silero VAD", _module("pipecat.audio.vad.silero"), "VAD integration available"),
        Check("smart_turn", "Smart Turn", _module("pipecat.audio.turn.smart_turn"), "Turn detector import available"),
        Check("whisper", "MLX Whisper", _module("mlx_whisper"), "Speech-to-text package available"),
        Check("kokoro", "Kokoro ONNX", _module("kokoro_onnx") and (ROOT / "models/kokoro-v1.0.onnx").exists(), "Voice model and package available"),
        Check("ollama", "Ollama", _ollama_model_ready(model), f"Model available: {model}"),
    ]
    return checks


def _ollama_model_ready(model: str) -> bool:
    if not shutil.which("ollama"):
        return False
    try:
        response = requests.get("http://127.0.0.1:11434/api/tags", timeout=1.5)
        return response.ok and model in {item.get("name") for item in response.json().get("models", [])}
    except requests.RequestException:
        return False


def preflight_report() -> dict[str, Any]:
    checks = run_preflight()
    return {
        "ready": all(check.ready for check in checks if check.required),
        "checks": [asdict(check) for check in checks],
    }

"""Project-owned constructors for the pinned Pipecat voice providers.

The compatibility WebSocket pipeline does not import this module. The Pipecat
runner will use these adapters so provider changes stay isolated from transport
and orchestration code.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import ErrorFrame, Frame, TranscriptionFrame
from pipecat.services.kokoro.tts import KokoroTTSService
from pipecat.services.ollama.llm import OLLamaLLMService
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.transcriptions.language import Language
from pipecat.utils.time import time_now_iso8601


ROOT = Path(__file__).resolve().parent.parent


@dataclass
class VoiceServices:
    """All provider instances used by one Pipecat conversation session."""

    vad: SileroVADAnalyzer
    turn: LocalSmartTurnAnalyzerV3
    stt: "LocalMLXWhisperSTTService"
    llm: OLLamaLLMService
    tts: KokoroTTSService


def build_vad(*, sample_rate: int = 16000) -> SileroVADAnalyzer:
    """Create the local Silero analyzer used for speech start/stop detection."""
    return SileroVADAnalyzer(sample_rate=sample_rate)


def build_smart_turn(*, cpu_count: int = 1) -> LocalSmartTurnAnalyzerV3:
    """Create the bundled offline Smart Turn v3.2 analyzer."""
    return LocalSmartTurnAnalyzerV3(cpu_count=cpu_count)


def build_ollama(cfg: dict[str, Any]) -> OLLamaLLMService:
    """Create the local Ollama talker using the project configuration."""
    brain = cfg["brain"]
    return OLLamaLLMService(
        base_url=brain["base_url"],
        api_key=brain.get("api_key", "local"),
        settings=OLLamaLLMService.Settings(
            model=brain["model"],
            temperature=brain.get("temperature", 0.7),
            max_tokens=brain.get("max_tokens", 72),
        ),
    )


class LocalMLXWhisperSTTService(SegmentedSTTService):
    """Pipecat segmented STT adapter for the project's local MLX Whisper model.

    Pipecat owns VAD segmentation, buffering, cancellation, and transcription
    frame delivery. The adapter only supplies the local Apple Silicon inference
    implementation, avoiding the optional Faster Whisper dependency.
    """

    def __init__(self, cfg: dict[str, Any]):
        super().__init__(
            sample_rate=16000,
            trailing_silence_secs=0.5,
            audio_passthrough=True,
        )
        self._cfg = cfg

    @property
    def wants_wav_segments(self) -> bool:
        return False

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame, None]:
        try:
            import mlx_whisper

            stt = self._cfg["stt"]
            samples = np.frombuffer(audio, dtype=np.int16).astype(np.float32) / 32768.0
            result = await asyncio.to_thread(
                mlx_whisper.transcribe,
                samples,
                path_or_hf_repo=stt["whisper_repo"],
                language=stt.get("language", "en"),
            )
            text = result.get("text", "").strip()
            if text:
                yield TranscriptionFrame(text, "local", time_now_iso8601(), Language.EN)
        except Exception as exc:
            yield ErrorFrame(error=f"Local MLX Whisper failed: {exc}")


def build_stt(cfg: dict[str, Any]) -> LocalMLXWhisperSTTService:
    return LocalMLXWhisperSTTService(cfg)


def build_kokoro(cfg: dict[str, Any]) -> KokoroTTSService:
    """Create Kokoro from the repository-managed model files.

    This intentionally uses Pipecat's service class with the existing pinned
    project model files; the optional Pipecat Kokoro extra is not required.
    """
    tts = cfg["tts"]
    return KokoroTTSService(
        model_path=str(ROOT / "models/kokoro-v1.0.onnx"),
        voices_path=str(ROOT / "models/voices-v1.0.bin"),
        settings=KokoroTTSService.Settings(
            voice=tts.get("kokoro_voice", "af_bella"),
            speed=tts.get("speed", 1.0),
        ),
    )


def build_services(cfg: dict[str, Any], *, sample_rate: int = 16000) -> VoiceServices:
    """Build one isolated provider set for a Pipecat session."""
    return VoiceServices(
        vad=build_vad(sample_rate=sample_rate),
        turn=build_smart_turn(),
        stt=build_stt(cfg),
        llm=build_ollama(cfg),
        tts=build_kokoro(cfg),
    )


def build_transport(connection: Any, *, sample_rate: int = 16000) -> SmallWebRTCTransport:
    """Create the local SmallWebRTC transport for one peer connection."""
    params = TransportParams(
        audio_in_enabled=True,
        audio_in_sample_rate=sample_rate,
        audio_out_enabled=True,
        audio_out_sample_rate=24000,
        audio_out_channels=1,
        audio_in_passthrough=False,
    )
    return SmallWebRTCTransport(connection, params)

"""One Pipecat WebRTC conversation session.

This module is deliberately parallel to the compatibility WebSocket route in
``server.py``. It owns only Pipecat session construction and can be removed or
replaced without changing the desktop UI or the fallback voice path.
"""

from __future__ import annotations

import asyncio
import importlib.util
import sys
from pathlib import Path
from typing import Any

import numpy as np

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.frames.frames import (
    InputAudioRawFrame,
    TranscriptionFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.workers.runner import WorkerRunner
from pipecat.turns.user_start.vad_user_turn_start_strategy import VADUserTurnStartStrategy
from pipecat.turns.user_stop.turn_analyzer_user_turn_stop_strategy import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.processors.aggregators.llm_response_universal import LLMUserAggregatorParams

ROOT = Path(__file__).resolve().parent.parent


def _load_services():
    """Load the project adapter despite the legacy root ``server.py`` name."""
    name = "talking_buddy_voice_services"
    loaded = sys.modules.get(name)
    if loaded:
        return loaded
    path = ROOT / "server" / "services.py"
    spec = importlib.util.spec_from_file_location(name, path)
    if not spec or not spec.loader:
        raise RuntimeError(f"Cannot load voice service adapters from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _load_config() -> dict[str, Any]:
    import yaml

    return yaml.safe_load((ROOT / "config.yaml").read_text())


class LocalMLXWhisperProcessor(FrameProcessor):
    """Small Pipecat adapter around the project's already-tested MLX Whisper path."""

    def __init__(self, cfg: dict[str, Any]):
        super().__init__()
        self._cfg = cfg
        self._speaking = False
        self._audio: list[np.ndarray] = []

    async def process_frame(self, frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, VADUserStartedSpeakingFrame):
            self._speaking = True
            self._audio.clear()
        elif isinstance(frame, InputAudioRawFrame) and self._speaking:
            samples = np.frombuffer(frame.audio, dtype=np.int16).astype(np.float32) / 32768.0
            self._audio.append(samples)
        elif isinstance(frame, VADUserStoppedSpeakingFrame) and self._speaking:
            self._speaking = False
            audio = np.concatenate(self._audio) if self._audio else np.zeros(0, dtype=np.float32)
            self._audio.clear()
            if len(audio) >= 1600:
                text = await asyncio.to_thread(self._transcribe, audio)
                if text:
                    await self.push_frame(TranscriptionFrame(text, "local", ""), direction)
        await self.push_frame(frame, direction)

    def _transcribe(self, audio: np.ndarray) -> str:
        import mlx_whisper

        stt = self._cfg["stt"]
        result = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=stt["whisper_repo"],
            language=stt.get("language", "en"),
        )
        return result.get("text", "").strip()


def build_session(connection: Any) -> tuple[PipelineWorker, WorkerRunner]:
    """Build one isolated Pipecat pipeline and its runner for a peer."""
    services = _load_services()
    cfg = _load_config()
    providers = services.build_services(cfg)
    transport = services.build_transport(connection)

    context = LLMContext(
        messages=[
            {
                "role": "system",
                "content": cfg["character"]["system_prompt"].replace(
                    "{name}", cfg["character"]["name"]
                ),
            }
        ]
    )
    aggregators = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=providers.vad,
            user_turn_strategies=UserTurnStrategies(
                start=[VADUserTurnStartStrategy()],
                stop=[TurnAnalyzerUserTurnStopStrategy(turn_analyzer=providers.turn)],
            ),
        ),
    )
    user_context = aggregators.user()
    assistant_context = aggregators.assistant()

    pipeline = Pipeline(
        [
            transport.input(),
            VADProcessor(vad_analyzer=providers.vad),
            LocalMLXWhisperProcessor(cfg),
            user_context,
            providers.llm,
            assistant_context,
            providers.tts,
            transport.output(),
        ]
    )
    worker = PipelineWorker(
        pipeline,
        name="pixel-webrtc-session",
        params=PipelineParams(
            audio_in_sample_rate=16000,
            audio_out_sample_rate=24000,
            enable_metrics=True,
        ),
    )
    runner = WorkerRunner(handle_sigint=False, handle_sigterm=False)
    return worker, runner


async def run_session(connection: Any) -> None:
    """Run a session until the browser disconnects."""
    worker, runner = build_session(connection)
    await runner.add_workers(worker)
    await runner.run()

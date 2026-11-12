"""One Pipecat WebRTC conversation session.

This module is deliberately parallel to the compatibility WebSocket route in
``server.py``. It owns only Pipecat session construction and can be removed or
replaced without changing the desktop UI or the fallback voice path.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.processors.audio.vad_processor import VADProcessor
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
            providers.stt,
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

"""Project-owned Pipecat frame processors.

`WebGateProcessor` gives the Pipecat pipeline the same opt-in web search the
compatibility WebSocket path has, so "search the web ..." works no matter which
voice transport is active.
"""

from __future__ import annotations

import asyncio
import dataclasses
import importlib.util
import sys
from pathlib import Path
from typing import Any

from pipecat.frames.frames import Frame, TranscriptionFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

ROOT = Path(__file__).resolve().parent.parent


def _load_tools():
    """Load the shared web gate without importing the root ``server.py``."""
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


class WebGateProcessor(FrameProcessor):
    """Attach web results to final transcripts when a trigger phrase is spoken.

    The search runs in a worker thread so a slow DNS lookup or HTTP round trip
    cannot stall the audio pipeline.
    """

    def __init__(self, cfg: dict[str, Any], **kwargs):
        super().__init__(**kwargs)
        self._cfg = cfg
        self._tools = _load_tools()

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if (
            direction == FrameDirection.DOWNSTREAM
            and isinstance(frame, TranscriptionFrame)
            and frame.text
        ):
            prompt, used_web = await asyncio.to_thread(
                self._tools.build_prompt, self._cfg, frame.text
            )
            if used_web:
                frame = dataclasses.replace(frame, text=prompt)
        await self.push_frame(frame, direction)

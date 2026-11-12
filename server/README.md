# Target voice service layout

This directory is reserved for the Pipecat migration described in [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md). The existing root `server.py` remains the compatibility implementation until the new pipeline is validated against the pinned dependencies.

Planned modules:

- `bot.py`: Pipecat runner and pipeline assembly
- `services.py`: STT, LLM, and TTS provider constructors
- `processors.py`: WebGate, latency probes, and event adapters
- `preflight.py`: dependency/model checks and warm-up
- `tools.py`: thinker and explicit web-search tools

"""Shared web-access gate for both voice transports.

The compatibility WebSocket path and the Pipecat pipeline use this module so the
internet is touched under exactly the same rules: only when the user says one of
the configured trigger phrases. Keep this file free of FastAPI imports so the
Pipecat worker can load it without pulling in the HTTP compatibility server.
"""

from __future__ import annotations

import re
from typing import Any


def wants_web(cfg: dict[str, Any], text: str) -> str | None:
    """Return the trigger phrase the user said, or None when web access is off."""
    web = cfg.get("web", {})
    if not web.get("enabled"):
        return None
    low = text.lower()
    for trigger in web.get("triggers", []):
        if trigger in low:
            return trigger
    return None


def web_search(query: str, n: int) -> str | None:
    """Run one local web search and flatten the results into prompt text."""
    try:
        from ddgs import DDGS

        results = DDGS().text(query, max_results=n)
        lines = [f"- {item.get('title', '')}: {item.get('body', '')}" for item in results]
        return "\n".join(lines) or None
    except Exception:
        return None


def build_prompt(cfg: dict[str, Any], text: str) -> tuple[str, bool]:
    """Return the prompt to send to the brain and whether the web was used.

    Offline by default. A failed search still tells the model that the user
    asked for the internet so it can say the search did not work.
    """
    trigger = wants_web(cfg, text)
    if not trigger:
        return text, False
    query = re.sub(re.escape(trigger), "", text, flags=re.I).strip(" ,.?!") or text
    results = web_search(query, cfg.get("web", {}).get("max_results", 5))
    if results:
        return (
            f"{text}\n\n[Web search results, use these and mention you looked it up]\n{results}",
            True,
        )
    return (
        f"{text}\n\n[The user asked for a web search but the internet is "
        "unavailable. Say so briefly, then answer from memory if you can.]",
        False,
    )

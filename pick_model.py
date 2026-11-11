"""Recommend (and optionally apply) a local brain that fits this Mac's RAM.

    python3 pick_model.py            # just recommend
    python3 pick_model.py --apply    # also write it into config.yaml
"""
import re
import subprocess
import sys
from pathlib import Path

# (max RAM in GB, Ollama model tag). Edit freely; newer models appear all the time.
TABLE = [
    (12, "gemma3:4b"),
    (20, "gemma3:12b"),
    (32, "qwen3:14b"),
    (10**6, "gemma3:27b"),
]

gb = int(subprocess.check_output(["sysctl", "-n", "hw.memsize"])) / 2**30
model = next(tag for limit, tag in TABLE if gb <= limit)
print(f"Detected {gb:.0f} GB RAM -> recommended brain: {model}")
print(f"Install it with:  ollama pull {model}")

if "--apply" in sys.argv:
    cfg = Path(__file__).parent / "config.yaml"
    text = cfg.read_text()
    text = re.sub(r'(^\s*model:\s*")[^"]*(")',
                  lambda m: m.group(1) + model + m.group(2),
                  text, count=1, flags=re.M)
    cfg.write_text(text)
    print("config.yaml updated.")

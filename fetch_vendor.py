"""One-time download of three.js + three-vrm into static/vendor so the page runs fully offline.
Needs internet once:  python3 fetch_vendor.py
"""
import io
import json
import re
import tarfile
import urllib.request
from pathlib import Path

OUT = Path(__file__).parent / "static" / "vendor"
THREE_VERSION = "0.180.0"


def get(url):
    return urllib.request.urlopen(url, timeout=120).read()


def extract(tgz, wanted, dest):
    with tarfile.open(fileobj=io.BytesIO(tgz)) as tar:
        for m in tar.getmembers():
            name = m.name.split("/", 1)[1] if "/" in m.name else m.name
            if m.isfile() and any(name == w or name.startswith(w) for w in wanted):
                target = dest / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(tar.extractfile(m).read())


print("three", THREE_VERSION)
extract(get(f"https://registry.npmjs.org/three/-/three-{THREE_VERSION}.tgz"),
        ["build/three.module.js", "build/three.core.js", "examples/jsm/"], OUT / "three")
meta = json.loads(get("https://registry.npmjs.org/@pixiv/three-vrm"))
best = max((v for v in meta["versions"] if re.fullmatch(r"3\.\d+\.\d+", v)),
           key=lambda v: tuple(map(int, v.split("."))))
print("three-vrm", best)
extract(get(meta["versions"][best]["dist"]["tarball"]), ["lib/three-vrm.module.min.js"], OUT / "three-vrm")
print("Done. Restart server.py; it now loads three.js from static/vendor.")

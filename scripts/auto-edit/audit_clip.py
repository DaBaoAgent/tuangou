#!/usr/bin/env python3
"""单条成片字幕审计，供发布闸门调用。

用法：
  python audit_clip.py --video x.mp4 --lines-file lines.json \
      --band-y 1360 --band-h 400 --tight-y 1455 --tight-h 130

lines.json 可以是 [{"text","start","end"}]，也可以是 {"lines":[...]}。
输出一行 JSON：{"ok":true/false,"status":"ok|fail|skipped|unavailable","bad":[...],"checked":N}
"""
import argparse
import json
import subprocess
import sys
import tempfile
import urllib.request
from difflib import SequenceMatcher
from pathlib import Path

OCR_URL = "http://127.0.0.1:18224/api/ocr"
STATUS_URL = "http://127.0.0.1:18224/api/status"


def ocr(png):
    body = json.dumps({"path": str(png), "options": {
        "data.format": "dict", "ocr.maxSideLen": 2048}}).encode()
    req = urllib.request.Request(OCR_URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        res = json.loads(r.read().decode())
    if res.get("code") != 100:
        return ""
    data = res["data"]
    return data if isinstance(data, str) else " ".join(x.get("text", "") for x in data)


def clean(text):
    return "".join(ch for ch in text if ch.isalnum() or "\u4e00" <= ch <= "\u9fff")


def frame(video, t, crop, scale, out):
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-ss", f"{t:.2f}", "-i", str(video),
         "-frames:v", "1", "-vf", f"crop={crop},scale=iw*{scale}:-1:flags=lanczos", str(out)],
        check=True,
    )


def compare(expected, got):
    exp, got_c = clean(expected), clean(got)
    ratio = SequenceMatcher(None, exp, got_c).ratio()
    return (exp in got_c or ratio >= 0.75), ratio, got_c


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--lines-file", required=True)
    ap.add_argument("--band-y", type=int, default=1360)
    ap.add_argument("--band-h", type=int, default=400)
    ap.add_argument("--band-scale", type=int, default=3)
    ap.add_argument("--tight-y", type=int, default=1455)
    ap.add_argument("--tight-h", type=int, default=130)
    ap.add_argument("--tight-scale", type=int, default=4)
    args = ap.parse_args()

    try:
        urllib.request.urlopen(STATUS_URL, timeout=5)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "status": "unavailable", "error": str(exc)},
                         ensure_ascii=False))
        return 0

    data = json.loads(Path(args.lines_file).read_text(encoding="utf-8"))
    lines = data.get("lines", []) if isinstance(data, dict) else data
    video = Path(args.video)
    tmp = Path(tempfile.mkdtemp())
    bad = []

    for i, ln in enumerate(lines):
        t = (float(ln["start"]) + float(ln["end"])) / 2
        png = tmp / f"audit_{i:02d}.png"
        frame(video, t, f"1080:{args.band_h}:0:{args.band_y}", args.band_scale, png)
        ok, ratio, got = compare(ln["text"], ocr(png))
        if ok:
            continue
        tight = tmp / f"audit_{i:02d}_tight.png"
        frame(video, t, f"1080:{args.tight_h}:0:{args.tight_y}", args.tight_scale, tight)
        ok2, ratio2, got2 = compare(ln["text"], ocr(tight))
        if not ok2:
            bad.append({
                "t": round(t, 2), "expect": clean(ln["text"]),
                "got": got, "ratio": round(ratio, 2),
                "tight_got": got2, "tight_ratio": round(ratio2, 2),
            })

    result = {
        "ok": not bad,
        "status": "fail" if bad else ("skipped" if not lines else "ok"),
        "checked": len(lines),
        "bad": bad,
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

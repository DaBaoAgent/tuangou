#!/usr/bin/env python3
"""从素材画面里自带的烧录字幕生成「校对稿」草稿（cover 模式用）。

auto_edit.py 的 cover 模式要求先有校对稿，否则只能退回 ASR 重新断句（品牌名容易错）。
本脚本按固定帧率抽帧、裁字幕带、用本机 Dabao-OCR（http://127.0.0.1:18224）识别，
再按文本相似度把连续相同/相近的帧合并成一行，输出 corrections 目录可直接用的 JSON：

  {"lines": [{"text": "...", "start": 0.3, "end": 1.2}, ...], "_source": "legacy_ocr"}

草稿是 OCR 初稿，字一定要人工过一遍（品牌名、同音错字），改完再渲染。

用法：
  python scripts/auto-edit/legacy_ocr_corrections.py \
      --video "Z:/.../81度重庆火锅双人餐AI带货脚本 (1).mp4" \
      --out-dir runtime/auto-edit/corrections-z \
      --band-y 880 --band-h 360 --fps 4
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path
from difflib import SequenceMatcher

OCR_URL = "http://127.0.0.1:18224/api/ocr"
STATUS_URL = "http://127.0.0.1:18224/api/status"
FFMPEG = os.environ.get("FFMPEG_BIN") or r"D:\@kaifa\tools\ffmpeg\bin\ffmpeg.exe"
FFPROBE = os.environ.get("FFPROBE_BIN") or r"D:\@kaifa\tools\ffmpeg\bin\ffprobe.exe"
SIM_THRESHOLD = 0.72


def ocr(png):
    body = json.dumps({"path": str(png), "options": {
        "data.format": "dict", "ocr.maxSideLen": 1536}}).encode()
    req = urllib.request.Request(OCR_URL, data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        res = json.loads(r.read().decode())
    if res.get("code") != 100:
        return ""
    data = res["data"]
    return data if isinstance(data, str) else " ".join(x.get("text", "") for x in data)


def clean(text):
    txt = "".join(ch for ch in text if ch.isalnum() or "\u4e00" <= ch <= "\u9fff")
    # 画面两侧的水印/图标常被 OCR 成单个字母（如 t 结尾的 i、m），去掉
    return txt.strip()


def duration(video):
    out = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                          "-of", "json", str(video)], capture_output=True, text=True, check=True)
    return float(json.loads(out.stdout)["format"]["duration"])


def grab(video, t, out, band_y, band_h, width=720, scale=3):
    subprocess.run([FFMPEG, "-y", "-v", "error", "-ss", f"{t:.2f}", "-i", str(video),
                    "-frames:v", "1",
                    "-vf", f"crop={width}:{band_h}:0:{band_y},scale=iw*{scale}:-1:flags=lanczos",
                    str(out)], check=True)


def similar(a, b):
    if not a or not b:
        return False
    if a in b or b in a:
        return True
    return SequenceMatcher(None, a, b).ratio() >= SIM_THRESHOLD


def process_one(video, args, out_dir):
    dur = duration(video)
    step = 1.0 / args.fps
    tmp = Path(tempfile.mkdtemp())
    samples = []  # (t, text)
    n = int(dur * args.fps)
    for i in range(n):
        t = min(dur - 0.05, (i + 0.5) * step)
        png = tmp / f"s{i:03d}.png"
        try:
            grab(video, t, png, args.band_y, args.band_h, args.width)
            txt = clean(ocr(png))
        except Exception as exc:  # noqa: BLE001
            print(f"[warn] {t:.2f}s 抽帧/OCR 失败：{exc}", file=sys.stderr)
            continue
        if len(txt) >= args.min_chars:
            samples.append((t, txt))

    # 合并：连续帧文本相近 → 同一行；正文取出现最多的那次（截断帧只投票不影响正文）
    def majority(votes):
        counts = {}
        for v in votes:
            counts[v] = counts.get(v, 0) + 1
        top = max(counts.values())
        cands = [v for v, c in counts.items() if c == top]
        return max(cands, key=len)

    lines = []
    cur = None
    for t, txt in samples:
        if cur and (t - cur["end"] <= 0.9) and similar(cur["text"], txt):
            cur["votes"].append(txt)
            cur["text"] = majority(cur["votes"])
            cur["end"] = t
        else:
            if cur:
                lines.append(cur)
            cur = {"text": txt, "start": t, "end": t, "votes": [txt]}
    if cur:
        lines.append(cur)

    out_lines = []
    for ln in lines:
        if len(ln["text"]) < args.min_chars:
            continue
        start = max(0.0, ln["start"] - step / 2)
        end = min(dur, ln["end"] + step / 2)
        out_lines.append({"text": ln["text"], "start": round(start, 2), "end": round(end, 2)})

    stem = args.out_name or video.stem
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{stem}.json"
    payload = {"lines": out_lines, "_source": "legacy_ocr", "_draft": True,
               "_band": {"y": args.band_y, "h": args.band_h}, "_video": video.name}
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "video": video.name, "lines": len(out_lines),
                      "duration": round(dur, 2), "out": str(out_path)}, ensure_ascii=False))
    for ln in out_lines:
        print(f"  {ln['start']:5.2f}-{ln['end']:5.2f}  {ln['text']}")
    return len(out_lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", help="单个素材路径")
    ap.add_argument("--dir", help="批量：素材所在目录（只取 mp4/mov）")
    ap.add_argument("--out-dir", default="runtime/auto-edit/corrections-z")
    ap.add_argument("--band-y", type=int, default=975)
    ap.add_argument("--band-h", type=int, default=140)
    ap.add_argument("--width", type=int, default=720)
    ap.add_argument("--fps", type=float, default=4.0)
    ap.add_argument("--min-chars", type=int, default=2)
    ap.add_argument("--out-name", help="输出文件名（不含扩展名，默认取素材名）")
    ap.add_argument("--skip-existing", action="store_true", help="已有同名校对稿则跳过")
    args = ap.parse_args()
    if not args.video and not args.dir:
        ap.error("--video 或 --dir 至少给一个")

    try:
        urllib.request.urlopen(STATUS_URL, timeout=5)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"OCR 服务不可用：{exc}"}, ensure_ascii=False))
        return 2

    out_dir = Path(args.out_dir)
    videos = []
    if args.video:
        videos = [Path(args.video)]
    if args.dir:
        for ext in ("*.mp4", "*.MP4", "*.mov", "*.MOV"):
            videos += sorted(Path(args.dir).glob(ext))

    total = 0
    for video in videos:
        if args.skip_existing and (out_dir / f"{video.stem}.json").exists():
            print(f"[skip] 已有校对稿：{video.stem}")
            continue
        total += process_one(video, args, out_dir)
    print(json.dumps({"ok": True, "videos": len(videos), "lines": total}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

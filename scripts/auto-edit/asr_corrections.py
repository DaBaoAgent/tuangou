#!/usr/bin/env python3
"""用口播 ASR 的逐字时间戳切字幕行，生成校对稿草稿。

为什么不用拍照 OCR 的行：素材里的烧录字幕本身就常带 AI 错字，且换行位置会漂
（两行、上移），窄带 OCR 会漏行。ASR 按「字间停顿 + 行长上限」切行更完整，
正文也基本是普通话原句，人工只需改品牌名等专有词。

用法：
  python scripts/auto-edit/asr_corrections.py --config runtime/auto-edit/config-z-new.json \
      --dir "Z:/暂时不用素材/团购/未剪素材" --out-dir runtime/auto-edit/corrections-z-asr
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import auto_edit  # noqa: E402

PAUSE = 0.24      # 字间停顿超过这个就当换行
MAX_CHARS = 14    # 一行最多这么多字（1080p 下 12 字仍居中，14 字会缩字号）
MIN_DUR = 0.9     # 行太短就往后延，避免一闪而过


def build(asr, dur, max_chars=MAX_CHARS, pause=PAUSE):
    chars = []
    for seg in asr:
        for w in seg.get("words") or []:
            ch = (w.get("w") or w.get("word") or "").strip()
            if ch:
                chars.append({"ch": ch, "start": float(w["start"]), "end": float(w["end"])})
    lines, cur = [], []
    for c in chars:
        if cur:
            gap = c["start"] - cur[-1]["end"]
            text_len = len("".join(x["ch"] for x in cur))
            if gap > pause or text_len >= max_chars:
                lines.append(cur)
                cur = []
        cur.append(c)
    if cur:
        lines.append(cur)

    out = []
    for i, grp in enumerate(lines):
        text = auto_edit.clean_text("".join(x["ch"] for x in grp))
        if not text:
            continue
        start = max(0.0, grp[0]["start"] - 0.05)
        end = min(dur, grp[-1]["end"] + 0.12)
        if end - start < MIN_DUR:
            end = min(dur, start + MIN_DUR)
        # 别和下一行重叠
        if i + 1 < len(lines):
            nxt = lines[i + 1][0]["start"] - 0.05
            end = min(end, max(start + 0.3, nxt))
        out.append({"text": text, "start": round(start, 2), "end": round(end, 2)})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="runtime/auto-edit/config.json")
    ap.add_argument("--dir")
    ap.add_argument("--video", action="append")
    ap.add_argument("--out-dir", default="runtime/auto-edit/corrections-z-asr")
    args = ap.parse_args()

    cfg = auto_edit.load_config(args.config)
    work_root = Path(cfg["paths"]["work_dir"])
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    videos = []
    if args.video:
        videos += [Path(v) for v in args.video]
    if args.dir:
        for ext in ("*.mp4", "*.MP4", "*.mov", "*.MOV"):
            videos += sorted(Path(args.dir).glob(ext))

    for video in videos:
        asr_path = work_root / video.stem / "asr.json"
        if not asr_path.exists():
            print(f"[skip] {video.name}（缺 asr.json）")
            continue
        asr = json.loads(asr_path.read_text(encoding="utf-8"))
        dur = auto_edit.source_duration(video)
        lines = build(asr, dur)
        payload = {"lines": lines, "_source": "asr_words", "_draft": True, "_video": video.name}
        (out_dir / f"{video.stem}.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"== {video.name}")
        for ln in lines:
            print(f"  {ln['start']:5.2f}-{ln['end']:5.2f}  {ln['text']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

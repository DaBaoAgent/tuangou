#!/usr/bin/env python3
"""批量把素材跑一遍 ASR，结果落到 work_dir/<素材名>/asr.json。

用途：画面烧录字幕的 OCR 常有错字（AI 生成的字幕本身就带错字），
用口播 ASR 文本做交叉校正，再按 OCR 的行时间对齐成校对稿。

用法：
  python scripts/auto-edit/asr_for_clips.py --config runtime/auto-edit/config-z-new.json \
      --dir "Z:/暂时不用素材/团购/未剪素材"
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import auto_edit  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="runtime/auto-edit/config.json")
    ap.add_argument("--dir")
    ap.add_argument("--video", action="append")
    ap.add_argument("--skip-existing", action="store_true")
    args = ap.parse_args()

    cfg = auto_edit.load_config(args.config)
    videos = []
    if args.video:
        videos += [Path(v) for v in args.video]
    if args.dir:
        for ext in ("*.mp4", "*.MP4", "*.mov", "*.MOV"):
            videos += sorted(Path(args.dir).glob(ext))

    work_root = Path(cfg["paths"]["work_dir"])
    done = 0
    for video in videos:
        workdir = work_root / video.stem
        workdir.mkdir(parents=True, exist_ok=True)
        asr_path = workdir / "asr.json"
        if args.skip_existing and asr_path.exists() and asr_path.stat().st_mtime >= video.stat().st_mtime:
            print(f"[skip] {video.name}")
            continue
        print(f"[asr] {video.name}", flush=True)
        asr = auto_edit.transcribe(cfg, video, workdir)
        auto_edit.to_simplified(asr)
        asr_path.write_text(json.dumps(asr, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"      segments={len(asr)} text={''.join(s['text'] for s in asr)[:120]}", flush=True)
        done += 1
    print(json.dumps({"ok": True, "done": done}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

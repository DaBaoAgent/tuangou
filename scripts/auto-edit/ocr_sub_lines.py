#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从自带烧录字幕的素材里抽原字幕（cover 模式校对稿的初稿来源）。

按 4fps 抽帧、裁检测到的字幕带、Dabao-OCR 逐帧识别，按文本变化合并成行；
同时跑 ASR 备一份口播文本，供人工交叉核对错字。输出的是**草稿**，
必须人工改过错字/品牌商品名后才写进 corrections-z（宝哥规则：校对稿不删行）。

用法：
  python scripts/auto-edit/ocr_sub_lines.py --config runtime/auto-edit/config-z-batch.json \
      --clip "饭美滋北京烤鸭老北京片皮鸭1-2人餐带货脚本.mp4"
  python scripts/auto-edit/ocr_sub_lines.py --config ... --all --no-asr
"""

import argparse
import difflib
import json
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import auto_edit as AE  # noqa: E402

PUNCT = re.compile(r"[，。！？、,.!?\"'“”‘’（）()【】\[\]:：;；~…—\-\s]")


def norm(text):
    return PUNCT.sub("", text)


def similar(a, b):
    a, b = norm(a), norm(b)
    if not a or not b:
        return False
    if abs(len(a) - len(b)) > max(3, int(len(a) * 0.5)):
        return False
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.72


def ocr_frames(cfg, clip, workdir, band, fps=4.0):
    """裁字幕带抽帧并逐帧 OCR，返回 [(t, text)]。"""
    src_w, src_h = AE._clip_size(clip)
    y0, y1 = band
    if src_w and src_w != int(cfg["video"]["width"]):
        s = src_w / float(cfg["video"]["width"])
        y0 = max(0, int(round(y0 * s)))
        y1 = min(src_h or 1280, int(round(y1 * s)))
    h = max(2, y1 - y0)
    frames_dir = workdir / "ocr_frames"
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir(parents=True, exist_ok=True)
    AE.ffmpeg(
        "-i", str(clip),
        "-vf", f"fps={fps},crop={src_w}:{h}:0:{y0}",
        "-q:v", "3", str(frames_dir / "%04d.jpg"),
    )
    bot = AE.brand_ocr
    out = []
    for f in sorted(frames_dir.glob("*.jpg")):
        idx = int(f.stem) - 1
        t = idx / fps
        try:
            blocks = bot._ocr_image(f, max_side_len=2048)
        except Exception as exc:  # OCR 服务偶发超时：这一帧留空，不影响整条
            AE.log(f"OCR 失败 @{t:.2f}s：{exc}")
            blocks = []
        parts = []
        for b in sorted(blocks, key=lambda x: (x.get("x") or 0)):
            score = float(b.get("score") or 0)
            if score < 0.8:
                continue
            txt = AE.clean_text(b.get("text", ""))
            if txt:
                parts.append(txt)
        out.append((t, "".join(parts)))
    return out


def merge_lines(frames, dur, fps=4.0):
    groups = []
    for t, text in frames:
        if not norm(text):
            continue
        if groups and similar(groups[-1]["raw"][-1][1], text):
            groups[-1]["raw"].append((t, text))
            groups[-1]["end"] = t
        else:
            groups.append({"raw": [(t, text)], "start": t, "end": t})
    lines = []
    for i, g in enumerate(groups):
        variants = {}
        for _, txt in g["raw"]:
            variants[txt] = variants.get(txt, 0) + 1
        best = max(variants.items(), key=lambda kv: (kv[1], len(kv[0])))[0]
        start = max(0.0, g["start"] - 0.05)
        end = min(dur, g["end"] + 0.3)
        if i + 1 < len(groups):
            end = min(end, max(groups[i + 1]["start"], start + 0.3))
        lines.append({
            "text": best, "start": round(start, 2), "end": round(end, 2),
            "votes": len(g["raw"]), "variants": list(variants)[:4],
        })
    return lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--clip")
    ap.add_argument("--stems", help="逗号分隔的素材 stem 列表（精确处理这几条）")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--out-dir", default="runtime/auto-edit/ocr-draft-z")
    ap.add_argument("--no-asr", action="store_true")
    args = ap.parse_args()

    AE._heavy()
    cfg = AE.load_config(args.config)
    clips = AE.find_clips(cfg, args.clip, args.all)
    if args.stems:
        want = [s.strip() for s in args.stems.split(",") if s.strip()]
        clips = [p for p in AE.find_clips(cfg, None, True) if p.stem in want]
    if not clips:
        print("没有匹配的素材")
        return 1
    out_dir = AE.ROOT / args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    for clip in clips:
        dur = AE.source_duration(clip)
        workdir = Path(cfg["paths"]["work_dir"]) / clip.stem
        workdir.mkdir(parents=True, exist_ok=True)
        bars = AE.detect_legacy_bars(cfg, clip, workdir, dur)
        rec = {"clip": str(clip), "stem": clip.stem, "duration": round(dur, 2),
               "bars": bars, "band": None, "lines": [], "asr": [],
               "asr_text": "", "status": "ok"}
        if not bars:
            rec["status"] = "no_band"
            AE.log(f"[{clip.name}] 没检出字幕带，按无字幕处理")
        else:
            y0 = max(0, min(int(b["y0"]) for b in bars))
            y1 = min(int(cfg["video"]["height"]), max(int(b["y1"]) for b in bars))
            rec["band"] = [y0, y1]
            frames = ocr_frames(cfg, clip, workdir, (y0, y1))
            rec["lines"] = merge_lines(frames, dur)
            rec["frames"] = [[round(t, 2), txt] for t, txt in frames if txt]
            AE.log(f"[{clip.name}] 字幕带 {y0}-{y1}，合并出 {len(rec['lines'])} 行")
        if not args.no_asr:
            asr_path = workdir / "asr.json"
            sig = AE.video_sig(clip)
            stamp = workdir / "asr_src.txt"
            if (asr_path.exists() and stamp.exists()
                    and stamp.read_text(encoding="utf-8").strip() == sig):
                asr = json.loads(asr_path.read_text(encoding="utf-8"))
                AE.to_simplified(asr)
            else:
                asr = AE.transcribe(cfg, clip, workdir)
                AE.to_simplified(asr)
                asr_path.write_text(json.dumps(asr, ensure_ascii=False, indent=2), encoding="utf-8")
                stamp.write_text(sig, encoding="utf-8")
            rec["asr"] = [{"text": s.get("text", ""), "start": round(float(s.get("start") or 0), 2),
                           "end": round(float(s.get("end") or 0), 2)} for s in asr]
            rec["asr_text"] = "".join(x["text"] for x in rec["asr"])
            # 没有烧录字幕的素材：草稿行按 ASR 断句生成，人工改字后即为校对稿
            if not rec["lines"] and asr:
                rec["lines"] = [
                    {"text": x["text"], "start": round(float(x["start"]), 2), "end": round(float(x["end"]), 2),
                     "votes": 0, "variants": []}
                    for x in AE.build_lines(asr, dur, cfg)
                ]
                rec["lines_from"] = "asr"
        out = out_dir / f"{clip.stem}.json"
        out.write_text(json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
        AE.log(f"草稿：{out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

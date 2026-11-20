#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 ocr-draft 草稿加工成 corrections-z 校对稿：只做时间轴整理 + 词表纠错，
不改内容、不删行（宝哥规则 7）。

为什么要有这一步：
  OCR 草稿是按「文本变化」切行的，句间常留 0.2–6s 的空档；直接抄进校对稿，
  成片字幕就会消失一段时间再突然冒出来，即宝哥 2026-11-19 说的「一跳一跳」。
  本脚本把空档按 ASR 口播补齐（补行不改行），再把时间轴做成首尾相接、每行
  至少展示 min_duration，交给 auto_edit.py 的 stabilize_lines 兜底。

用法：
  py scripts/auto-edit/build_corrections.py --config runtime/auto-edit/config-z-new.json \
      --stems "A,B" --fixes runtime/auto-edit/fixes-z-20261119.json            # dry-run
  py scripts/auto-edit/build_corrections.py ... --apply                          # 落盘
"""

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import auto_edit as AE  # noqa: E402

PUNCT = re.compile(r"[，。！？、,.!?\"'“”‘’（）()【】\[\]:：;；~…—\-\s]")


def norm(text):
    return PUNCT.sub("", text or "")


def load_json(path, default=None):
    p = Path(path)
    if not p.exists():
        return default
    return json.loads(p.read_text(encoding="utf-8"))


def apply_pairs(text, pairs):
    """按词表纠错，长词优先，避免短词先把长词拆了。"""
    for pair in sorted(pairs, key=lambda x: -len(x["wrong"])):
        text = text.replace(pair["wrong"], pair["right"])
    return text


def asr_segments_in(asr, start, end):
    """取完全落在空档内、且有实际文字的 ASR 片段。"""
    out = []
    for seg in asr:
        s, e = float(seg.get("start") or 0), float(seg.get("end") or 0)
        txt = AE.clean_text(seg.get("text", ""))
        if not txt or e - s < 0.25:
            continue
        if s >= start - 0.15 and e <= end + 0.15:
            out.append({"text": txt, "start": max(start, s), "end": min(end, e)})
    return out


def split_text(text, max_chars, start, end):
    """长句按字数均分到时间轴上。"""
    text = AE.clean_text(text)
    if not text:
        return []
    if len(text) <= max_chars:
        return [{"text": text, "start": round(start, 2), "end": round(end, 2)}]
    k = max(1, -(-len(text) // max_chars))
    size = -(-len(text) // k)
    pieces = [text[i:i + size] for i in range(0, len(text), size)]
    total = max(end - start, 0.3)
    out, pos = [], start
    for piece in pieces:
        seg = total * len(piece) / len(text)
        out.append({"text": piece, "start": round(pos, 2), "end": round(pos + seg, 2)})
        pos += seg
    return out


def cover_of(stem_fixes):
    return (stem_fixes or {}).get("cover", None)


def build_record(lines, dur, cfg, asr=None, cover=None, note="", gap_filled=0):
    lines = AE.stabilize_lines(lines, dur, cfg, asr) if lines else []
    rec = {"lines": lines, "note": note, "source": "ocr-draft", "gap_filled": gap_filled}
    if cover is not None:
        rec["cover"] = cover
    return rec


def build_one(draft, cfg, fixes, stem_fixes):
    sub = cfg["subtitle"]
    max_chars = int(sub["max_chars"])
    dur = float(draft.get("duration") or 0) or 15.07
    pairs = list(fixes.get("replace") or []) + list((stem_fixes or {}).get("replace") or [])
    tokens = list(fixes.get("tokens") or [])

    lines = []
    override = (stem_fixes or {}).get("lines")
    if override:
        for ln in override:
            text = apply_pairs(AE.clean_text(ln.get("text", "")), pairs)
            text = apply_pairs(text, tokens)
            if text:
                lines.append({"text": text, "start": float(ln.get("start") or 0),
                              "end": float(ln.get("end") or 0)})
        return build_record(lines, dur, cfg, asr=draft.get("asr") or [], cover=cover_of(stem_fixes),
                            note=(stem_fixes or {}).get("note") or "人工校对稿（整条重写）")

    for ln in draft.get("lines") or []:
        text = apply_pairs(AE.clean_text(ln.get("text", "")), pairs)
        text = apply_pairs(text, tokens)
        if text:
            lines.append({"text": text, "start": float(ln.get("start") or 0),
                          "end": float(ln.get("end") or 0)})

    # 空档 > 1.2s：按 ASR 口播补行（补的是真实念过的话，不是编内容）
    asr = draft.get("asr") or []
    gaps = []
    for i in range(len(lines) - 1):
        gap_s, gap_e = lines[i]["end"], lines[i + 1]["start"]
        if gap_e - gap_s > 1.2:
            gaps.append((i, gap_s, gap_e))
    inserted = 0
    for i, gap_s, gap_e in reversed(gaps):
        segs = asr_segments_in(asr, gap_s, gap_e)
        if not segs:
            continue
        new_lines = []
        for seg in segs:
            text = apply_pairs(seg["text"], pairs)
            text = apply_pairs(text, tokens)
            new_lines.extend(split_text(text, max_chars, seg["start"], seg["end"]))
        if new_lines:
            lines[i + 1:i + 1] = new_lines
            inserted += len(new_lines)

    lines = AE.stabilize_lines(lines, dur, cfg, asr) if lines else []

    cover = (stem_fixes or {}).get("cover", None)
    note = (stem_fixes or {}).get("note") or "OCR 草稿 + ASR 补空档"
    rec = {"lines": lines, "note": note, "source": "ocr-draft", "gap_filled": inserted}
    if cover is not None:
        rec["cover"] = cover
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--stems", required=True, help="逗号分隔的源素材 stem")
    ap.add_argument("--draft-dir", default="runtime/auto-edit/ocr-draft-z")
    ap.add_argument("--fixes", default="")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    cfg = AE.load_config(args.config)
    fixes = load_json(args.fixes, {}) if args.fixes else {}
    clips = fixes.get("clips") or {}
    draft_dir = AE.ROOT / args.draft_dir
    corr_dir = Path(cfg["paths"]["corrections_dir"])

    want = [s.strip() for s in args.stems.split(",") if s.strip()]
    for stem in want:
        draft_path = draft_dir / f"{stem}.json"
        if not draft_path.exists():
            AE.log(f"[跳过] {stem} 没有草稿")
            continue
        draft = json.loads(draft_path.read_text(encoding="utf-8"))
        stem_fixes = clips.get(stem) or {}
        rec = build_one(draft, cfg, fixes, stem_fixes)
        AE.log(f"[{stem}] 行={len(rec['lines'])} 补行={rec['gap_filled']} cover={rec.get('cover', 'auto')}")
        for ln in rec["lines"]:
            AE.log(f"    {ln['start']:5.2f}-{ln['end']:5.2f} {ln['text']}")
        if args.apply:
            out = corr_dir / f"{stem}.json"
            out.write_text(json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
            AE.log(f"    写出 {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

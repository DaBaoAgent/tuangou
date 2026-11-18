#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""独立 ASR 复核：不复用任何 OCR/ASR 缓存，直接对成片重新转写。

用途：切割修复后的清理版/成片，确认缺陷句真的没了（例：念出的脚本备注「门店名字」）。
字幕行以 OCR 为准，本脚本只用来验证音频内容，不可拿它当字幕稿。

用法：
  py scripts/auto-edit/recheck_asr.py "tmp/clean_haidilao/xxx.mp4"
  py scripts/auto-edit/recheck_asr.py "Z:/暂时不用素材/团购/已剪成片/海底捞-闲时团购券-01.mp4" --forbid "门店名字,融入场景"
命中 --forbid 里任一词 → 打印命中位置并以退出码 1 结束（可直接串在流程里卡关）。
"""
import argparse
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import auto_edit as AE


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clip", help="待复核的 mp4")
    ap.add_argument("--config", default=None)
    ap.add_argument("--forbid", default="", help="逗号分隔的禁用词，命中即失败")
    ap.add_argument("--json-out", default=None, help="把逐段结果写到这个 json")
    args = ap.parse_args()

    clip = Path(args.clip)
    if not clip.is_absolute():
        clip = AE.ROOT / clip
    if not clip.exists():
        raise SystemExit(f"找不到文件：{clip}")

    cfg = AE.load_config(args.config)
    dur = AE.source_duration(clip)
    forbid = [w.strip() for w in args.forbid.replace("，", ",").split(",") if w.strip()]

    with tempfile.TemporaryDirectory(prefix="recheck-asr-") as tmp:
        workdir = Path(tmp)
        segs = AE.transcribe(cfg, clip, workdir)  # 全新目录，必然重算
        AE.to_simplified(segs)

    rows = [{"text": s.get("text", ""), "start": round(float(s.get("start") or 0), 2),
             "end": round(float(s.get("end") or 0), 2)} for s in segs]
    joined = "".join(r["text"] for r in rows)
    AE.log(f"{clip.name} {dur:.2f}s，{len(rows)} 段")
    for r in rows:
        AE.log(f"  {r['start']:>5.2f}-{r['end']:>5.2f} {r['text']}")

    hits = [w for w in forbid if w and w in joined]
    if args.json_out:
        Path(args.json_out).write_text(
            json.dumps({"clip": str(clip), "duration": round(dur, 2), "segments": rows,
                        "forbid": forbid, "hits": hits}, ensure_ascii=False, indent=2),
            encoding="utf-8")
    if hits:
        AE.log(f"[FAIL] 命中禁用词：{'、'.join(hits)}")
        return 1
    if forbid:
        AE.log(f"[OK] 未命中禁用词：{'、'.join(forbid)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

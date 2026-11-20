#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""字幕时间轴体检：校对稿/成片字幕是否有空档、重叠、超短行（2026-11-19 宝哥「字幕不要一跳一跳」固化项）。

只看时间轴，不 OCR、不渲染，秒级跑完，放在 Step 3 校对稿之后、Step 4 渲染之前做闸门。

用法：
  py scripts/auto-edit/check_sub_gaps.py --dir runtime/auto-edit/corrections-z
  py scripts/auto-edit/check_sub_gaps.py --dir runtime/auto-edit/corrections-z --stems-file tmp/render_list.json
  py scripts/auto-edit/check_sub_gaps.py --dir runtime/auto-edit/corrections-z --max-gap 0.15 --fail

判定：
  - gap：相邻两行 end→start 的空档，> --max-gap 记 FAIL（字幕消失再出现＝一跳）
  - overlap：相邻两行同时显示，> --max-overlap 记 FAIL（两行叠字＝一跳）
  - late_start：首行 start > --max-late 记 FAIL（开头一句字幕迟到）
  - patchy：行时长 < min_duration*0.5 记 WARN（一闪而过）
退出码：有 FAIL 且给了 --fail 时返回 1，否则返回 0（默认只报告）。
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import auto_edit as AE


def load_stems(args):
    stems = None
    if args.stems:
        stems = [s.strip() for s in args.stems.split(",") if s.strip()]
    if args.stems_file:
        items = json.loads(Path(args.stems_file).read_text(encoding="utf-8"))
        stems = (stems or []) + [
            (it["stem"] if isinstance(it, dict) else Path(it).stem) for it in items
        ]
    return set(stems) if stems else None


def main():
    ap = argparse.ArgumentParser(description="字幕时间轴体检（空档/重叠）")
    ap.add_argument("--dir", default="runtime/auto-edit/corrections-z", help="校对稿目录")
    ap.add_argument("--stems", help="逗号分隔，只查这几条")
    ap.add_argument("--stems-file", help="render_list.json / 清单文件，只查其中条目")
    ap.add_argument("--max-gap", type=float, default=0.15, help="允许的最大空档（秒）")
    ap.add_argument("--max-overlap", type=float, default=0.05, help="允许的最大重叠（秒）")
    ap.add_argument("--max-late", type=float, default=0.10, help="首行允许的最晚起点（秒）")
    ap.add_argument("--min-duration", type=float, default=0.8, help="行最短展示，用于 WARN")
    ap.add_argument("--fail", action="store_true", help="有 FAIL 时退出码 1")
    args = ap.parse_args()

    d = Path(args.dir)
    if not d.is_absolute():
        d = AE.ROOT / d
    stems = load_stems(args)
    fails, warns, checked = [], [], 0

    for p in sorted(d.glob("*.json")):
        stem = p.stem
        if stems is not None and stem not in stems:
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            fails.append(f"{stem}: 读不了 ({exc})")
            continue
        lines = data.get("lines") or []
        if not lines:
            continue
        checked += 1
        lines = sorted(lines, key=lambda x: float(x.get("start") or 0))
        if float(lines[0]["start"]) > args.max_late:
            fails.append(f"{stem}: 首行 {float(lines[0]['start']):.2f}s 才出字（>{args.max_late}s）")
        for a, b in zip(lines, lines[1:]):
            gap = float(b["start"]) - float(a["end"])
            if gap > args.max_gap:
                fails.append(f"{stem}: 空档 {gap:.2f}s 在 {float(a['end']):.2f}s"
                             f"「{a['text']}」→「{b['text']}」")
            elif gap < -args.max_overlap:
                fails.append(f"{stem}: 重叠 {-gap:.2f}s 「{a['text']}」/{b['text']}")
        for ln in lines:
            if float(ln["end"]) - float(ln["start"]) < args.min_duration * 0.5:
                warns.append(f"{stem}: 行太短 {float(ln['end'])-float(ln['start']):.2f}s「{ln['text']}」")

    print(f"检查 {checked} 份校对稿：FAIL={len(fails)} WARN={len(warns)}")
    for f in fails:
        print("  FAIL " + f)
    for w in warns[:20]:
        print("  WARN " + w)
    if len(warns) > 20:
        print(f"  ... 另有 {len(warns) - 20} 条 WARN")
    if fails and args.fail:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

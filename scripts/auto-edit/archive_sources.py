# -*- coding: utf-8 -*-
"""批次源素材归档：渲染+审计通过后，把清单里的源素材移入 未剪素材/已剪素材。

默认 dry-run，只打印将要做什么；--apply 才真移动。

用法：
  python scripts/auto-edit/archive_sources.py \
    --list tmp/render_list.json \
    --source-dir "Z:\\暂时不用素材\\团购\\未剪素材" \
    --stage "Z:\\暂时不用素材\\团购\\已剪成片"

安全约束：
- 只处理清单里列出的 `<stem>.mp4`，不碰同目录其它文件（MOV、其它批次、`田` 子目录）。
- 成片不存在或大小为 0 就跳过并报错，不移动源（避免「源没了片没出」）。
- 目标已存在同名文件时跳过并报错，不覆盖。
"""
import argparse
import json
from pathlib import Path


def main():
    ap = argparse.ArgumentParser(description="归位源素材到 已剪素材（默认 dry-run）")
    ap.add_argument("--list", required=True, help="渲染清单 JSON（含 stem/name）")
    ap.add_argument("--source-dir", required=True)
    ap.add_argument("--stage", required=True, help="成片目录")
    ap.add_argument("--archive-sub", default="已剪素材", help="源素材归档子目录名")
    ap.add_argument("--apply", action="store_true", help="真移动（默认只打印）")
    args = ap.parse_args()

    source_dir = Path(args.source_dir)
    stage = Path(args.stage)
    archive_dir = source_dir / args.archive_sub
    rows = json.loads(Path(args.list).read_text(encoding="utf-8"))

    ready, problems = [], []
    for r in rows:
        src = source_dir / f"{r['stem']}.mp4"
        out = stage / r["name"]
        if not src.exists():
            problems.append(f"源缺失：{src.name}")
            continue
        if not out.exists():
            problems.append(f"成片缺失：{r['name']}")
            continue
        if out.stat().st_size <= 0:
            problems.append(f"成片为空：{r['name']}")
            continue
        if (archive_dir / src.name).exists():
            problems.append(f"归档目标已存在：{src.name}")
            continue
        ready.append((src, out))

    print(f"待归档 {len(ready)} 条，问题 {len(problems)} 条，目标目录 {archive_dir}")
    for p in problems:
        print(" -", p)
    if not ready:
        return
    if not args.apply:
        for src, out in ready:
            print(f"[dry-run] {src.name}  ->  {archive_dir}")
        print("加 --apply 才真移动")
        return

    archive_dir.mkdir(parents=True, exist_ok=True)
    moved = 0
    for src, _out in ready:
        src.rename(archive_dir / src.name)
        moved += 1
    print(f"已归档 {moved} 条源素材")


if __name__ == "__main__":
    main()

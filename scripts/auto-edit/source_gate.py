#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Z 线来源闸门：黑名单哈希 + 已归档源片 + 已出成片 三重查重（SOP Step 0）。

查重口径（AGENTS 规则 8/10）：
- 命中 `scripts/publish/source_blacklist.json` 的源片哈希或文件名正则 → 拒收（另一个号的专用素材）；
- 与 `未剪素材/已剪素材` 里已归档源片哈希相同 → 说明这条已经剪过，重复入队会重发；
- 与 `已剪成片` 里成片哈希相同 → 直接就是已出片的成品。

用法：
  py scripts/auto-edit/source_gate.py                      # 查 未剪素材 顶层全部 mp4
  py scripts/auto-edit/source_gate.py --starts-with 犇腾牛排 --starts-with Texas  # 只看这批
  py scripts/auto-edit/source_gate.py --json-out tmp/gate.json
退出码：0 = 全部干净；1 = 有命中（命中条目按原因列出，交人工判定是否移入隔离区）。
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import auto_edit as AE


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest().upper()


def index_dir(d: Path):
    out = {}
    if not d.exists():
        return out
    for p in d.iterdir():
        if p.is_file() and p.suffix.lower() == ".mp4":
            out.setdefault(sha256(p), p.name)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-dir", default="Z:/暂时不用素材/团购/未剪素材")
    ap.add_argument("--stage", default="Z:/暂时不用素材/团购/已剪成片")
    ap.add_argument("--starts-with", action="append", default=None, help="只查这些前缀的源素材（可多次）")
    ap.add_argument("--json-out", default=None)
    args = ap.parse_args()

    src = Path(args.source_dir)
    if not src.exists():
        raise SystemExit(f"源目录不存在：{src}")
    bl = json.loads((AE.ROOT / "scripts/publish/source_blacklist.json").read_text(encoding="utf-8"))
    bl_sha = {i["sha256"].upper() for i in bl.get("source_files", []) if isinstance(i, dict) and i.get("sha256")}
    pat = re.compile(r"^\d+月\d+日_")

    archived = index_dir(src / "已剪素材")
    staged = index_dir(Path(args.stage))

    clips = [p for p in sorted(src.iterdir())
             if p.is_file() and p.suffix.lower() == ".mp4" and p.name != "田"]
    if args.starts_with:
        clips = [p for p in clips if p.name.startswith(tuple(args.starts_with))]

    rows, hits = [], 0
    for p in clips:
        s = sha256(p)
        flags = []
        if pat.match(p.name):
            flags.append("文件名命中黑名单正则")
        if s in bl_sha:
            flags.append("哈希=黑名单源片")
        if s in archived:
            flags.append(f"哈希=已归档源片({archived[s]})")
        if s in staged:
            flags.append(f"哈希=已成片({staged[s]})")
        hits += bool(flags)
        rows.append({"clip": p.name, "mb": round(p.stat().st_size / 1048576, 1),
                     "sha256": s, "flags": flags})
        AE.log(f"{p.name} | {rows[-1]['mb']} MB | {'OK' if not flags else ' / '.join(flags)}")

    AE.log(f"黑名单 {len(bl_sha)} 条 / 已归档 {len(archived)} 条 / 已成片 {len(staged)} 条；"
           f"本批 {len(rows)} 条，命中 {hits} 条")
    if args.json_out:
        Path(args.json_out).write_text(json.dumps({"clips": rows, "hits": hits}, ensure_ascii=False, indent=2),
                                       encoding="utf-8")
    return 0 if hits == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

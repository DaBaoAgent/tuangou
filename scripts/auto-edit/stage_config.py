#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""清理版专用配置：从现有配置派生一份 paths.source_dir 指向清理版目录的配置。

修完缺陷段的清理版与原片同 stem，直接跑 OCR/渲染会读回原件，所以必须派生配置并显式传 -Config。

用法：
  py scripts/auto-edit/stage_config.py --source-dir tmp/clean_haidilao \
      --out runtime/auto-edit/config-z-clean.json
  # 默认以 runtime/auto-edit/config.json 为底；Z 线传 --from runtime/auto-edit/config-z-new.json
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import auto_edit as AE


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="base", default="runtime/auto-edit/config.json", help="基础配置")
    ap.add_argument("--source-dir", required=True, help="清理版所在目录")
    ap.add_argument("--out", required=True, help="派生配置落盘路径")
    ap.add_argument("--work-dir", default=None, help="可选：单独的工作目录，避免覆盖原片的中间产物")
    args = ap.parse_args()

    base = Path(args.base)
    if not base.is_absolute():
        base = AE.ROOT / base
    cfg = json.loads(base.read_text(encoding="utf-8"))

    src = args.source_dir.replace("\\", "/")
    if not src.startswith("Z:/"):
        src = str((AE.ROOT / args.source_dir).as_posix())
    cfg.setdefault("paths", {})["source_dir"] = src
    if args.work_dir:
        cfg["paths"]["work_dir"] = args.work_dir.replace("\\", "/")
    cfg["_derived_from"] = base.name
    cfg["_derived_reason"] = "缺陷修复清理版专用（原片同 stem，勿混用）"

    out = Path(args.out)
    if not out.is_absolute():
        out = AE.ROOT / out
    out.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    AE.log(f"派生配置：{out}（source_dir = {src}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

# -*- coding: utf-8 -*-
"""批次清单生成器：把「品牌-商品-源素材」映射展开成渲染清单与审计清单。

用法：
  python scripts/auto-edit/batch_manifest.py \
    --groups runtime/auto-edit/batches/z-20261117.json \
    --source-dir "Z:\\暂时不用素材\\团购\\未剪素材" \
    --stage "Z:\\暂时不用素材\\团购\\已剪成片" \
    --out-list tmp/render_list.json \
    --out-items tmp/audit_items_z.json

groups 文件格式（批次固化石，一批评一份）：
  {
    "batch": "z-20261117",
    "note": "40 条，9 品牌 ×4 + 紫燕百味鸡 4",
    "items": [
      {"brand": "饭美滋", "product": "老北京片皮鸭", "stems": ["饭美滋北京烤鸭...", "... (1)", "... (2)", "... (3)"]},
      ...
    ]
  }

序号口径（AGENTS 规则 6）：stems 顺序即序号，base=01、(1)=02、(2)=03、(3)=04。
成片名 = 品牌-商品-序号.mp4。

只做清单，不渲染、不动文件。stem 里的空格与 ` (n)` 后缀按源文件原名一字不差照抄，
--source-dir 存在时逐条校验源文件；成片已存在则标 rendered=True，渲染 worker 会跳过。
"""
import argparse
import json
from pathlib import Path


def build(groups: dict, source_dir: Path | None, stage: Path | None):
    rows, problems = [], []
    for gi, g in enumerate(groups.get("items", []), start=1):
        brand, product = g["brand"], g["product"]
        stems = g["stems"]
        if not stems:
            problems.append(f"[组{gi}] {brand}-{product} 没有 stems")
        for idx, stem in enumerate(stems, start=1):
            name = f"{brand}-{product}-{idx:02d}.mp4"
            src_exists = None
            if source_dir is not None:
                src_exists = (source_dir / f"{stem}.mp4").exists()
                if not src_exists:
                    problems.append(f"[组{gi}] 源素材不存在：{stem}.mp4")
            rendered = None
            if stage is not None:
                rendered = (stage / name).exists()
            rows.append({"stem": stem, "name": name, "src_ok": src_exists, "rendered": rendered})
    return rows, problems


def main():
    ap = argparse.ArgumentParser(description="生成批次渲染清单与审计清单")
    ap.add_argument("--groups", required=True, help="批次 groups JSON")
    ap.add_argument("--source-dir", default=None, help="源素材目录（给了就校验存在）")
    ap.add_argument("--stage", default=None, help="成片目录（给了就标记已渲染）")
    ap.add_argument("--out-list", required=True, help="渲染清单输出 JSON")
    ap.add_argument("--out-items", default=None, help="审计清单输出 JSON")
    args = ap.parse_args()

    groups = json.loads(Path(args.groups).read_text(encoding="utf-8"))
    source_dir = Path(args.source_dir) if args.source_dir else None
    stage = Path(args.stage) if args.stage else None
    rows, problems = build(groups, source_dir, stage)

    Path(args.out_list).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out_list).write_text(
        json.dumps([{"stem": r["stem"], "name": r["name"]} for r in rows], ensure_ascii=False, indent=2),
        encoding="utf-8")

    if args.out_items:
        Path(args.out_items).write_text(
            json.dumps([{"out": r["name"], "src": [r["stem"] + ".mp4"]} for r in rows],
                       ensure_ascii=False, indent=2), encoding="utf-8")

    done = sum(1 for r in rows if r["rendered"])
    print(f"清单 {len(rows)} 条，已成片 {done} 条，待渲 {len(rows) - done} 条")
    if problems:
        print("问题：")
        for p in problems:
            print(" -", p)
        raise SystemExit(1)


if __name__ == "__main__":
    main()

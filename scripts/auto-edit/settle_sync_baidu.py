"""百度同步盘素材的归位脚本（宝哥 2026-11-14 固化）。

这条流水线只归位、不入项目发布队列：
  成片  -> D:\\BaiduSyncdisk\\@同步\\团购\\已剪成片\\品牌-商品-序号.mp4
  源素材 -> D:\\BaiduSyncdisk\\@同步\\团购\\未剪素材\\已剪素材\\

默认 dry-run，只打印计划；加 --apply 才真正复制/移动文件。
绝不写 D:\\@kaifa\\tuangou\\素材库\\已剪成片（那是项目内素材的自动发布队列）。

用法：
  python scripts/auto-edit/settle_sync_baidu.py --batch-dir runtime/auto-edit/out-baidu-20261113
  python scripts/auto-edit/settle_sync_baidu.py --batch-dir ... --apply
"""
import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "runtime" / "auto-edit" / "work"
BRAND_INDEX = ROOT / "runtime" / "auto-edit" / "brand_index.json"
PROJECT_QUEUE = ROOT / "素材库" / "已剪成片"


def load_batch(batch_dir: Path, done_dir: Path):
    """找出属于本批的 work/meta.json。

    state=in_batch：meta.output 还指向批次输出目录，需要复制到成片目录；
    state=already ：meta.output 已经指向成片目录且文件在，属已归位（用于复核/补漏）。
    """
    rows = []
    for mp in WORK.glob("*/meta.json"):
        try:
            m = json.loads(mp.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"  [跳过] {mp} 读取失败: {e}")
            continue
        out = m.get("output")
        if not out:
            continue
        op = Path(out)
        if op.parent == batch_dir:
            state, src = "in_batch", op
        elif op.parent == done_dir and op.exists():
            state, src = "already", None
        else:
            continue
        b = m.get("brand") or {}
        rows.append({
            "work": mp.parent,
            "clip": m.get("clip"),
            "output": op,
            "src": src,
            "state": state,
            "brand": b.get("brand"),
            "product": b.get("product"),
            "verify_ok": bool((m.get("verify") or {}).get("ok")),
        })
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch-dir", required=True, help="本批渲染输出目录（meta.output 所在目录）")
    ap.add_argument("--done-dir", default=r"D:\BaiduSyncdisk\@同步\团购\已剪成片")
    ap.add_argument("--source-dir", default=r"D:\BaiduSyncdisk\@同步\团购\未剪素材")
    ap.add_argument("--archive-dir", default=r"D:\BaiduSyncdisk\@同步\团购\未剪素材\已剪素材")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    batch_dir = Path(args.batch_dir)
    if not batch_dir.is_absolute():
        batch_dir = (ROOT / batch_dir)
    batch_dir = batch_dir.resolve()
    done_dir = Path(args.done_dir).resolve()
    source_dir = Path(args.source_dir).resolve()
    archive_dir = Path(args.archive_dir).resolve()

    if not batch_dir.exists():
        sys.exit(f"批次目录不存在: {batch_dir}")

    rows = load_batch(batch_dir, done_dir)
    if not rows:
        sys.exit(f"{batch_dir} 与 {done_dir} 都没有匹配的 meta.output，检查批次目录是否正确")
    pending = [r for r in rows if r["state"] == "in_batch"]

    problems = []
    for r in rows:
        if r["src"] and not r["src"].exists():
            problems.append(f"成片缺失: {r['output'].name}")
        if not r["brand"] or not r["product"]:
            problems.append(f"品牌/商品为空: {r['output'].name} -> brand={r['brand']} product={r['product']}")
        if not r["output"].name.startswith(f"{r['brand']}-{r['product']}-"):
            problems.append(f"命名不符规范: {r['output'].name}（应为 {r['brand']}-{r['product']}-NN.mp4）")
        if not r["verify_ok"]:
            problems.append(f"自检未通过: {r['output'].name}")

    print(f"批次 {batch_dir}")
    print(f"  本批 meta {len(rows)} 条：待归位 {len(pending)} 条，已在成片目录 {len(rows) - len(pending)} 条")
    print(f"  成片 -> {done_dir}")
    print(f"  源素材 -> {archive_dir}")
    if problems:
        print("\n有问题的条目：")
        for p in problems:
            print("  -", p)
        if "缺失" in " ".join(problems):
            sys.exit("存在缺失成片，先补渲再归位")

    # 源素材：只动顶层 mp4（已剪素材里已有的老文件不碰）
    srcs = sorted([p for p in source_dir.glob("*.mp4") if p.is_file()])
    print(f"  待归档源素材 {len(srcs)} 条")

    if PROJECT_QUEUE in done_dir.parents or done_dir == PROJECT_QUEUE:
        sys.exit("目标目录不能是项目发布队列；百度盘线的成片不进素材库/已剪成片")

    if not args.apply:
        print("\n[dry-run] 未复制/未移动；确认无误后加 --apply")
        return

    done_dir.mkdir(parents=True, exist_ok=True)
    archive_dir.mkdir(parents=True, exist_ok=True)

    copied = skipped = 0
    for r in pending:
        dest = done_dir / r["output"].name
        if dest.exists():
            skipped += 1
        else:
            shutil.copy2(r["src"], dest)
            copied += 1
    print(f"成片复制 {copied} 条，已存在跳过 {skipped} 条")

    moved_src = 0
    for s in srcs:
        target = archive_dir / s.name
        if target.exists():
            print("  源素材已在归档目录，留原地:", s.name)
            continue
        shutil.move(str(s), str(target))
        moved_src += 1
    print(f"源素材归档 {moved_src} 条")

    # meta.output 指向成片实际位置
    updated = 0
    for r in rows:
        mp = r["work"] / "meta.json"
        m = json.loads(mp.read_text(encoding="utf-8"))
        want = str(done_dir / r["output"].name)
        if m.get("output") != want:
            m["output"] = want
            mp.write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")
            updated += 1
    print(f"meta.output 更新 {updated} 条")

    # brand_index 同步
    if BRAND_INDEX.exists():
        idx = json.loads(BRAND_INDEX.read_text(encoding="utf-8"))
        names = {r["output"].name for r in rows}
        cnt = 0

        def walk(o):
            nonlocal cnt
            if isinstance(o, dict):
                for k, v in o.items():
                    if isinstance(v, str) and v.endswith(".mp4"):
                        p = Path(v)
                        if p.name in names and p.parent.resolve() == batch_dir:
                            o[k] = str(done_dir / p.name)
                            cnt += 1
                    elif isinstance(v, (dict, list)):
                        walk(v)
            elif isinstance(o, list):
                for it in o:
                    walk(it)

        walk(idx)
        if cnt:
            BRAND_INDEX.write_text(json.dumps(idx, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"brand_index 更新 {cnt} 条")

    print(f"\n完成：成片在 {done_dir}（{len(list(done_dir.glob('*.mp4')))} 个 mp4），源素材已归档 {archive_dir}")
    print("提醒：这条线不进自动发布队列，发布由宝哥自己处理。")


if __name__ == "__main__":
    main()

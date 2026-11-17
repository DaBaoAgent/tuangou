#!/usr/bin/env python3
"""把烧录字幕 OCR 草稿的行时间 + 口播 ASR 的文字合成校对稿。

做法：每个 ASR 段按「与哪一行烧录字幕时间重叠最多」归到那一行，
行文本取归到该行的 ASR 文本（烧录字幕本身常带 AI 错字，口播文本更可靠）；
ASR 没覆盖到的行保留 OCR 原文，供人工复核。

用法：
  python scripts/auto-edit/align_corrections_asr.py \
      --config runtime/auto-edit/config-z-new.json \
      --corrections-dir runtime/auto-edit/corrections-z \
      --dir "Z:/暂时不用素材/团购/未剪素材"
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import auto_edit  # noqa: E402


def overlap(a0, a1, b0, b1):
    return max(0.0, min(a1, b1) - max(a0, b0))


def align(ocr_lines, asr, dur=15.0):
    """烧录字幕有行的地方用校对稿原文；没有烧录字幕的时间段用口播 ASR 补齐成行。

    素材里的烧录字幕常是 AI 生成、偶发整段缺字（如某条中段 5–12 秒没字），
    只靠画面 OCR 会漏口播。这里按「覆盖 / 未覆盖」切分：
      - 覆盖到字幕行的时间：行时间用字幕的真实起止；
      - 没覆盖的时间：ASR 逐字时间按停顿/行长重新切行。
    """
    chars = []
    for seg in asr:
        for w in seg.get("words") or []:
            ch = (w.get("w") or w.get("word") or "").strip()
            if ch:
                chars.append((float(w["start"]), float(w["end"]), ch))

    covered = [[] for _ in ocr_lines]
    loose = []  # 落在所有字幕行之外的逐字
    for s, e, ch in chars:
        best, best_ov = None, 0.0
        for i, ln in enumerate(ocr_lines):
            ov = overlap(s, e, float(ln["start"]), float(ln["end"]))
            if ov > best_ov:
                best, best_ov = i, ov
        if best is not None:
            covered[best].append(ch)
        else:
            loose.append((s, e, ch))

    # 未覆盖区先按停顿切行
    groups, cur = [], []
    for s, e, ch in loose:
        if cur:
            gap = s - cur[-1][1]
            if gap > 0.24 or len(cur) >= 12:
                groups.append(cur)
                cur = []
        cur.append((s, e, ch))
    if cur:
        groups.append(cur)

    filled = []
    for grp in groups:
        text = auto_edit.clean_text("".join(c for _, _, c in grp))
        if len(text) < 2:
            continue
        start = max(0.0, grp[0][0] - 0.05)
        end = min(dur, grp[-1][1] + 0.12)
        if end - start < 0.5:
            continue  # 半秒都不到的补行是 ASR 抖动，不是口播
        if any(k in text for k in ("点赞", "订阅", "关注一下", "谢谢观看")):
            continue  # whisper 结尾幻觉
        filled.append({"text": text, "start": round(start, 2), "end": round(end, 2),
                       "kind": "fill"})

    out = []
    for ln, parts in zip(ocr_lines, covered):
        src_text = auto_edit.clean_text(ln["text"])
        asr_text = auto_edit.clean_text("".join(parts))
        out.append({
            "text": src_text or asr_text,
            "start": round(float(ln["start"]), 2),
            "end": round(float(ln["end"]), 2),
            "kind": "sub" if src_text else "asr",
            "_asr": asr_text,
        })
    out = [x for x in out if x["text"]]
    # 0.35 秒以下、又不是完整词的碎行（画面闪字噪声）不上字幕
    out = [x for x in out if (x["end"] - x["start"]) >= 0.35 or len(x["text"]) >= 3]
    out += filled
    out.sort(key=lambda x: x["start"])

    # 行尾别压到下一行开头
    for i, ln in enumerate(out):
        if i + 1 < len(out):
            ln["end"] = round(min(ln["end"], max(ln["start"] + 0.3, out[i + 1]["start"])), 2)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="runtime/auto-edit/config.json")
    ap.add_argument("--corrections-dir", default="runtime/auto-edit/corrections-z")
    ap.add_argument("--dir")
    ap.add_argument("--video", action="append")
    ap.add_argument("--out-dir", help="默认写回 corrections-dir")
    args = ap.parse_args()

    cfg = auto_edit.load_config(args.config)
    work_root = Path(cfg["paths"]["work_dir"])
    corr_dir = Path(args.corrections_dir)
    out_dir = Path(args.out_dir) if args.out_dir else corr_dir

    videos = []
    if args.video:
        videos += [Path(v) for v in args.video]
    if args.dir:
        for ext in ("*.mp4", "*.MP4", "*.mov", "*.MOV"):
            videos += sorted(Path(args.dir).glob(ext))

    for video in videos:
        corr_path = corr_dir / f"{video.stem}.json"
        asr_path = work_root / video.stem / "asr.json"
        if not corr_path.exists() or not asr_path.exists():
            print(f"[skip] {video.name}（缺校对稿或 asr.json）")
            continue
        data = json.loads(corr_path.read_text(encoding="utf-8"))
        ocr_lines = data.get("lines") or []
        asr = json.loads(asr_path.read_text(encoding="utf-8"))
        lines = align(ocr_lines, asr, dur=auto_edit.source_duration(video))
        payload = {"lines": [{k: v for k, v in ln.items() if not k.startswith("_")}
                             for ln in lines],
                   "_source": "legacy_ocr+asr", "_draft": True, "_video": video.name}
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / f"{video.stem}.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"== {video.name}")
        for ln in lines:
            flag = "  [补ASR]" if ln["kind"] == "fill" else ""
            print(f"  {ln['start']:5.2f}-{ln['end']:5.2f}  {ln['text']}{flag}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

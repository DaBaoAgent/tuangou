#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""缺陷段切割：把源片里不该出现的整段（念出的脚本备注、错口令等）连画面带音频切掉，生成高质量清理版。

不是删字幕行（规则 7），是把整段内容拿掉：视频 trim+setpts、音频 atrim+asetpts 后 concat，libx264 重编码。

用法（默认 dry-run，只打印方案）：
  py scripts/auto-edit/repair_cut.py --stem "海底捞15秒AI带货视频脚本（女生出镜）" \
     --cut 7.20-9.50 --source-dir "Z:\暂时不用素材\团购\未剪素材" --out-dir tmp/clean_haidilao
  # 确认真实落盘加 --apply；多段用逗号分隔 --cut "1.0-2.0,5.0-6.2"；--pad 每段两侧余量（默认 0.12s）

产物：<out-dir>/<stem>.mp4 与 <out-dir>/<stem>.repair.json（切点、保留段、时长、素材签名）。
清理版与原件同 stem，务必用 stage_config.py 生成指向 out-dir 的配置再跑 OCR/渲染，否则会渲染回原件。
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import auto_edit as AE


def parse_ranges(spec, pad):
    out = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        a, b = part.replace("~", "-").split("-")
        out.append([max(0.0, float(a) - pad), float(b) + pad])
    return out


def keep_segments(dur, cuts):
    keep, cur = [], 0.0
    for a, b in sorted(cuts):
        a, b = min(a, dur), min(b, dur)
        if a > cur:
            keep.append([cur, a])
        cur = max(cur, b)
    if dur - cur > 0.3:
        keep.append([cur, dur])
    return keep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stem", required=True, help="源素材文件名（不含 .mp4）")
    ap.add_argument("--cut", required=True, help='要切掉的时间段 "7.20-9.50" 或 "1-2,5-6.2"')
    ap.add_argument("--source-dir", default=None, help="源素材目录，缺省取 config paths.source_dir")
    ap.add_argument("--out-dir", required=True, help="清理版输出目录")
    ap.add_argument("--config", default=None, help="配置路径，缺省 runtime/auto-edit/config.json")
    ap.add_argument("--pad", type=float, default=0.12, help="每段两侧多留的余量（秒）")
    ap.add_argument("--crf", type=int, default=16)
    ap.add_argument("--preset", default="slow")
    ap.add_argument("--apply", action="store_true", help="真切割；不给则只打印方案")
    args = ap.parse_args()

    cfg = AE.load_config(args.config)
    src_dir = Path(args.source_dir or cfg["paths"]["source_dir"])
    src = src_dir / f"{args.stem}.mp4"
    if not src.exists():
        raise SystemExit(f"找不到源素材：{src}")

    dur = AE.source_duration(src)
    cuts = parse_ranges(args.cut, args.pad)
    keep = keep_segments(dur, cuts)
    if not keep:
        raise SystemExit("切完没有剩余内容，检查 --cut")
    new_dur = sum(b - a for a, b in keep)

    AE.log(f"源 {src.name} {dur:.2f}s → 切掉 {len(cuts)} 段，保留 {len(keep)} 段，预计 {new_dur:.2f}s")
    for a, b in cuts:
        AE.log(f"  cut {a:.2f}-{b:.2f} ({b - a:.2f}s)")
    for a, b in keep:
        AE.log(f"  keep {a:.2f}-{b:.2f} ({b - a:.2f}s)")

    out_dir = Path(args.out_dir)
    if out_dir.is_absolute() is False:
        out_dir = AE.ROOT / out_dir
    out = out_dir / f"{args.stem}.mp4"
    if not args.apply:
        AE.log(f"[dry-run] 将写 {out}；确认后加 --apply")
        return 0

    out_dir.mkdir(parents=True, exist_ok=True)
    filt = []
    labels = []
    for i, (a, b) in enumerate(keep):
        filt.append(f"[0:v]trim=start={a:.3f}:end={b:.3f},setpts=PTS-STARTPTS[v{i}]")
        filt.append(f"[0:a]atrim=start={a:.3f}:end={b:.3f},asetpts=PTS-STARTPTS[a{i}]")
        labels.append(f"[v{i}][a{i}]")
    filt.append("".join(labels) + f"concat=n={len(keep)}:v=1:a=1[vo][ao]")
    AE.ffmpeg(
        "-y", "-i", str(src), "-filter_complex", ";".join(filt), "-map", "[vo]", "-map", "[ao]",
        "-c:v", "libx264", "-crf", str(args.crf), "-preset", args.preset, "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out),
    )
    got = AE.source_duration(out)
    manifest = {
        "source": str(src), "source_duration": round(dur, 2),
        "cuts": [[round(a, 2), round(b, 2)] for a, b in cuts],
        "keep": [[round(a, 2), round(b, 2)] for a, b in keep],
        "out_duration": round(got, 2), "expected_duration": round(new_dur, 2),
        "crf": args.crf, "preset": args.preset, "pad": args.pad,
        "source_sig": AE.video_sig(src), "out_sig": AE.video_sig(out),
    }
    (out_dir / f"{args.stem}.repair.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    if abs(got - new_dur) > 0.35:
        AE.log(f"[warn] 输出 {got:.2f}s 与预期 {new_dur:.2f}s 差得有点多，建议抽帧复核")
    AE.log(f"清理版：{out}（{out.stat().st_size / 1048576:.1f} MB）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

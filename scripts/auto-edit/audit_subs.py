#!/usr/bin/env python3
"""成片字幕审计：逐条 OCR 对照人工校对稿，发版前做最后一道闸门。

用法：
  python scripts/auto-edit/audit_subs.py \
      --stage runtime/auto-edit/out-named-repair \
      --items C:/tmp/items.json \
      --corrections runtime/auto-edit/corrections-named \
      --report C:/tmp/audit.txt

items.json 两种写法：
  ["11月4日_xxx.mp4", ...]                          # 校对稿按成片名去扩展名查找
  [{"out": "x.mp4", "src": ["源素材.mp4"]}, ...]     # 校对稿按源素材名去扩展名查找

默认参数对应新版成片（1080×1920、字幕底边距 360、文字约在 y1464–1557）：
  逐行检查  crop=1080:400:0:1360 + 3x 放大
  全片扫描  crop=1080:280:0:1390 + 2x，每 1 秒一帧
  失败重查  crop=1080:130:0:1455 + 4x（避开背景大字/logo，专看字幕带）

老成片（字幕在 y≈1274–1358）用 --band-y 1150 --scan-y 1200 --tight-y 1250。
扫描里的 unexpected 多为背景招牌/logo 文字，需人工看报告确认；只有逐行检查
（含 tight 重查）失败才返回非零退出码。
"""
import argparse
import json
import subprocess
import sys
import tempfile
import urllib.request
from difflib import SequenceMatcher
from pathlib import Path

OCR_URL = "http://127.0.0.1:18224/api/ocr"
STATUS_URL = "http://127.0.0.1:18224/api/status"


def ocr(png):
    body = json.dumps({"path": str(png), "options": {"data.format": "dict"}}).encode()
    req = urllib.request.Request(OCR_URL, data=body, headers={"Content-Type": "application/json"})
    try:
        res = json.load(urllib.request.urlopen(req, timeout=60))
    except Exception as exc:  # noqa: BLE001 - report any OCR failure in the report
        return f"OCR_ERROR {exc}"
    if res.get("code") != 100:
        return ""
    data = res["data"]
    return data if isinstance(data, str) else " ".join(x.get("text", "") for x in data)


def clean(text):
    return "".join(ch for ch in text if ch.isalnum() or "\u4e00" <= ch <= "\u9fff")


def frame(video, t, crop, scale, out):
    vf = f"crop={crop},scale=iw*{scale}:-1:flags=lanczos"
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-ss", f"{t:.2f}", "-i", str(video),
         "-frames:v", "1", "-vf", vf, str(out)],
        check=True,
    )


def compare(expected, got):
    exp = clean(expected)
    got_c = clean(got)
    ratio = SequenceMatcher(None, exp, got_c).ratio()
    return (exp in got_c or ratio >= 0.6), ratio, got_c


def duration(video):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(video)],
        capture_output=True, text=True,
    ).stdout.strip()
    return float(out)


def main():
    ap = argparse.ArgumentParser(description="成片字幕审计（Dabao-OCR）")
    ap.add_argument("--stage", required=True, help="成片所在目录")
    ap.add_argument("--items", required=True, help="JSON 列表（文件名或 {out,src}）")
    ap.add_argument("--corrections", required=True, help="人工校对稿目录")
    ap.add_argument("--report", required=True, help="报告输出路径（UTF-8）")
    ap.add_argument("--band-y", type=int, default=1360)
    ap.add_argument("--band-h", type=int, default=400)
    ap.add_argument("--band-scale", type=int, default=3)
    ap.add_argument("--scan-y", type=int, default=1390)
    ap.add_argument("--scan-h", type=int, default=280)
    ap.add_argument("--scan-scale", type=int, default=2)
    ap.add_argument("--tight-y", type=int, default=1455)
    ap.add_argument("--tight-h", type=int, default=130)
    ap.add_argument("--tight-scale", type=int, default=4)
    ap.add_argument("--no-scan", action="store_true", help="跳过全片 1 秒扫描")
    args = ap.parse_args()

    try:
        urllib.request.urlopen(STATUS_URL, timeout=5)
    except Exception as exc:  # noqa: BLE001
        print(f"Dabao-OCR 未就绪（{STATUS_URL}）：{exc}", file=sys.stderr)
        print(r"D:/@kaifa/Dabao-OCR/scripts/serve.cmd", file=sys.stderr)
        return 2

    stage = Path(args.stage)
    corr_dir = Path(args.corrections)
    items = json.loads(Path(args.items).read_text(encoding="utf-8"))
    tmp = Path(tempfile.gettempdir())
    report = []
    failures = 0

    for item in items:
        if isinstance(item, dict):
            name = item["out"]
            src = item.get("src") or [name]
            stem = Path(src[0]).stem
        else:
            name = str(item)
            stem = Path(name).stem
        video = stage / name
        corr_path = corr_dir / f"{stem}.json"
        if not video.exists():
            report.append(f"## {name}\nMISSING_VIDEO")
            failures += 1
            continue
        if not corr_path.exists():
            report.append(f"## {name}\nNO_CORR {corr_path.name}")
            failures += 1
            continue

        lines = json.loads(corr_path.read_text(encoding="utf-8"))["lines"]
        bad = []
        scan_flags = []
        tight_ok = 0
        for i, ln in enumerate(lines):
            t = (ln["start"] + ln["end"]) / 2
            png = tmp / f"audit_{stem[:10]}_{i:02d}.png"
            crop = f"1080:{args.band_h}:0:{args.band_y}"
            frame(video, t, crop, args.band_scale, png)
            ok, ratio, got = compare(ln["text"], ocr(png))
            if not ok:
                tight = tmp / f"audit_{stem[:10]}_{i:02d}_tight.png"
                crop_t = f"1080:{args.tight_h}:0:{args.tight_y}"
                frame(video, t, crop_t, args.tight_scale, tight)
                ok2, ratio2, got2 = compare(ln["text"], ocr(tight))
                if ok2:
                    tight_ok += 1
                else:
                    bad.append(f"line t={t:.2f} expect={clean(ln['text'])} "
                               f"got={got} r={ratio:.2f} | tight got={got2} r={ratio2:.2f}")

        if not args.no_scan:
            dur = duration(video)
            t = 0.4
            while t < dur - 0.2:
                active = [clean(ln["text"]) for ln in lines
                          if ln["start"] - 0.15 <= t <= ln["end"] + 0.15]
                png = tmp / f"audit_{stem[:10]}_scan.png"
                crop = f"1080:{args.scan_h}:0:{args.scan_y}"
                frame(video, t, crop, args.scan_scale, png)
                got = clean(ocr(png))
                best = max((SequenceMatcher(None, a, got).ratio() for a in active), default=0.0)
                if got and best < 0.45:
                    scan_flags.append(
                        f"SCAN t={t:.2f} got={got} active={active} best={best:.2f}")
                t += 1.0

        if bad:
            failures += 1
        note = f" tight_recheck={tight_ok}" if tight_ok else ""
        scan_note = f" scan_flags={len(scan_flags)}" if scan_flags else ""
        body = bad + scan_flags
        head = ("OK（扫描命中多为背景招牌/logo，需人工确认）"
                if not bad else "LINE_FAIL")
        report.append(f"## {name} lines={len(lines)} bad={len(bad)}{note}{scan_note}\n{head}"
                      + (("\n" + "\n".join(body)) if body else ""))

    Path(args.report).write_text("\n\n".join(report), encoding="utf-8")
    print(f"DONE files={len(items)} failed={failures} report={args.report}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

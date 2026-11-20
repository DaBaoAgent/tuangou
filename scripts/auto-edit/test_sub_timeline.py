#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""字幕时间轴回归（2026-11-19 固化）：stabilize_lines / normalize_cover_bars 必须保证
「字幕连续、不空档、不重叠、不闪光」——宝哥「字幕不要一跳一跳的」。

跑法：py scripts/auto-edit/test_sub_timeline.py      （全 PASS 退出码 0）
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import auto_edit as AE

CFG = {
    "subtitle": {"min_duration": 0.8, "max_chars": 12, "font_size": 112, "margin_v": 552},
    "video": {"width": 1080, "height": 1920},
    "legacy_sub": {"cover_pad": 18},
}

CASES = []


def case(fn):
    CASES.append(fn)
    return fn


def gaps(lines):
    return [round(float(b["start"]) - float(a["end"]), 3) for a, b in zip(lines, lines[1:])]


def overlaps(lines):
    return [round(float(a["end"]) - float(b["start"]), 3)
            for a, b in zip(lines, lines[1:]) if float(b["start"]) < float(a["end"]) - 1e-6]


@case
def t_gaps_are_closed():
    # 复现历史校对稿的真实形态：句子之间空 0.3~6.7s
    src = [{"text": "越嚼越香", "start": 0.0, "end": 1.86},
           {"text": "这个越嚼越香", "start": 2.18, "end": 4.38},
           {"text": "撒粉一拌", "start": 5.18, "end": 5.98},
           {"text": "追剧解馋都合适", "start": 12.68, "end": 14.20},
           {"text": "想吃就来试试", "start": 14.22, "end": 14.80}]
    out = AE.stabilize_lines(src, 15.07, CFG)
    assert not [g for g in gaps(out) if g > 0.001], f"仍有空档: {gaps(out)}"
    assert not overlaps(out), f"出现重叠: {overlaps(out)}"
    assert out[0]["start"] == 0.0, f"首行未从 0 起: {out[0]}"
    assert out[-1]["end"] >= 14.8, f"尾行被截短: {out[-1]}"


@case
def t_no_overlap_after_borrow():
    # 末两行贴太近，强制最短展示时最容易叠字
    src = [{"text": "想团就别等啦", "start": 9.94, "end": 10.12},
           {"text": "直接囤这一桌", "start": 10.12, "end": 11.54}]
    out = AE.stabilize_lines(src, 11.54, CFG)
    assert not overlaps(out), f"重叠: {out}"
    assert not [g for g in gaps(out) if g > 0.001], f"空档: {gaps(out)}"


@case
def t_short_line_not_a_flash():
    out = AE.stabilize_lines([{"text": "宝子们", "start": 0.05, "end": 0.20},
                              {"text": "今天这家真的别错过", "start": 0.20, "end": 3.0}], 3.0, CFG)
    assert out[0]["end"] - out[0]["start"] >= 0.79, f"首行一闪而过: {out[0]}"
    assert not overlaps(out) and not [g for g in gaps(out) if g > 0.001]


@case
def t_fragments_merge_without_overflow():
    # 0.3s 碎片应与上一行合并，但不能超过 max_chars 导致缩字
    out = AE.stabilize_lines([{"text": "别被它的外表骗了", "start": 0.0, "end": 1.45},
                              {"text": "吃一口", "start": 1.45, "end": 1.75}], 15.07, CFG)
    merged = "".join(x["text"] for x in out)
    assert "吃一口" in merged
    for ln in out:
        assert len(ln["text"]) <= 12, f"合并超字数: {ln['text']}"


@case
def t_empty_is_noop():
    assert AE.stabilize_lines([], 15.0, CFG) == []
    assert AE.stabilize_lines([{"text": ""}], 15.0, CFG) == []


@case
def t_never_after_dur():
    out = AE.stabilize_lines([{"text": "最后一句在这里", "start": 14.5, "end": 20.0}], 15.07, CFG)
    for ln in out:
        assert ln["end"] <= 15.07 + 1e-6, f"越过片尾: {ln}"


@case
def t_cover_merges_short_gaps():
    bars = [{"y0": 1460, "y1": 1540, "t0": 0.0, "t1": 3.0},
            {"y0": 1461, "y1": 1541, "t0": 3.5, "t1": 6.0}]
    out = AE.normalize_cover_bars(bars, 15.07)
    assert len(out) == 1, f"0.5s 断口未合并: {out}"
    assert out[0]["t0"] <= 0.001 and out[0]["t1"] >= 15.0, f"未铺满全片: {out}"


@case
def t_cover_keeps_two_layers_separate():
    # 上下两层不能并成一大块，否则整块画面被糊掉
    bars = [{"y0": 420, "y1": 500, "t0": 0.0, "t1": 4.0},
            {"y0": 1460, "y1": 1540, "t0": 0.0, "t1": 4.0}]
    out = AE.normalize_cover_bars(bars, 15.07)
    assert len(out) == 2, f"上下两层被并成一块: {out}"
    assert not (out[0]["y0"] < out[1]["y0"] < out[0]["y1"])


@case
def t_cover_partial_extends_to_edges():
    bars = [{"y0": 1470, "y1": 1550, "t0": 4.0, "t1": 6.0}]
    out = AE.normalize_cover_bars(bars, 15.07)
    assert out[0]["t0"] == 0.0 and out[0]["t1"] >= 15.0, f"未延伸到首尾: {out}"


@case
def t_cover_empty():
    assert AE.normalize_cover_bars([], 15.0) == []
    assert AE.normalize_cover_bars(None, 15.0) == []


def main():
    failed = 0
    for fn in CASES:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"FAIL {fn.__name__}: {exc}")
    print(f"\n{len(CASES) - failed}/{len(CASES)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

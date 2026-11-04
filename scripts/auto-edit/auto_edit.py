#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抖音团购素材自动剪辑流水线。

一条素材 -> 一条成片：
  检测素材是否自带烧录字幕 -> 有字幕的跳过字幕环节（不加黑条、不叠字幕），
  没有字幕的按口播识别生成逐句字幕（思源黑体加粗、白字、细黑描边、一行一句、无标点）
  -> 识别团购品牌（人工覆盖 > 画面 OCR > 口播，识别不到标人工复核）
  -> 片头白线冲刺特效 + whoosh 音效 -> 垫热门 BGM -> 1080x1920 / 30fps 导出。

用法：
  python scripts/auto-edit/auto_edit.py --list
  python scripts/auto-edit/auto_edit.py --clip 06E7424A --no-move
  python scripts/auto-edit/auto_edit.py --clip 06E7424A --no-move --name 11月1日_炸鸡.mp4
  python scripts/auto-edit/auto_edit.py --all --no-move
  python scripts/auto-edit/auto_edit.py --brand-scan        # 只识别品牌不剪片

字幕人工校对：在 runtime/auto-edit/corrections/<素材文件名去扩展名>.json 写入
  {"lines": [{"text": "...", "start": 0.0, "end": 1.4}, ...]}
存在该文件时优先使用，便于修正 ASR 错字与断句；仅对无自带字幕的素材生效。
"""

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = Path(__file__).resolve().parent / "config.json"
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".mkv"}

import brand_ocr  # noqa: E402  （同目录模块）
import fx as opening_fx  # noqa: E402  （同目录模块）

PUNCT_RE = re.compile(
    r"[，。！？、；：,.!?;:'\"“”‘’（）()【】\[\]《》<>…—－\-~～·\s]+"
)
CJK_RE = re.compile(r"[\u4e00-\u9fff0-9A-Za-z]")


def log(msg):
    print(f"[auto-edit] {msg}", flush=True)


def load_config(path=None):
    with open(path or CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def run(cmd, cwd=ROOT, check=True, capture=True):
    res = subprocess.run(
        cmd,
        cwd=str(cwd),
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if check and res.returncode != 0:
        raise RuntimeError(
            f"命令失败 ({res.returncode}): {' '.join(map(str, cmd))}\n{res.stderr[-2000:]}"
        )
    return res


def ffmpeg(*args, cwd=ROOT):
    return run(["ffmpeg", "-hide_banner", "-y", *args], cwd=cwd)


def probe(path):
    res = run(
        [
            "ffprobe", "-v", "error", "-show_entries",
            "format=duration:stream=index,codec_type,codec_name,width,height,avg_frame_rate",
            "-of", "json", str(path),
        ]
    )
    return json.loads(res.stdout)


def source_duration(path):
    return float(probe(path)["format"]["duration"])


def clean_text(text):
    """保留中英文数字，去掉标点、空白与识别残渣。"""
    text = text.replace("\ufffd", "")
    text = PUNCT_RE.sub("", text)
    text = re.sub(r"[^\u4e00-\u9fff0-9A-Za-z]", "", text)
    return text.strip()


def find_clips(cfg, pattern=None, select_all=False):
    src = Path(cfg["paths"]["source_dir"])
    clips = []
    for p in sorted(src.iterdir()):
        if p.is_file() and p.suffix.lower() in VIDEO_EXTS:
            clips.append(p)
    clips = [p for p in clips if not p.name.startswith(".")]
    if select_all:
        return clips
    if pattern:
        key = pattern.lower()
        # 先做精确匹配，避免「11111」同时命中「1111111111」
        exact = [p for p in clips if key in (p.stem.lower(), p.name.lower())]
        if exact:
            return exact
        # 同时匹配 stem 和完整文件名，避免「1」误命中「脚本 (1).mp4」
        hits = [p for p in clips if key in p.stem.lower() or key in p.name.lower()]
        return hits
    return clips


def find_brand_clips(cfg, pattern=None):
    """品牌扫描同时覆盖未剪素材和已剪素材（已剪的也能补录品牌）。"""
    found = {}
    for key in ("source_dir", "done_source_dir"):
        d = Path(cfg["paths"][key])
        if not d.exists():
            continue
        for p in sorted(d.iterdir()):
            if p.is_file() and p.suffix.lower() in VIDEO_EXTS and not p.name.startswith("."):
                found.setdefault(p.stem, p)
    clips = sorted(found.values(), key=lambda p: p.name)
    if pattern:
        key = pattern.lower()
        clips = [p for p in clips if key in p.stem.lower()]
    return clips


def cached_asr_text(workdir):
    path = Path(workdir) / "asr.json"
    if not path.exists():
        return ""
    try:
        return "".join(x.get("text", "") for x in json.loads(path.read_text(encoding="utf-8")))
    except Exception:
        return ""


def pick_bgm(cfg, hint_text):
    bgm_dir = Path(cfg["paths"]["bgm_dir"])
    tracks = sorted([p for p in bgm_dir.iterdir() if p.suffix.lower() in {".mp3", ".m4a", ".wav", ".aac"}])
    if not tracks:
        raise RuntimeError(f"BGM 目录没有可用音频：{bgm_dir}")
    for rule in cfg["bgm"]["rules"]:
        if any(w in hint_text for w in rule["words"]):
            for t in tracks:
                if t.name == rule["track"]:
                    return t
    default = bgm_dir / cfg["bgm"]["default"]
    if default.exists():
        return default
    return tracks[0]


# ---------------------------------------------------------------- ASR

_MODEL = None


def get_model(cfg):
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    from faster_whisper import WhisperModel

    paths = cfg["paths"]
    local_turbo = Path(paths["fw_model_dir"]) / "local-turbo"
    local_dir = Path(paths["fw_model_dir"]) / ("models--" + paths["fw_model"].replace("/", "--"))
    if (local_turbo / "model.bin").exists():
        model_ref = str(local_turbo)
    elif local_dir.exists() and any(local_dir.rglob("model.bin")):
        model_ref = str(next(local_dir.rglob("model.bin")).parent)
    else:
        raise RuntimeError("faster-whisper 模型未就绪（缺 model.bin），使用 ffmpeg whisper 兜底")
    _MODEL = WhisperModel(
        model_ref,
        device="cpu",
        compute_type=cfg["asr"]["compute_type"],
        download_root=paths["fw_model_dir"],
    )
    return _MODEL


def transcribe_fallback(cfg, video, workdir):
    """faster-whisper 模型不可用时的兜底：ffmpeg 内置 whisper.cpp 模型，仅段级时间戳。"""
    model_path = Path("runtime/asr-models/ggml-large-v3-turbo.bin")
    if not model_path.exists():
        raise RuntimeError("没有可用的 ASR 模型（faster-whisper 与 ggml 均缺失）")
    srt = workdir / "asr_fallback.srt"
    # ffmpeg 滤镜参数里不能直接出现盘符冒号，统一转成项目内相对路径
    srt_rel = srt.relative_to(ROOT).as_posix()
    model_rel = model_path.as_posix()
    if not (srt.exists() and srt.stat().st_mtime >= video.stat().st_mtime and srt.stat().st_size > 100):
        ffmpeg(
            "-i", str(video), "-vn",
            "-af", f"whisper=model={model_rel}:language=zh:use_gpu=0:"
                   f"destination={srt_rel}:format=srt",
            "-f", "null", "-",
        )
    out = []
    for block in srt.read_text(encoding="utf-8").strip().split("\n\n"):
        parts = block.strip().splitlines()
        if len(parts) < 3:
            continue
        times = parts[1].split(" --> ")
        def ts(s):
            h, m, rest = s.split(":")
            sec, ms = rest.replace(",", ".").split(".")
            return int(h) * 3600 + int(m) * 60 + int(sec) + int(ms) / 1000
        out.append({
            "start": ts(times[0]),
            "end": ts(times[1]),
            "text": clean_text(" ".join(parts[2:])),
            "words": [],
        })
    return out


def transcribe(cfg, video, workdir):
    try:
        model = get_model(cfg)
    except Exception as exc:
        log(f"faster-whisper 不可用，改用 ffmpeg whisper 兜底：{exc}")
        return transcribe_fallback(cfg, video, workdir)
    wav = workdir / "asr.wav"
    if not wav.exists():
        ffmpeg("-i", str(video), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav))
    import wave

    import numpy as np

    with wave.open(str(wav), "rb") as wf:
        audio = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    segments, _info = model.transcribe(
        audio,
        language=cfg["asr"]["language"],
        vad_filter=True,
        word_timestamps=True,
        beam_size=cfg["asr"]["beam_size"],
        initial_prompt=cfg["asr"]["initial_prompt"],
    )
    out = []
    for seg in segments:
        words = []
        for w in seg.words or []:
            t = clean_text(w.word)
            if t:
                words.append({"w": t, "start": float(w.start), "end": float(w.end)})
        out.append(
            {
                "start": float(seg.start),
                "end": float(seg.end),
                "text": clean_text(seg.text),
                "words": words,
            }
        )
    return out


def to_simplified(lines):
    try:
        import opencc

        conv = opencc.OpenCC("t2s")
        for ln in lines:
            ln["text"] = conv.convert(ln["text"])
            for w in ln.get("words", []):
                w["w"] = conv.convert(w["w"])
    except Exception as exc:  # opencc 缺失时保持原样，不阻断成片
        log(f"opencc 不可用，保留原文：{exc}")


# ---------------------------------------------------------------- captions

HALLUCINATION_PATTERNS = ("谢谢大家", "感谢观看", "字幕由", "请订阅", "优优独播", "yoyo")


def is_hallucination(text, start, dur):
    t = text.lower()
    if any(p in t for p in HALLUCINATION_PATTERNS):
        return True
    if start > dur - 0.25 and len(text) <= 6:
        return True
    return False


def split_words(words, max_chars, min_chars):
    """把超长短语按词边界均分成若干行，尽量每行长度接近。"""
    total = sum(len(w["w"]) for w in words)
    if total <= max_chars:
        return [words]
    k = max(2, math.ceil(total / max_chars))
    chunks, pos = [], 0
    for ci in range(k - 1):
        remaining = sum(len(w["w"]) for w in words[pos:])
        target = remaining / (k - ci)
        best = None
        clen = 0
        for j in range(pos, len(words)):
            clen += len(words[j]["w"])
            if clen > max_chars:
                break
            rest = sum(len(w["w"]) for w in words[j + 1:])
            if rest < min_chars:
                continue
            score = abs(clen - target)
            if best is None or score < best[0] - 1e-9 or (
                abs(score - best[0]) < 1e-9 and j < best[1]
            ):
                best = (score, j, clen)
        if best is None:
            break
        _, j, _clen = best
        chunks.append(words[pos:j + 1])
        pos = j + 1
    if pos < len(words):
        chunks.append(words[pos:])
    return chunks


def build_lines(asr, dur, cfg):
    sub = cfg["subtitle"]
    max_chars = sub["max_chars"]
    min_chars = sub["min_chars"]
    lines = []

    def add(text, start, end):
        text = clean_text(text)
        if len(text) < 1:
            return
        start = max(0.0, min(start, dur))
        end = max(start + 0.3, min(end, dur))
        lines.append({"text": text, "start": round(start, 3), "end": round(end, 3)})

    def add_proportional(text, start, end):
        """没有词级时间戳时，按字数切块并按时长比例分配。"""
        text = clean_text(text)
        if not text:
            return
        if len(text) <= max_chars:
            add(text, start, end)
            return
        k = math.ceil(len(text) / max_chars)
        size = math.ceil(len(text) / k)
        pieces = [text[i:i + size] for i in range(0, len(text), size)]
        total = max(end - start, 0.3)
        pos = start
        for piece in pieces:
            seg_len = total * len(piece) / len(text)
            add(piece, pos, pos + seg_len)
            pos += seg_len

    # 先按停顿把整段口播切成自然短语（>=0.33s 视为换气/断句），再按字数拆超长短语
    all_words = []
    for seg in asr:
        if is_hallucination(seg["text"], seg["start"], dur):
            continue
        if not seg["words"]:
            add_proportional(seg["text"], seg["start"], min(seg["end"], dur))
            continue
        all_words.extend(w for w in seg["words"] if w["start"] < dur)

    # 断句点 = 停顿边界（>=0.30s 视为换气/断句）
    breaks = set()
    for i in range(len(all_words) - 1):
        if all_words[i + 1]["start"] - all_words[i]["end"] >= 0.30:
            breaks.add(i)

    phrases = []
    cur = []
    for i, w in enumerate(all_words):
        cur.append(w)
        if i in breaks:
            phrases.append(cur)
            cur = []
    if cur:
        phrases.append(cur)

    for phrase in phrases:
        total = sum(len(w["w"]) for w in phrase)
        if total <= max_chars:
            add("".join(w["w"] for w in phrase), phrase[0]["start"], phrase[-1]["end"])
            continue
        chunks = split_words(phrase, max_chars, min_chars)
        for chunk in chunks:
            add("".join(w["w"] for w in chunk), chunk[0]["start"], chunk[-1]["end"])

    # 合并过短的相邻字幕（同一口气说出的短句）
    merged = []
    for ln in lines:
        if (
            merged
            and merged[-1]["end"] >= ln["start"] - 0.12
            and len(merged[-1]["text"]) + len(ln["text"]) <= max_chars
            and merged[-1]["text"] != ln["text"]
        ):
            merged[-1]["text"] += ln["text"]
            merged[-1]["end"] = max(merged[-1]["end"], ln["end"])
        else:
            merged.append(ln)
    lines = merged

    # 时间轴整理：不重叠、补最短展示时长
    for i, ln in enumerate(lines):
        limit = lines[i + 1]["start"] - 0.02 if i + 1 < len(lines) else dur
        ln["start"] = max(0.0, ln["start"])
        ln["end"] = min(max(ln["end"], ln["start"] + sub["min_duration"]), limit, dur)
    out = [ln for ln in lines if ln["end"] - ln["start"] >= 0.25]
    for ln in out:
        ln["start"] = round(ln["start"], 3)
        ln["end"] = round(ln["end"], 3)
    return out


def ass_time(t):
    t = max(0.0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def build_ass(cfg, lines):
    sub = cfg["subtitle"]
    w = cfg["video"]["width"]
    h = cfg["video"]["height"]
    max_width = sub["max_width"]
    fs = sub["font_size"]
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,{sub['font_name']},{fs},&H00{sub['fill']},&H00FFFFFF,&H00{sub['outline_color']},&H00000000,{sub['font_bold']},0,0,0,100,100,0,0,1,{sub['outline']},{sub['shadow']},2,40,40,{sub['margin_v']},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = []
    for ln in lines:
        text = ln["text"].replace("{", "（").replace("}", "）")
        scale = 100.0
        if len(text) * fs > max_width:
            scale = max(60.0, max_width / len(text) / fs * 100.0)
        tag = f"{{\\fscx{scale:.0f}}}" if scale < 99.9 else ""
        events.append(
            f"Dialogue: 1,{ass_time(ln['start'])},{ass_time(ln['end'])},Cap,,0,0,0,,{tag}{text}"
        )
    return header + "\n".join(events) + "\n"


# ---------------------------------------------------------------- legacy subtitle bar

def detect_legacy_bars(cfg, video, workdir, dur):
    """检测素材里自带的烧录字幕带。

    返回 [{y0, y1, t0, t1}]（1080x1920 坐标）。素材常见「上层白字 + 下层黄字 AI 字幕」
    两层，出现时段可能不同。返回值只用于判断是否需要跳过字幕环节，不再绘制黑条。
    """
    ls = cfg["legacy_sub"]
    frames_dir = workdir / "legacy_frames"
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir(parents=True)
    ffmpeg(
        "-i", str(video),
        "-vf", f"fps={ls['sample_fps']},scale=360:640",
        "-q:v", "4", str(frames_dir / "%03d.jpg"),
    )
    files = sorted(frames_dir.glob("*.jpg"))
    if not files:
        return []

    import numpy as np
    from PIL import Image

    H = W = None
    per_frame = []
    for f in files:
        im = Image.open(f).convert("RGB")
        W, H = im.size
        a = np.asarray(im).astype(np.int16)
        r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
        v = a.max(axis=2)
        mn = a.min(axis=2)
        dark = v < 85
        nb = np.zeros_like(dark)
        nb[2:, :] |= dark[:-2, :]
        nb[:-2, :] |= dark[2:, :]
        nb[:, 2:] |= dark[:, :-2]
        nb[:, :-2] |= dark[:, 2:]
        core = ((v > 200) & (v - mn < 40)) | (
            (r > 150) & (g > 110) & (b < 110) & (r - b > 60)
        )
        rows = (core & nb).sum(axis=1)
        rows[: int(H * 0.55)] = 0
        rows[H - 2:] = 0
        per_frame.append(rows)

    n = len(per_frame)
    scores = np.mean([(rows >= 6) for rows in per_frame], axis=0)
    presence = np.mean([(rows >= 3) for rows in per_frame], axis=0)
    top = int(H * 0.55)
    bands = []
    start = None
    for y in range(top, H):
        if scores[y] >= ls["min_score"]:
            if start is None:
                start = y
        else:
            if start is not None:
                bands.append((start, y - 1))
                start = None
    if start is not None:
        bands.append((start, H - 1))
    bands = [(a, b) for a, b in bands if ls["min_height_720"] / 2 <= b - a + 1 <= ls["max_height_720"] / 2]
    if not bands:
        return []

    # 低阈值把淡淡的上/下边缘行也算回来，只在各层自己范围内扩展，不跨层合并
    tight = []
    for a, b in bands:
        lo = max(top, a - 10)
        hi = min(H - 3, b + 10)
        mask = presence[lo:hi + 1] >= 0.25
        s, e = a - lo, b - lo
        while s > 0 and mask[s - 1]:
            s -= 1
        while e < len(mask) - 1 and mask[e + 1]:
            e += 1
        tight.append((lo + s, lo + e))

    fps = ls["sample_fps"]
    layers = []
    for a, b in tight:
        bh = b - a + 1
        need = max(3, bh // 3)
        present = [
            i for i, rows in enumerate(per_frame)
            if int((rows[a:b + 1] >= 3).sum()) >= need
        ]
        spans = []
        for i in present:
            s, e = i / fps, min(dur, (i + 1) / fps)
            if spans and s - spans[-1][1] <= 0.6:
                spans[-1][1] = max(spans[-1][1], e)
            else:
                spans.append([s, e])
        spans = [(max(0.0, s - 0.25), min(dur, e + 0.25)) for s, e in spans]
        spans = [(round(s, 2), round(e, 2)) for s, e in spans if e - s >= 0.4]
        if spans:
            # 上下各留 2 行余量（360 空间 1 行 ≈ 成片 3px）
            layers.append({"y0": max(0, a - 2), "y1": min(H - 1, b + 2), "spans": spans})

    if not layers:
        return []
    log(f"字幕层（360x640）：" + "；".join(
        f"{l['y0']}-{l['y1']} {l['spans']}" for l in layers
    ))

    scale = cfg["video"]["height"] / H
    bars = []
    for layer in layers:
        y0 = round(layer["y0"] * scale)
        y1 = round((layer["y1"] + 1) * scale)
        for s, e in layer["spans"]:
            bars.append({"y0": y0, "y1": y1, "t0": round(s, 2), "t1": round(e, 2)})
    bars.sort(key=lambda x: (x["t0"], x["y0"]))
    return bars


# ---------------------------------------------------------------- render

def render(cfg, video, workdir, ass_rel, bgm, dur, out_path, fx_frames=None, sfx_path=None,
           cover_bars=None):
    v = cfg["video"]
    a = cfg["audio"]
    W, H, fps = v["width"], v["height"], v["fps"]
    fade_in = a["fade_in"]
    fade_out = a["fade_out"]
    fade_out_start = max(0.0, dur - fade_out)

    inputs = ["-i", str(video), "-stream_loop", "-1", "-i", str(bgm)]
    fc = []

    fc.append(f"[0:v]scale={W}:{H}:flags=lanczos,fps={fps},setsar=1[base]")
    cur = "[base]"
    if fx_frames:
        fx_dur = float(cfg["opening_fx"]["duration"])
        inputs += ["-framerate", str(fps), "-i", str(Path(fx_frames) / "%03d.png")]
        fc.append("[2:v]format=rgba[fx]")
        fc.append(
            f"{cur}[fx]overlay=0:0:shortest=0:enable='between(t,0,{fx_dur:.3f})'[ov]"
        )
        cur = "[ov]"
    # 自带烧录字幕有错字时：只在该字幕出现的时段把字幕带模糊掉，再由我们重打正确字幕
    pad = int(cfg["legacy_sub"].get("cover_pad", 18))
    blur = int(cfg["legacy_sub"].get("cover_blur", 18))
    for i, b in enumerate(cover_bars or []):
        y0 = max(0, int(b["y0"]) - pad)
        y1 = min(H, int(b["y1"]) + pad)
        if y1 - y0 < 8:
            continue
        en = f"between(t,{b['t0']:.2f},{b['t1']:.2f})"
        fc.append(f"{cur}split=2[cv{i}a][cv{i}b]")
        fc.append(f"[cv{i}b]crop={W}:{y1 - y0}:0:{y0},boxblur={blur}:3[cv{i}blur]")
        fc.append(f"[cv{i}a][cv{i}blur]overlay=0:{y0}:enable='{en}'[cv{i}o]")
        cur = f"[cv{i}o]"
    tail = []
    if ass_rel:
        tail.append(f"ass={ass_rel}:fontsdir=runtime/asr-models")
    tail.append("format=yuv420p")
    fc.append(f"{cur}{','.join(tail)}[v]")

    fc.append(f"[0:a:0]volume={a['voice_volume']}[voice]")
    fc.append(
        f"[1:a]atrim=0:{dur:.3f},asetpts=PTS-STARTPTS,volume={a['bgm_volume']},"
        f"afade=t=in:st=0:d={fade_in},afade=t=out:st={fade_out_start:.3f}:d={fade_out}[bgm]"
    )
    mix = "[voice][bgm]"
    n_mix = 2
    if sfx_path:
        inputs += ["-i", str(sfx_path)]
        sfx_idx = 3 if fx_frames else 2
        fc.append(f"[{sfx_idx}:a]volume={cfg['opening_fx']['sfx_volume']}[sfx]")
        mix += "[sfx]"
        n_mix = 3
    fc.append(
        f"{mix}amix=inputs={n_mix}:duration=first:dropout_transition=0:normalize=0,"
        f"alimiter=limit={a['limiter']}[a]"
    )

    cmd = [
        "ffmpeg", "-hide_banner", "-y",
        *inputs,
        "-filter_complex", ";".join(fc),
        "-map", "[v]", "-map", "[a]",
        "-c:v", v["codec"], "-crf", str(v["crf"]), "-preset", v["preset"],
        "-tag:v", "hvc1", "-pix_fmt", "yuv420p",
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        "-c:a", "aac", "-b:a", v["audio_bitrate"], "-ar", str(v["audio_rate"]), "-ac", "2",
        "-movflags", "+faststart", "-t", f"{dur:.3f}",
        str(out_path),
    ]
    run(cmd)
    return cmd


def verify_output(cfg, out_path, workdir, expect_dur):
    info = probe(out_path)
    vs = [s for s in info["streams"] if s["codec_type"] == "video"][0]
    aus = [s for s in info["streams"] if s["codec_type"] == "audio"]
    dur = float(info["format"]["duration"])
    problems = []
    if (vs["width"], vs["height"]) != (cfg["video"]["width"], cfg["video"]["height"]):
        problems.append(f"分辨率 {vs['width']}x{vs['height']}")
    fr = vs.get("avg_frame_rate", "0/1")
    num, den = (fr.split("/") + ["1"])[:2]
    fps = float(num) / float(den or 1)
    if abs(fps - cfg["video"]["fps"]) > 0.2:
        problems.append(f"帧率 {fps}")
    if not aus:
        problems.append("无音轨")
    if abs(dur - expect_dur) > 0.6:
        problems.append(f"时长 {dur:.2f}s vs 源 {expect_dur:.2f}s")
    # 抽三帧供人工检查
    shots = []
    for frac in (0.25, 0.55, 0.85):
        t = max(0.0, dur * frac)
        shot = workdir / f"check_{int(frac*100)}.jpg"
        ffmpeg("-ss", f"{t:.2f}", "-i", str(out_path), "-frames:v", "1", "-q:v", "2", str(shot))
        shots.append(str(shot))
    return {"ok": not problems, "problems": problems, "duration": dur, "fps": fps,
            "size": f"{vs['width']}x{vs['height']}", "frames": shots}


# ---------------------------------------------------------------- pipeline

def process_clip(cfg, clip, args):
    t0 = time.time()
    stem = clip.stem
    workdir = Path(cfg["paths"]["work_dir"]) / stem
    workdir.mkdir(parents=True, exist_ok=True)
    dur = source_duration(clip)
    log(f"处理 {clip.name}（{dur:.2f}s）")

    corrections = None
    corr_path = Path(cfg["paths"]["corrections_dir"]) / f"{stem}.json"
    if corr_path.exists():
        corrections = json.loads(corr_path.read_text(encoding="utf-8"))
        log(f"使用人工校对稿 {corr_path.name}")

    # 检测素材自带的烧录字幕；有字幕就整套跳过字幕环节（不加黑条、不叠我们的字）
    legacy = []
    if cfg["legacy_sub"]["enabled"]:
        legacy = detect_legacy_bars(cfg, clip, workdir, dur)
        if legacy:
            log("检测到素材自带字幕：" + "；".join(
                f"{b['y0']}-{b['y1']} @ {b['t0']:.1f}-{b['t1']:.1f}s" for b in legacy
            ))
    sub_mode = cfg["legacy_sub"].get("mode", "skip")
    skip_subs = bool(legacy) and sub_mode != "cover" and cfg["subtitle"].get("skip_if_legacy", True)
    cover_bars = legacy if (legacy and sub_mode == "cover") else []
    if cover_bars:
        log(f"按 cover 模式遮盖自带字幕并重打（{len(cover_bars)} 段）")

    lines = []
    asr = []
    hint_text = ""
    ass_rel = None
    skip_by_correction = bool(corrections and corrections.get("skip"))
    if skip_by_correction:
        log("校对稿标记跳过字幕：只出画面")
    elif corrections and corrections.get("lines"):
        lines = [
            {"text": clean_text(x["text"]), "start": float(x["start"]), "end": float(x["end"])}
            for x in corrections["lines"]
            if clean_text(x["text"])
        ]
        hint_text = "".join(x["text"] for x in lines)
        asr = corrections.get("asr") or []
    else:
        asr_path = workdir / "asr.json"
        if asr_path.exists() and asr_path.stat().st_mtime >= clip.stat().st_mtime:
            asr = json.loads(asr_path.read_text(encoding="utf-8"))
            to_simplified(asr)
            log("复用已识别的 asr.json")
        else:
            asr = transcribe(cfg, clip, workdir)
            to_simplified(asr)
            asr_path.write_text(json.dumps(asr, ensure_ascii=False, indent=2), encoding="utf-8")

    if skip_subs or skip_by_correction:
        if not skip_by_correction:
            log("按规则跳过字幕环节：不加黑条、不叠加字幕")
        lines = []
        for stale in ("subs.ass", "lines.json"):
            p = workdir / stale
            if p.exists():
                p.unlink()
    else:
        if not lines:  # 没有校对稿时才用 ASR 结果
            lines = build_lines(asr, dur, cfg)
        if lines:
            ass_path = workdir / "subs.ass"
            ass_path.write_text(build_ass(cfg, lines), encoding="utf-8")
            ass_rel = str(ass_path.relative_to(ROOT)).replace("\\", "/")
        else:
            log("没有可用字幕，只出画面")
        (workdir / "lines.json").write_text(
            json.dumps(lines, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    # 识别团购品牌：人工覆盖 > 画面 OCR > 口播；识别不到时标人工复核，不猜
    asr_text = hint_text + "".join(x["text"] for x in lines) + "".join(s["text"] for s in asr)
    brand = brand_ocr.detect_brand(
        cfg, clip, workdir, asr_text=asr_text, force=args.force_brand
    )

    # 字幕被跳过时仍用 ASR 文本给 BGM 选曲（结果已缓存，不重复识别）
    hint = asr_text + stem + (brand.get("brand") or "") + (brand.get("store") or "")
    bgm = pick_bgm(cfg, hint)
    log(f"BGM：{bgm.name}")

    fx_frames, sfx_path = opening_fx.build_opening_fx(cfg, workdir)
    if fx_frames:
        n_frames = len(list(Path(fx_frames).glob("*.png")))
        log(f"片头白线冲刺：{n_frames} 帧 + whoosh 音效")

    name = args.name or f"{datetime.now().month}月{datetime.now().day}日_{stem[:8]}.mp4"
    out_dir = Path(cfg["paths"]["output_dir"])
    out_path = out_dir / name
    render(cfg, clip, workdir, ass_rel, bgm, dur, out_path, fx_frames, sfx_path, cover_bars)

    check = verify_output(cfg, out_path, workdir, dur)
    brand_ocr.write_index(cfg, stem, clip, brand, out_path)
    meta = {
        "clip": str(clip),
        "output": str(out_path),
        "duration": dur,
        "bgm": str(bgm),
        "brand": brand,
        "legacy_sub": legacy,
        "subtitle_skipped": skip_subs,
        "lines": lines,
        "opening_fx": bool(fx_frames),
        "verify": check,
        "elapsed_sec": round(time.time() - t0, 1),
    }
    (workdir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    if not check["ok"]:
        log(f"自检异常：{check['problems']}")
    else:
        log(f"自检通过：{check['size']} {check['fps']:.1f}fps {check['duration']:.2f}s")

    if not args.no_move:
        done_dir = Path(cfg["paths"]["done_source_dir"])
        done_dir.mkdir(parents=True, exist_ok=True)
        target = done_dir / clip.name
        if target.exists():
            target = done_dir / f"{clip.stem}_{datetime.now().strftime('%H%M%S')}{clip.suffix}"
        shutil.move(str(clip), str(target))
        log(f"源素材已移动：{target}")

    log(f"成片：{out_path}（用时 {meta['elapsed_sec']}s）")
    return meta


def main():
    ap = argparse.ArgumentParser(description="抖音团购素材自动剪辑")
    ap.add_argument("--list", action="store_true", help="列出待剪素材")
    ap.add_argument("--clip", help="素材文件名或文件名片段")
    ap.add_argument("--all", action="store_true", help="处理未剪素材下全部视频")
    ap.add_argument("--no-move", action="store_true", help="只出片，不移动源素材")
    ap.add_argument("--name", help="指定成片文件名（仅单条时有效）")
    ap.add_argument("--skip-existing", action="store_true", help="同名成片已存在则跳过")
    ap.add_argument("--brand-scan", action="store_true",
                    help="只识别品牌不剪片（含已剪素材），写入 brand_index.json")
    ap.add_argument("--force-brand", action="store_true", help="忽略品牌识别缓存重新扫描")
    ap.add_argument("--config", help="改用指定配置文件（不同素材目录/输出目录时使用）")
    ap.add_argument("--out-dir", help="覆盖输出目录（同步盘先渲到本地再拷入时用）")
    args = ap.parse_args()
    cfg = load_config(args.config)
    if args.out_dir:
        cfg["paths"]["output_dir"] = args.out_dir

    if args.brand_scan:
        clips = find_brand_clips(cfg, pattern=args.clip)
        if not clips:
            log("没有匹配的素材")
            return
        log(f"品牌扫描 {len(clips)} 条")
        review = []
        for clip in clips:
            workdir = Path(cfg["paths"]["work_dir"]) / clip.stem
            workdir.mkdir(parents=True, exist_ok=True)
            try:
                rec = brand_ocr.detect_brand(
                    cfg, clip, workdir,
                    asr_text=cached_asr_text(workdir),
                    force=args.force_brand,
                )
            except Exception as exc:
                log(f"识别失败 {clip.name}：{exc}")
                review.append((clip.stem, "识别失败"))
                continue
            brand_ocr.write_index(cfg, clip.stem, clip, rec)
            # 已剪素材补录品牌时同步 meta.json：发布端先读 meta.brand，不同步就看不到人工覆盖
            meta_path = workdir / "meta.json"
            if meta_path.exists():
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                    meta["brand"] = rec
                    meta_path.write_text(
                        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
                    )
                except Exception as exc:
                    log(f"更新 meta 失败 {clip.name}：{exc}")
            label = rec.get("brand") or "未识别"
            conf = rec.get("confidence") or 0
            print(
                f"  {clip.stem[:12]}  {label:<8}  {rec.get('source',''):<8}  "
                f"{conf:.2f}  {'需复核' if rec.get('needs_review') else 'OK'}"
                + (f"  {rec['product']}" if rec.get("product") else "")
            )
            if rec.get("needs_review"):
                cands = rec.get("candidates") or []
                why = rec.get("note") or ""
                if cands:
                    why = (why + " 候选：" if why else "候选：") + " / ".join(
                        c.get("text", "") for c in cands[:5]
                    )
                review.append((clip.stem, why))
        log(f"品牌识别完成 {len(clips)} 条，需人工复核 {len(review)} 条")
        for stem, why in review:
            log(f"  需复核 {stem[:12]}：{why}")
        return

    if args.list or (not args.clip and not args.all):
        clips = find_clips(cfg)
        log(f"待剪素材 {len(clips)} 条：")
        for c in clips:
            print(f"  {c.name}")
        return

    if args.all:
        clips = find_clips(cfg, select_all=True)
    else:
        clips = find_clips(cfg, pattern=args.clip)
        if len(clips) > 1:
            log(f"匹配到 {len(clips)} 条，请写更长片段：")
            for c in clips:
                print(f"  {c.name}")
            return
    if not clips:
        log("没有匹配的素材")
        return

    results = []
    for clip in clips:
        try:
            results.append(process_clip(cfg, clip, args))
        except Exception as exc:
            import traceback

            log(f"失败 {clip.name}：{exc}")
            traceback.print_exc()
            results.append({"clip": str(clip), "error": str(exc)})
    ok = sum(1 for r in results if "error" not in r and r.get("verify", {}).get("ok"))
    log(f"完成 {ok}/{len(results)} 条")


if __name__ == "__main__":
    main()

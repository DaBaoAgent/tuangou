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
  # 重剪库存：源素材已归档到「未剪素材/已剪」，直接指过去，别移动源
  python scripts/auto-edit/auto_edit.py --source-dir 素材库/未剪素材/已剪 \
      --clip <素材名> --no-move --name 重剪_xxx.mp4

字幕人工校对：在 runtime/auto-edit/corrections/<素材文件名去扩展名>.json 写入
  {"lines": [{"text": "...", "start": 0.0, "end": 1.4}, ...]}
存在该文件时优先使用，便于修正 ASR 错字与断句；仅对无自带字幕的素材生效。
"""

import argparse
import hashlib
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

# A8（2026-11-08）：重依赖（numpy / opencv）改为按需导入，
# --list 这类纯清单命令不再因为环境缺包直接起不来
brand_ocr = None
opening_fx = None


def _heavy():
    """真正要剪片/识别品牌时才加载重依赖，只列清单时不碰。"""
    global brand_ocr, opening_fx
    if brand_ocr is None:
        import brand_ocr as _b  # noqa: E402  （同目录模块）
        brand_ocr = _b
    if opening_fx is None:
        import fx as _f  # noqa: E402  （同目录模块）
        opening_fx = _f

PUNCT_RE = re.compile(
    r"[，。！？、；：,.!?;:'\"“”‘’（）()【】\[\]《》<>…—－\-~～·\s]+"
)
CJK_RE = re.compile(r"[\u4e00-\u9fff0-9A-Za-z]")


def log(msg):
    print(f"[auto-edit] {msg}", flush=True)


def load_config(path=None):
    with open(path or CONFIG_PATH, encoding="utf-8") as f:
        cfg = json.load(f)
    # B1（2026-11-08）：config 里的相对路径以项目根为基准还原成绝对路径，配置里不再写死盘符
    for key, val in (cfg.get("paths") or {}).items():
        if isinstance(val, str) and val and not Path(val).is_absolute():
            cfg["paths"][key] = str(ROOT / val)
    return cfg


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


def video_sig(video):
    """素材签名：大小 + mtime + 前 1MB 的 sha1。修复片/清理版与原件同 stem 时防止复用旧中间产物。"""
    import hashlib
    p = Path(video)
    h = hashlib.sha1()
    with open(p, "rb") as f:
        h.update(f.read(1 << 20))
    return f"{p.stat().st_size}-{int(p.stat().st_mtime)}-{h.hexdigest()[:16]}"


def transcribe(cfg, video, workdir):
    try:
        model = get_model(cfg)
    except Exception as exc:
        log(f"faster-whisper 不可用，改用 ffmpeg whisper 兜底：{exc}")
        return transcribe_fallback(cfg, video, workdir)
    wav = workdir / "asr.wav"
    stamp = workdir / "asr_src.txt"
    sig = video_sig(video)
    fresh = wav.exists() and stamp.exists() and stamp.read_text(encoding="utf-8").strip() == sig
    if not fresh:
        if wav.exists():
            wav.unlink()
        ffmpeg("-i", str(video), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav))
        stamp.write_text(sig, encoding="utf-8")
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


def cover_centered_margin_v(cfg, cover_bars):
    """cover 模式：把重打字幕垂直居中到模糊条中间。"""
    if not cover_bars:
        return int(cfg["subtitle"]["margin_v"])
    H = int(cfg["video"]["height"])
    pad = int(cfg["legacy_sub"].get("cover_pad", 18))
    fs = float(cfg["subtitle"]["font_size"])
    mids = []
    for b in cover_bars:
        y0 = max(0, int(b["y0"]) - pad)
        y1 = min(H, int(b["y1"]) + pad)
        if y1 > y0:
            mids.append((y0 + y1) / 2.0)
    if not mids:
        return int(cfg["subtitle"]["margin_v"])
    mid = sum(mids) / len(mids)
    # Alignment=2：行盒底边距底边 = margin_v；字幕着墨行的视觉中心在行盒底上方 k*字号。
    # k 由实测得出（Noto Sans SC Bold、字号 112、1080x1920：着墨 y=1485-1555，行盒底 1572，
    # 视觉中心距行盒底 52px ≈ 0.46*字号），默认 0.46；老批次可用 subtitle.cover_ink_center 覆盖。
    ink_k = float(cfg["subtitle"].get("cover_ink_center", 0.46))
    mv = int(round(H - mid - fs * ink_k))
    return max(60, min(H // 2, mv))


def ass_bgr(rgb):
    """配置里写 RGB（如 FFD400 黄），ASS 样式要 BBGGRR，这里转一下。"""
    rgb = str(rgb or "").lstrip("#").strip()
    if len(rgb) != 6:
        return rgb.upper()
    return (rgb[4:6] + rgb[2:4] + rgb[0:2]).upper()


def build_ass(cfg, lines, margin_v=None, hook=None):
    sub = cfg["subtitle"]
    w = cfg["video"]["width"]
    h = cfg["video"]["height"]
    max_width = sub["max_width"]
    fs = sub["font_size"]
    mv = int(sub["margin_v"] if margin_v is None else margin_v)
    hook_cfg = cfg.get("hook") or {}
    styles = [
        f"Style: Cap,{sub['font_name']},{fs},&H00{sub['fill']},&H00FFFFFF,"
        f"&H00{sub['outline_color']},&H00000000,{sub['font_bold']},0,0,0,100,100,0,0,1,"
        f"{sub['outline']},{sub['shadow']},2,40,40,{mv},1"
    ]
    hook_fs = int(hook_cfg.get("font_size", 120))
    if hook:
        # Alignment=8：MarginV 是从画面顶边往下的距离，不用改字幕的底部 margin
        # 2026-11-11 宝哥定样式：黄字 + 很窄的黑描边（不打白字，不和底部字幕撞）
        hook_mv = int(round(h * float(hook_cfg.get("margin_top_ratio", 0.24))))
        hook_fill = ass_bgr(hook_cfg.get("fill", sub["fill"]))
        hook_oc = ass_bgr(hook_cfg.get("outline_color", sub["outline_color"]))
        styles.append(
            f"Style: Hook,{sub['font_name']},{hook_fs},&H00{hook_fill},&H00FFFFFF,"
            f"&H00{hook_oc},&H00000000,{sub['font_bold']},0,0,0,100,100,0,0,1,"
            f"{hook_cfg.get('outline', 2)},{hook_cfg.get('shadow', 0)},8,40,40,{hook_mv},1"
        )
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
{chr(10).join(styles)}

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
    if hook and hook.get("text"):
        text = hook["text"].replace("{", "（").replace("}", "）")
        scale = 100.0
        if len(text) * hook_fs > max_width:
            scale = max(60.0, max_width / len(text) / hook_fs * 100.0)
        dur = float(hook.get("duration") or hook_cfg.get("duration", 1.5))
        extra = f"\\fscx{scale:.0f}\\fscy{scale:.0f}" if scale < 99.9 else ""
        events.append(
            f"Dialogue: 2,{ass_time(0)},{ass_time(dur)},Hook,,0,0,0,,"
            f"{{\\fad(120,260){extra}}}{text}"
        )
    return header + "\n".join(events) + "\n"


HOOK_FILLER = re.compile(
    r"^(?:姐妹们|宝子们|家人们|朋友们|兄弟们|哈喽|大家好|我跟你们说|我跟你说|听我说)+"
)
HOOK_PUNCT = re.compile(r"[，,。！？!?、；;：:\s]+")


def _hook_phrases(lines, asr, max_chars):
    """按词边界拼候选短句（带开始时间），避免把中文切入半截。"""
    phrases = []
    for seg in asr or []:
        # 片尾常出现 0.0x 秒的幻觉段（如「我认真的吗我认真的吗」），先剔掉
        try:
            s0 = float(seg.get("start") or 0.0)
            s1 = float(seg.get("end") or s0)
        except (TypeError, ValueError):
            s0 = s1 = 0.0
        if s1 - s0 < 0.5:
            continue
        words = [
            (str(w.get("w", "")).strip(), float(w.get("start") or s0))
            for w in seg.get("words", [])
        ]
        words = [x for x in words if x[0]]
        for i in range(len(words)):
            phrase = ""
            start = words[i][1]
            for j in range(i, len(words)):
                if len(phrase) + len(words[j][0]) > max_chars:
                    break
                phrase += words[j][0]
                if len(phrase) >= 3:
                    phrases.append((phrase, start, False))
    for ln in lines or []:
        text = str(ln.get("text", "")).strip()
        if text:
            phrases.append((text, float(ln.get("start") or 0.0), True))
    return phrases


_SIZE_CACHE = {}


def _clip_size(clip):
    """源素材实际分辨率；缓存。烧录字幕带坐标是按成片 1080x1920 记的，裁源帧要按比例换算。"""
    key = str(clip)
    if key in _SIZE_CACHE:
        return _SIZE_CACHE[key]
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "default=nw=1",
             "-i", key],
            capture_output=True, text=True, check=True,
        ).stdout
        kv = dict(line.split("=", 1) for line in out.strip().splitlines() if "=" in line)
        size = (int(kv["width"]), int(kv["height"]))
    except Exception:
        size = (None, None)
    _SIZE_CACHE[key] = size
    return size


def _ocr_band(cfg, clip, workdir, t, band):
    """抽一帧、裁到烧录字幕带、OCR，返回该帧上的字幕文本（逐块）。"""
    w = int(cfg["video"]["width"])
    y0, y1 = band
    src_w, src_h = _clip_size(clip)
    if src_w and src_w != w:
        s = src_w / float(w)
        y0 = max(0, int(round(y0 * s)))
        y1 = min(src_h, int(round(y1 * s)))
    if y1 - y0 < 8:
        return []
    frame = workdir / f"hook_ocr_{int(round(t * 10)):03d}.jpg"
    crop_h = max(1, y1 - y0)
    try:
        ffmpeg("-ss", f"{t:.2f}", "-i", str(clip), "-frames:v", "1", "-update", "1",
               "-vf", f"crop={src_w or w}:{y1 - y0}:0:{y0}", "-q:v", "3", str(frame))
        blocks = brand_ocr._ocr_image(frame, max_side_len=2048)
    except Exception as exc:
        log(f"钩子读字幕失败 @{t:.1f}s：{exc}")
        return []
    out = []
    for b in blocks:
        score = float(b.get("score") or 0)
        if score < 0.85:
            continue
        bh = b.get("h")
        # 一块横跨整条字幕带 = OCR 把上下两行并成一句（样片出过「粉糯绵密香甜腻百换」），
        # 按「宁可不加卡也不上错字」直接丢；太矮的碎片也丢。
        if bh is not None and (bh > crop_h * 0.98 or bh < crop_h * 0.22):
            continue
        text = clean_text(b.get("text", ""))
        if text:
            out.append(text)
    return out


def hook_from_legacy_ocr(cfg, clip, workdir, legacy, dur):
    """源素材自带烧录字幕时，钩子文案直接读画面上的字幕，不走 ASR。

    ASR 对 CTA 和品牌名常出错（“链接”识别成“练街”），2026-11-11 批量试跑
    才发现错字会被顶上钩子卡。画面字幕是发布后观众实际看到的字，OCR 出来最可靠。
    """
    h = cfg.get("hook") or {}
    if not h.get("enabled", False) or not legacy or brand_ocr is None:
        return None
    max_chars = int(h.get("max_chars", 10))
    # 画面字幕 OCR 的长句更容易把两行并进来/读错字，钩子只收 8 字以内
    max_chars = min(max_chars, 8)
    keywords = [str(k) for k in h.get("keywords", []) if str(k)]
    window = float(h.get("duration", 1.5)) + 1.0
    max_start = float(h.get("max_start_seconds", 9.0))
    y0 = max(0, min(int(b["y0"]) for b in legacy))
    y1 = min(int(cfg["video"]["height"]), max(int(b["y1"]) for b in legacy))
    if y1 - y0 < 12:
        return None
    band = (y0, y1)
    # 开头 2.5 秒以内的底部字幕不能再当钩子，会和卡片同字
    early = "".join(_ocr_band(cfg, clip, workdir, min(1.0, max(0.0, dur * 0.15)), band))
    t = max(window + 0.5, 3.0)
    end = min(max_start, dur - 0.3)
    best = None
    while t <= end + 1e-6:
        for text in _ocr_band(cfg, clip, workdir, t, band):
            if not (4 <= len(text) <= max_chars):
                continue
            if early and text in early:
                continue
            if len(text) >= 6 and text[: len(text) // 2] == text[len(text) // 2:]:
                continue
            hits = sum(1 + min(len(k), 4) for k in keywords if k in text)
            rhetorical = any(text.endswith(x) for x in ("吗", "吧", "呢"))
            if not hits and not rhetorical:
                continue
            score = hits * 10.0 + (6 if rhetorical else 0)
            score += 2 if 4 <= len(text) <= 7 else 0
            score += 1.5 if t <= 6 else 0
            if best is None or score > best[0]:
                best = (score, text, t)
        t += 1.0
    if best:
        return {
            "text": best[1], "source": "ocr", "start": round(best[2], 2),
            "duration": float(h.get("duration", 1.5)),
        }
    return None


def pick_hook(cfg, lines, asr, fallback=None):
    """开头 1.5 秒钩子文案（2026-11-11 宝哥拍板）。

    只从已有口播/字幕里选，不编造卖点。规则：
    - 必须带卖点关键词或疑问语气（吗/吧/呢），否则不加卡片；
    - 必须发生在开头 1.5 秒之后，避免和画面里已有的第一句字幕重复（样片实测踩过）；
    - 优先靠前、6~10 字、不是 CTA 尾巴的短句。
    取不到返回 None（此时只保留推近运镜）。
    """
    h = cfg.get("hook") or {}
    if not h.get("enabled", False):
        return None
    max_chars = int(h.get("max_chars", 10))
    keywords = [str(k) for k in h.get("keywords", []) if str(k)]
    # 只用自然断句的字幕行选词。从整段口播按字数硬截常切出半句话；没有字幕行
    # （ASR 太碎/太糊）时硬截还会把识别错字直接顶上画面——2026-11-11 批量实测
    # 出过「越上头赶紧出练街你」这种，按「宁可不加卡也不上错字」直接放弃。
    phrases = [p for p in _hook_phrases(lines, asr, max_chars) if p[2]]
    # 开头这段时间（钩子时长 + 1 秒）里已经出现在画面/口播里的文字，
    # 钩子不能是它的重复——样片实测过上下两行同字，很难看。
    window = float(h.get("duration", 1.5)) + 1.0
    # 钩子是「开头」的卡片：只认开头几秒说出来的词。尾段 ASR 常是 CTA 或幻觉，
    # 批量实测出过「越上头赶紧出练街你」（“链接”被识别成“练街”）。
    max_start = float(h.get("max_start_seconds", 9.0))
    early_parts = []
    for seg in asr or []:
        for w in seg.get("words", []):
            try:
                if float(w.get("start") or 0.0) < window:
                    early_parts.append(str(w.get("w", "")))
            except (TypeError, ValueError):
                continue
    for ln in lines or []:
        try:
            if float(ln.get("start") or 0.0) < window:
                early_parts.append(str(ln.get("text", "")))
        except (TypeError, ValueError):
            continue
    early = "".join(early_parts)
    best = None
    for raw, start, from_line in phrases:
        text = HOOK_PUNCT.sub("", HOOK_FILLER.sub("", raw))
        if not (4 <= len(text) <= max_chars):
            continue
        if start < window or start > max_start:
            continue
        # 整句复读（ASR 幻觉的常见形态）：前后两半相同就不当钩子
        if len(text) >= 6 and text[: len(text) // 2] == text[len(text) // 2:]:
            continue
        if early and (text in early or early.endswith(text)):
            continue
        hits = sum(1 + min(len(k), 4) for k in keywords if k in text)
        rhetorical = any(text.endswith(x) for x in ("吗", "吧", "呢"))
        if not hits and not rhetorical:
            continue
        score = hits * 10.0
        # 字幕行是按词边界切好的自然短句，优先于从整段口播里硬截的窗口
        if from_line:
            score += 4
        if rhetorical:
            score += 6
        if text[:1] in "别就这我你谁真":
            score += 3
        # 1.5 秒的卡片 4~7 字最利落；凑到 10 字往往是从句子中间切出来的
        if 4 <= len(text) <= 7:
            score += 2
        elif len(text) >= 9:
            score -= 1
        if text.endswith(("啦", "了", "的")):
            score -= 3
        if any(x in text for x in ("链接", "下单", "拍下")):
            score -= 2
        if start <= 6:
            score += 1.5
        elif start > 10:
            score -= 2
        if best is None or score > best[0]:
            best = (score, text, start)
    if best:
        # 现在只从字幕行选，source 统一记 line，便于回查是否有人上过 ASR 硬截的词
        return {
            "text": best[1], "source": "line", "start": round(best[2], 2),
            "duration": float(h.get("duration", 1.5)),
        }
    if fallback:
        text = HOOK_PUNCT.sub("", HOOK_FILLER.sub("", str(fallback)))
        if 4 <= len(text) <= max_chars and any(k in text for k in keywords):
            return {"text": text, "source": "fallback", "duration": float(h.get("duration", 1.5))}
    return None


# ---------------------------------------------------------------- legacy subtitle bar

def detect_legacy_by_ocr(cfg, video, workdir, dur):
    """像素法漏检时的兜底：整帧 OCR 找画面下半部的字幕块，定位烧录字幕带。

    2026-11-13 这批 720x1280 素材有 8 条像素法测不到（字幕字号小/描边淡），
    按 ASR 重打会叠出双字幕且错字，宁可先用 OCR 把位置认出来再跳过字幕层。
    """
    if brand_ocr is None:
        return []
    W = int(cfg["video"]["width"])
    H = int(cfg["video"]["height"])
    src_w, src_h = _clip_size(video)
    if not src_w or not src_h:
        return []
    ys = []
    t = 1.0
    ts = []
    while t < dur - 0.5 and len(ts) < 10:
        ts.append(t)
        t += max(1.2, (dur - 1.5) / 8.0)
    for t in ts:
        frame = workdir / f"legacy_probe_{t:.1f}.jpg"
        try:
            ffmpeg("-ss", f"{t:.2f}", "-i", str(video), "-frames:v", "1", "-update", "1",
                   "-q:v", "3", str(frame))
            blocks = brand_ocr._ocr_image(frame, max_side_len=1536)
        except Exception as exc:
            log(f"字幕带 OCR 探测失败 @{t:.1f}s：{exc}")
            continue
        for b in blocks:
            box = b.get("box") or []
            text = clean_text(b.get("text", ""))
            score = float(b.get("score") or 0)
            if len(box) < 3 or len(text) < 4 or score < 0.75:
                continue
            xs = [float(p[0]) for p in box]
            yy = [float(p[1]) for p in box]
            top, bot = min(yy), max(yy)
            if top < src_h * 0.55:
                continue
            if (max(xs) - min(xs)) < src_w * 0.22:   # 太窄：价格贴纸/角标
                continue
            if (bot - top) > src_h * 0.09:            # 太高：多行或整块招牌
                continue
            ys.append((top, bot))
    if not ys:
        return []
    s = H / float(src_h)
    y0 = max(0, int(min(y for y, _ in ys) * s) - 6)
    y1 = min(H, int(max(b for _, b in ys) * s) + 6)
    if y1 - y0 < 12:
        return []
    return [{"y0": y0, "y1": y1, "t0": 0.0, "t1": dur}]


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
        return detect_legacy_by_ocr(cfg, video, workdir, dur)

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
           cover_bars=None, hook=None):
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
        # boxblur 的色度半径有上限（取决于裁剪带的色度平面大小，带越窄上限越小），
        # 只写 luma 半径时色度会沿用同一个值，26 会把整条渲染直接打挂（-22 Invalid argument）。
        # 字幕是灰白字，模糊主要靠亮度平面，色度按带宽给一个保守值即可。
        chr_r = max(1, min(blur, (y1 - y0) // 4 - 2))
        fc.append(f"{cur}split=2[cv{i}a][cv{i}b]")
        fc.append(f"[cv{i}b]crop={W}:{y1 - y0}:0:{y0},boxblur={blur}:3:{chr_r}:2[cv{i}blur]")
        fc.append(f"[cv{i}a][cv{i}blur]overlay=0:{y0}:enable='{en}'[cv{i}o]")
        cur = f"[cv{i}o]"
    # 2026-11-11：开头 1.5 秒轻微推近 + 缓慢回中，给首帧一点运动感（2 秒跳出 62%）。
    # 2026-11-14：cover 模式下一律不推近——推近锚点在 y=0，(punch-1) 的位移会把遮盖条
    # 从静止的重打字幕上推开（实测 8% 时偏移约 115px），模糊条位置也就盖不住原字幕。
    hook_cfg = cfg.get("hook") or {}
    punch = float(hook_cfg.get("punch_in", 1.0) or 1.0)
    if cover_bars and punch > 1.001:
        punch = 1.0
    if hook_cfg.get("enabled", False) and punch > 1.001:
        hd = max(0.2, float(hook_cfg.get("duration", 1.5)))
        fc.append(
            f"{cur}scale=w='trunc(iw*{punch})':h='trunc(ih*{punch})':flags=lanczos,setsar=1,"
            f"crop={W}:{H}:x='(in_w-out_w)/2':y='(in_h-out_h)/2*(1-min(t/{hd},1))'[punch]"
        )
        cur = "[punch]"
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

def find_workdir_for_film(cfg, film):
    """成片 → 剪辑工作目录：按 meta.output 的 basename 匹配，其次退回同名目录。"""
    work_root = Path(cfg["paths"]["work_dir"])
    base = film.name
    if work_root.exists():
        for d in work_root.iterdir():
            if not d.is_dir():
                continue
            meta_path = d / "meta.json"
            if not meta_path.exists():
                continue
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if Path(str(meta.get("output") or "")).name == base:
                return d, meta
    fallback = work_root / film.stem
    if (fallback / "meta.json").exists():
        try:
            return fallback, json.loads((fallback / "meta.json").read_text(encoding="utf-8"))
        except Exception:
            return fallback, {}
    return None, {}


def hook_for_existing(cfg, film, workdir, meta, dur):
    """给已经剪好的成片选钩子文案（不再推近，只叠卡）。

    文案优先级和正常剪辑一致：人工/已成片字幕行 > 画面烧录字幕 OCR。
    成片里的字幕行能直接给出时间，OCR 只在没有字幕行时用。
    """
    lines = [ln for ln in (meta.get("lines") or []) if ln.get("text")]
    hook = pick_hook(cfg, lines, None) if lines else None
    if hook:
        return hook
    legacy = meta.get("legacy_sub") or []
    if not legacy:
        bars = (meta.get("subtitle_repair") or {}).get("cover_bars") or []
        if bars:
            legacy = [{
                "y0": min(int(b["y0"]) for b in bars),
                "y1": max(int(b["y1"]) for b in bars),
            }]
    if not legacy:
        # 兜底：新版成片字幕带（audit_subs 实测 y≈1464–1557），留点余量
        legacy = [{"y0": 1400, "y1": 1600}]
    return hook_from_legacy_ocr(cfg, film, workdir, legacy, dur)


def render_hook_only(cfg, film, ass_rel, out_path):
    """只重编码画面叠一张钩子卡：不推近、不再烧字幕；音轨能直拷就直拷。"""
    v = cfg["video"]
    info = probe(film)
    acodec = next((s.get("codec_name") for s in info["streams"]
                   if s.get("codec_type") == "audio"), None)
    audio = ["-c:a", "copy"] if acodec == "aac" else ["-c:a", "aac", "-b:a", v["audio_bitrate"]]
    cmd = [
        "ffmpeg", "-hide_banner", "-y",
        "-i", str(film),
        "-vf", f"ass={ass_rel}:fontsdir=runtime/asr-models,format=yuv420p",
        "-c:v", v["codec"], "-crf", str(v["crf"]), "-preset", v["preset"],
        "-tag:v", "hvc1", "-pix_fmt", "yuv420p",
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        *audio,
        "-movflags", "+faststart",
        str(out_path),
    ]
    run(cmd)


def hook_only(cfg, film, args):
    """29 条缺原始素材的库存片：不重剪，只在开头叠钩子卡（宝哥 2026-11-11）。"""
    _heavy()
    t0 = time.time()
    workdir, meta = find_workdir_for_film(cfg, film)
    if workdir is None:
        raise RuntimeError(f"找不到剪辑工作目录：{film.name}")
    dur = source_duration(film)
    log(f"只叠钩子卡 {film.name}（{dur:.2f}s）")
    hook = hook_for_existing(cfg, film, workdir, meta, dur)
    if not hook:
        log("没有合格钩子文案，跳过（宁可不加卡也不上错字）")
        return {"clip": str(film), "output": None, "skipped": True, "hook": None}

    out_dir = Path(cfg["paths"]["output_dir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / (args.name or f"{film.stem}.mp4")
    if args.skip_existing and out_path.exists():
        log(f"已存在，跳过：{out_path.name}")
        return {"clip": str(film), "output": str(out_path), "skipped": True, "hook": hook}

    ass_path = workdir / "hook_only.ass"
    ass_path.write_text(build_ass(cfg, [], hook=hook), encoding="utf-8")
    ass_rel = os.path.relpath(ass_path, ROOT).replace("\\", "/")
    render_hook_only(cfg, film, ass_rel, out_path)

    check_dir = workdir / "hook_only"
    check_dir.mkdir(exist_ok=True)
    check = verify_output(cfg, out_path, check_dir, dur)
    meta["hook"] = hook
    meta["hook_only"] = True
    (workdir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    log(f"钩子：{hook['text']}（{hook['source']}）")
    if check["ok"]:
        log(f"自检通过：{check['size']} {check['fps']:.1f}fps {check['duration']:.2f}s")
    else:
        log(f"自检异常：{check['problems']}")
    log(f"成片：{out_path}（用时 {time.time() - t0:.1f}s）")
    return {"clip": str(film), "output": str(out_path), "hook": hook, "verify": check,
            "elapsed_sec": round(time.time() - t0, 1)}


def process_clip(cfg, clip, args):
    _heavy()
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
    # 像素检出的小字块未必是烧录字幕：杯身/包装上的品牌字（K COFFEE、UCan…）常被误判成字幕带，
    # 照 cover 遮下去会把商品主标模糊掉。校对稿可用 "cover": false 关掉本片遮盖，或用
    # "cover": [{y0,y1,t0,t1}] 显式指定要遮的带。
    corr_cover = corrections.get("cover") if isinstance(corrections, dict) else None
    if corr_cover is False:
        if legacy:
            log("校对稿指定不遮盖：检出的是画面里的商品字，不是烧录字幕")
        legacy = []
    elif isinstance(corr_cover, list):
        legacy = corr_cover
    skip_subs = bool(legacy) and sub_mode != "cover" and cfg["subtitle"].get("skip_if_legacy", True)
    cover_bars = legacy if (legacy and sub_mode == "cover") else []
    if cover_bars:
        log(f"按 cover 模式遮盖自带字幕并重打（{len(cover_bars)} 段）")
        # 2026-11-14：片头推近会给整帧带来 (punch-1) 的位移（锚点在 y=0），
        # 而重打的字幕是静止的，遮盖条会被推出字幕位置。cover 模式下一律关掉推近。
        hook_cfg = cfg.get("hook") or {}
        if hook_cfg.get("enabled", False) and float(hook_cfg.get("punch_in", 1.0) or 1.0) > 1.001:
            log("cover 模式跳过片头推近：静态字幕无法跟随整帧位移")

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
        sig = video_sig(clip)
        stamp = workdir / "asr_src.txt"
        if (asr_path.exists() and stamp.exists()
                and stamp.read_text(encoding="utf-8").strip() == sig):
            asr = json.loads(asr_path.read_text(encoding="utf-8"))
            to_simplified(asr)
            log("复用已识别的 asr.json")
        else:
            asr = transcribe(cfg, clip, workdir)
            to_simplified(asr)
            asr_path.write_text(json.dumps(asr, ensure_ascii=False, indent=2), encoding="utf-8")
            stamp.write_text(sig, encoding="utf-8")

    # 校对稿是人工核对过的字，后面即便跳过字幕层也要留给钩子选词
    corr_lines = list(lines) if (corrections and corrections.get("lines")) else []

    ass_mv = None
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
            ass_mv = cover_centered_margin_v(cfg, cover_bars) if cover_bars else int(cfg["subtitle"]["margin_v"])
            if cover_bars:
                log(f"cover 字幕垂直居中：margin_v={ass_mv}（相对模糊条）")
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

    # 2026-11-11（宝哥拍板）：开头 1.5 秒钩子。字幕按规则跳过时仍可加钩子卡，
    # 只有校对稿明确写「skip」（只出画面）才不加。跳过了转写时用缓存 asr.json 选词。
    hook = None
    if not skip_by_correction and skip_subs and legacy and not corr_lines:
        # 跳过字幕且没有校对稿：钩子直接读画面上的烧录字幕
        hook = hook_from_legacy_ocr(cfg, clip, workdir, legacy, dur)
    elif not skip_by_correction:
        hook_asr = asr
        hook_lines = corr_lines or lines
        if not hook_asr and not lines:
            cache = workdir / "asr.json"
            if cache.exists():
                try:
                    hook_asr = json.loads(cache.read_text(encoding="utf-8"))
                    to_simplified(hook_asr)
                except Exception as exc:
                    log(f"钩子读取缓存 ASR 失败：{exc}")
                    hook_asr = []
        # 跳过字幕的素材没有 lines，用 build_lines 现切一份自然短句给钩子选词，
        # 比从整段口播里按字数硬截更不容易切出半句话
        if not hook_lines and hook_asr:
            try:
                hook_lines = build_lines(hook_asr, dur, cfg)
            except Exception as exc:
                log(f"钩子切句失败：{exc}")
                hook_lines = []
        hook = pick_hook(cfg, hook_lines, hook_asr, fallback=brand.get("product") or brand.get("brand"))
    if hook:
        log(f"开头钩子：{hook['text']}（{hook['duration']}s，{hook['source']}）")
    if lines or hook:
        ass_path = workdir / "subs.ass"
        mv = ass_mv if ass_mv is not None else int(cfg["subtitle"]["margin_v"])
        ass_path.write_text(build_ass(cfg, lines, margin_v=mv, hook=hook), encoding="utf-8")
        ass_rel = str(ass_path.relative_to(ROOT)).replace("\\", "/")

    # 字幕被跳过时仍用 ASR 文本给 BGM 选曲（结果已缓存，不重复识别）
    hint = asr_text + stem + (brand.get("brand") or "") + (brand.get("store") or "")
    bgm = pick_bgm(cfg, hint)
    log(f"BGM：{bgm.name}")

    fx_frames, sfx_path = opening_fx.build_opening_fx(cfg, workdir)
    if fx_frames:
        n_frames = len(list(Path(fx_frames).glob("*.png")))
        log(f"片头白线冲刺：{n_frames} 帧 + whoosh 音效")

    out_dir = Path(cfg["paths"]["output_dir"])
    if args.name:
        name = args.name
    elif (cfg.get("naming") or {}).get("keep_source_name"):
        # 宝哥要求：Z 线本地剪辑的成片保持原素材名，不加日期前缀（2026-11-17）
        name = f"{stem}.mp4"
    else:
        # 同一天同品牌的多条素材前 8 个字相同，直接拼日期会互相覆盖；
        # 加源文件名指纹，保证唯一且可复现（--skip-existing 仍按同名判断）
        key = hashlib.md5(stem.encode("utf-8")).hexdigest()[:6]
        name = f"{datetime.now().month}月{datetime.now().day}日_{stem[:8]}_{key}.mp4"
    out_path = out_dir / name
    # A6（2026-11-08）：--skip-existing 按参数语义真正生效——同名成片已在 +
    # 上次自检 ok + 素材没比成片更新，就跳过不重渲，别整批再转一遍
    if args.skip_existing and out_path.exists():
        meta_path = workdir / "meta.json"
        prev = {}
        if meta_path.exists():
            try:
                prev = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                prev = {}
        prev_ok = bool((prev.get("verify") or {}).get("ok"))
        try:
            src_older = clip.stat().st_mtime <= out_path.stat().st_mtime
        except OSError:
            src_older = False
        if prev_ok and src_older:
            log(f"跳过（同名成片已存在且自检通过）：{out_path.name}")
            return {
                "clip": str(clip), "output": str(out_path), "skipped": True,
                "verify": prev.get("verify") or {"ok": True},
            }
    render(cfg, clip, workdir, ass_rel, bgm, dur, out_path, fx_frames, sfx_path, cover_bars, hook)

    check = verify_output(cfg, out_path, workdir, dur)
    brand_ocr.write_index(cfg, stem, clip, brand, out_path)
    meta = {
        "clip": str(clip),
        "output": str(out_path),
        "duration": dur,
        "bgm": str(bgm),
        "brand": brand,
        "legacy_sub": legacy,
        # 没有叠字幕也要记 True：校对稿 skip（原素材无字幕、ASR 错字多）时
        # 字幕闸门要能认出「这条本来就没有字幕层」，否则当「缺少字幕依据」卡成 manual
        "subtitle_skipped": bool(skip_subs or skip_by_correction),
        "lines": lines,
        "hook": hook,
        "opening_fx": bool(fx_frames),
        "verify": check,
        "elapsed_sec": round(time.time() - t0, 1),
    }
    # 重剪同一条素材会覆盖 meta.json，上一版成片与自检记录就查不到了；
    # 成片名变了（重剪/改名）就先把旧 meta 备份一份再写
    meta_path = workdir / "meta.json"
    if meta_path.exists():
        try:
            prev = json.loads(meta_path.read_text(encoding="utf-8"))
            prev_out = Path(prev.get("output", "")).name
        except Exception:
            prev_out = ""
        if prev_out and prev_out != out_path.name:
            bak = workdir / f"meta.json.bak-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
            if not bak.exists():
                shutil.copy2(meta_path, bak)
                log(f"旧 meta 已备份：{bak.name}")
    meta_path.write_text(
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
    ap.add_argument("--source-dir", help="覆盖素材目录（重剪已归档的源素材时用，如 素材库/未剪素材/已剪）")
    ap.add_argument("--hook-only", action="store_true",
                    help="库存成片只叠开头钩子卡：不推近、不重烧字幕、不动音频（缺原始素材的片用）")
    args = ap.parse_args()
    cfg = load_config(args.config)
    stock_dir = cfg["paths"]["output_dir"]  # --out-dir 覆盖前先记住库存目录
    if args.out_dir:
        cfg["paths"]["output_dir"] = args.out_dir
    if args.source_dir:
        cfg["paths"]["source_dir"] = args.source_dir

    if args.hook_only:
        if not args.clip:
            log("--hook-only 需要 --clip 指定成片名")
            return
        vdir = Path(stock_dir)
        if not vdir.is_absolute():
            vdir = ROOT / vdir
        cand = Path(args.clip)
        if not cand.is_absolute():
            exact = vdir / args.clip
            cand = exact if exact.exists() else None
        if cand is None or not cand.exists():
            hits = [p for p in vdir.iterdir()
                    if p.is_file() and p.suffix.lower() in (".mp4", ".mov", ".mkv")
                    and args.clip in p.name]
            if len(hits) != 1:
                log(f"成片匹配到 {len(hits)} 条，请写更长片段：")
                for p in hits:
                    print(f"  {p.name}")
                return
            cand = hits[0]
        try:
            res = hook_only(cfg, cand, args)
            log("完成 1/1 条" if not res.get("skipped") else "跳过 1 条")
        except Exception as exc:
            import traceback

            log(f"失败 {cand.name}：{exc}")
            traceback.print_exc()
        return

    if args.brand_scan:
        _heavy()
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

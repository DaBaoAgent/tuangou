#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""片头白线冲刺特效与音效（本地确定性生成，不依赖外部素材）。

特效：以人物为中心、四周向外扩散的白色放射线，中间留出椭圆空区不挡人；
0.6s 内淡入、外扩、淡出。输出 PNG 序列，交给 ffmpeg overlay。

音效：程序合成的呼啸 whoosh（扫频噪声 + 低频冲击），0.9s，立体声 WAV。
"""

import hashlib
import json
import math
import shutil
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def _params(cfg):
    fx = dict(cfg["opening_fx"])
    fx["_w"] = cfg["video"]["width"]
    fx["_h"] = cfg["video"]["height"]
    fx["_fps"] = cfg["video"]["fps"]
    fx["_sr"] = cfg["video"]["audio_rate"]
    return fx


def _key(cfg):
    return hashlib.sha1(
        json.dumps(_params(cfg), sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:12]


def build_opening_fx(cfg, workdir):
    """返回 (frames_dir, sfx_path)；关闭时返回 (None, None)。结果按配置哈希缓存。"""
    if not cfg["opening_fx"].get("enabled", True):
        return None, None
    out = Path(workdir) / "fx"
    frames = out / "frames"
    wav = out / "whoosh.wav"
    stamp = out / "build.json"
    key = _key(cfg)
    if stamp.exists() and frames.is_dir() and wav.exists():
        try:
            if json.loads(stamp.read_text(encoding="utf-8")).get("key") == key:
                return frames, wav
        except Exception:
            pass
    if out.exists():
        shutil.rmtree(out)
    frames.mkdir(parents=True)
    _make_frames(cfg, frames)
    _make_whoosh(cfg, wav)
    stamp.write_text(json.dumps({"key": key}, ensure_ascii=False), encoding="utf-8")
    return frames, wav


def _ellipse_radius(theta, rx, ry):
    return 1.0 / math.sqrt((math.cos(theta) / rx) ** 2 + (math.sin(theta) / ry) ** 2)


def _make_frames(cfg, out_dir):
    fx = cfg["opening_fx"]
    W, H = cfg["video"]["width"], cfg["video"]["height"]
    fps = cfg["video"]["fps"]
    dur = float(fx["duration"])
    n = max(2, int(round(dur * fps)))
    cx = W * float(fx["center_x_ratio"])
    cy = H * float(fx["center_y_ratio"])
    rx, ry = float(fx["inner_rx"]), float(fx["inner_ry"])
    diag = math.hypot(W, H)
    rng = np.random.default_rng(int(fx["seed"]))

    # (角度, 起始半径, 长度, 外端宽度, 不透明度, 外扩速度)
    lines = []
    for _ in range(int(fx["line_count"])):
        th = rng.uniform(0, 2 * math.pi)
        lines.append((
            th,
            _ellipse_radius(th, rx, ry) + rng.uniform(2, 28),
            rng.uniform(0.12, 0.36) * diag,
            rng.uniform(2.0, 6.0),
            rng.uniform(0.40, 0.90),
            rng.uniform(120, 380),
        ))
    for _ in range(int(fx["accent_lines"])):
        th = rng.uniform(0, 2 * math.pi)
        lines.append((
            th,
            _ellipse_radius(th, rx, ry) + rng.uniform(0, 14),
            rng.uniform(0.32, 0.55) * diag,
            rng.uniform(4.0, 9.0),
            rng.uniform(0.75, 1.0),
            rng.uniform(480, 860),
        ))

    S = 2  # 2 倍超采样，边缘更顺滑
    for i in range(n):
        u = i / (n - 1)
        if u < 0.12:
            env = u / 0.12
        elif u > 0.55:
            env = max(0.0, (1.0 - u) / 0.45)
        else:
            env = 1.0
        img = Image.new("RGBA", (W * S, H * S), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        for th, re, length, w_out, alpha, speed in lines:
            r0 = re + speed * dur * u
            r1 = r0 + length
            ca, sa = math.cos(th), math.sin(th)
            nx, ny = -sa, ca
            apex = ((cx + ca * r0) * S, (cy + sa * r0) * S)
            p1 = ((cx + ca * r1 + nx * w_out / 2) * S, (cy + sa * r1 + ny * w_out / 2) * S)
            p2 = ((cx + ca * r1 - nx * w_out / 2) * S, (cy + sa * r1 - ny * w_out / 2) * S)
            d.polygon([apex, p1, p2], fill=(255, 255, 255, int(255 * alpha * env)))
        img = img.resize((W, H), Image.LANCZOS)
        img.save(out_dir / f"{i + 1:03d}.png")


def _make_whoosh(cfg, path):
    fx = cfg["opening_fx"]
    sr = int(cfg["video"]["audio_rate"])
    dur = float(fx["sfx_duration"])
    n = int(sr * dur)
    t = np.arange(n, dtype=np.float64) / sr
    rng = np.random.default_rng(int(fx["seed"]) + 1)

    # 扫频低通：0.18s 附近噪声最亮，形成「嗖」的呼啸
    fc = 550 + 4300 * np.exp(-((t - 0.18) / 0.13) ** 2)
    a = 1.0 - np.exp(-2.0 * np.pi * fc / sr)

    out = np.empty((n, 2), dtype=np.float64)
    for ch in range(2):
        x = rng.standard_normal(n)
        y = np.empty(n, dtype=np.float64)
        prev = 0.0
        for i in range(n):
            prev += a[i] * (x[i] - prev)
            y[i] = prev
        out[:, ch] = x - y  # 高通，去掉低频轰鸣

    # 幅度包络：0.12s 涨到峰值，再指数衰减，尾部 0.2s 收干
    env = np.zeros(n, dtype=np.float64)
    atk = max(1, int(0.12 * sr))
    env[:atk] = np.linspace(0.0, 1.0, atk) ** 1.2
    env[atk:] = np.exp(-(t[atk:] - t[atk - 1]) / 0.30)
    tail = max(1, int(0.2 * sr))
    env[-tail:] *= np.linspace(1.0, 0.0, tail) ** 2

    # 低频冲击，带一点「冲出去」的重量
    f = 60.0 + 120.0 * np.exp(-t / 0.09)
    phase = 2.0 * np.pi * np.cumsum(f) / sr
    thump = np.sin(phase) * np.exp(-t / 0.18) * 0.35
    thump[: int(0.008 * sr)] *= np.linspace(0.0, 1.0, int(0.008 * sr))

    mix = out * env[:, None] + thump[:, None]
    peak = np.abs(mix).max()
    target = float(fx["sfx_peak"])
    if peak > 0:
        mix *= target / peak
    pcm = (np.clip(mix, -1.0, 1.0) * 32767.0).astype(np.int16)

    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())

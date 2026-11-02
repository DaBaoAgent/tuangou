#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从画面 OCR + 口播文本识别团购品牌。

识别顺序：人工覆盖文件 > 画面 OCR > 口播 ASR。OCR 与 ASR 结论冲突时不猜，
直接标 needs_review。识别不到品牌同样标 needs_review，并给出画面里读到的候选文字。

品牌目录在 scripts/auto-edit/brands.json；人工覆盖写在
runtime/auto-edit/brand_overrides/<素材文件名去扩展名>.json：
  {"brand": "临榆炸鸡腿", "store": "XX店", "note": "宝哥确认"}
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import unicodedata
from datetime import datetime
from difflib import SequenceMatcher
from pathlib import Path
from urllib.request import Request, urlopen

VERSION = 4
KEEP_RE = re.compile(r"[^0-9A-Z\u4e00-\u9fff]")

DABAO_OCR_URL = os.environ.get("DABAO_OCR_URL", "http://127.0.0.1:18224")


def log(msg):
    print(f"[brand] {msg}", flush=True)


def normalize(text):
    text = unicodedata.normalize("NFKC", text or "").upper()
    return KEEP_RE.sub("", text)


def _similarity(block_norm, alias_norm, threshold):
    """返回 0~1 的匹配度；低于阈值的近似匹配按 0 处理。"""
    if not block_norm or not alias_norm:
        return 0.0
    if alias_norm in block_norm:
        return 1.0
    n = len(alias_norm)
    if n < 3:
        return 0.0
    best = 0.0
    if len(block_norm) <= n + 2:
        best = SequenceMatcher(None, alias_norm, block_norm).ratio()
    else:
        for i in range(len(block_norm) - n + 1):
            r = SequenceMatcher(None, alias_norm, block_norm[i:i + n]).ratio()
            if r > best:
                best = r
                if best >= 0.99:
                    break
    return best if best >= threshold else 0.0


def load_catalog(cfg):
    path = Path(cfg["paths"]["brands_file"])
    data = json.loads(path.read_text(encoding="utf-8"))
    brands = []
    seen = set()
    for b in data.get("brands", []):
        if not b.get("enabled", True):
            continue
        bid = b.get("id") or b.get("name")
        if bid in seen or not b.get("name"):
            raise ValueError(f"brands.json 品牌 id/name 重复或缺失：{bid}")
        seen.add(bid)
        aliases = [a for a in b.get("aliases", []) if len(normalize(a)) >= 2]
        if not aliases:
            raise ValueError(f"brands.json 品牌 {bid} 没有有效别名（别名至少 2 个字符）")
        brands.append({
            "id": bid,
            "name": b["name"],
            "aliases": aliases,
            "category": b.get("category", ""),
            "stores": b.get("stores", []),
            "verified": bool(b.get("verified", False)),
        })
    return {"brands": brands, "sha1": hashlib.sha1(path.read_bytes()).hexdigest()}


def _ocr_image(path, max_side_len=None):
    """调用本机 Dabao-OCR 常驻服务，返回 [{text, score}]。"""
    options = {"data.format": "dict"}
    if max_side_len:
        options["ocr.maxSideLen"] = int(max_side_len)
    payload = json.dumps({"path": str(path), "options": options}).encode("utf-8")
    req = Request(
        f"{DABAO_OCR_URL}/api/ocr",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        raise RuntimeError(
            f"Dabao-OCR 服务不可用（{DABAO_OCR_URL}）：{exc}；"
            r"可运行 D:\@kaifa\Dabao-OCR\scripts\serve.cmd 启动"
        ) from exc
    if data.get("code") == 101:
        return []
    if data.get("code") != 100:
        raise RuntimeError(f"Dabao-OCR 返回错误 code={data.get('code')}: {data.get('data')}")
    return [
        {"text": str(b.get("text", "")).strip(), "score": float(b.get("score") or 0)}
        for b in data.get("data") or []
    ]


def _extract_frames(video, frames_dir, fps, scale_width):
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir(parents=True)
    vf = f"fps={fps}"
    if scale_width:
        vf += f",scale={int(scale_width)}:-2"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-y", "-i", str(video), "-vf", vf,
         "-q:v", "3", str(frames_dir / "%03d.jpg")],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True,
    )
    return sorted(frames_dir.glob("*.jpg"))


def ocr_blocks(cfg, video, workdir, scale_width=None):
    """按配置抽帧并 OCR，返回 [{t, text, score}]。"""
    bc = cfg["brand_ocr"]
    scale = int(scale_width or bc["scale_width"])
    frames_dir = workdir / f"brand_frames_{scale}"
    files = _extract_frames(video, frames_dir, bc["sample_fps"], scale)
    blocks = []
    for f in files:
        t = round((int(f.stem) - 1) / bc["sample_fps"], 3)
        for item in _ocr_image(f, bc.get("max_side_len", 2048)):
            score = item["score"]
            if score < bc["min_ocr_score"]:
                continue
            text = item["text"]
            if len(normalize(text)) < 2:
                continue
            blocks.append({"t": t, "text": text, "score": round(score, 3)})
    return blocks


def _dedup_blocks(blocks):
    seen = set()
    out = []
    for b in blocks:
        key = (b["t"], normalize(b["text"]))
        if key in seen:
            continue
        seen.add(key)
        out.append(b)
    return out


def _match_text(text_norm, catalog, threshold):
    hits = []
    for brand in catalog["brands"]:
        best = (0.0, None)
        for alias in brand["aliases"]:
            sim = _similarity(text_norm, normalize(alias), threshold)
            if sim > best[0]:
                best = (sim, alias)
        if best[0] > 0:
            hits.append({"brand_id": brand["id"], "name": brand["name"],
                         "alias": best[1], "similarity": round(best[0], 3)})
    return hits


def _ocr_matches(blocks, catalog, threshold):
    matches = []
    for b in blocks:
        bnorm = normalize(b["text"])
        for hit in _match_text(bnorm, catalog, threshold):
            # 置信度以 OCR 识别质量为主，相似度只做小幅加权：
            # 品牌名只差一个字（如「爷爷不间茶」）仍有 0.8 相似度，不应因此判失败。
            confidence = b["score"] * (0.8 + 0.2 * hit["similarity"])
            matches.append({
                **hit,
                "t": b["t"],
                "text": b["text"],
                "ocr_score": b["score"],
                "score": round(confidence, 3),
                # 「MR」匹配「MR.X」这类短别名近似命中只算线索，必须人工确认
                "weak": len(normalize(hit["alias"])) <= 3 and hit["similarity"] < 0.999,
            })
    return matches


def _summarize_matches(matches):
    by_brand = {}
    for m in matches:
        by_brand.setdefault(m["brand_id"], []).append(m)
    summary = []
    for bid, ms in by_brand.items():
        best = max(ms, key=lambda m: m["score"])
        frames = len({m["t"] for m in ms})
        confidence = best["score"] + (0.02 if frames >= 2 else 0.0)
        summary.append({
            "brand_id": bid,
            "name": best["name"],
            "confidence": round(min(0.99, confidence), 3),
            "hits": frames,
            # 同一品牌只要有一帧完整读到别名（相似度 1.0），就不算「短别名近似」；
            # 否则分数更高的一条「MR」会盖掉同批里的完整「MR.X」。
            "weak": all(m.get("weak", False) for m in ms),
            "best": best,
            "evidence": sorted(ms, key=lambda m: -m["score"])[:5],
        })
    summary.sort(key=lambda x: (-x["confidence"], -x["hits"]))
    return summary


BRAND_HINTS = (
    "COFFEE", "CAFE", "TEA", "BURGER", "CHICKEN", "MILK", "DRINK",
    "咖啡", "奶茶", "汉堡", "炸鸡", "茶饮", "门店",
)


def _candidate_rank(b):
    """品牌名通常短、含英文或行业词；长中文多半是字幕，排后面。"""
    n = normalize(b["text"])
    rank = b["score"]
    if any(h in n for h in BRAND_HINTS):
        rank += 0.5
    letters = sum(ch.isascii() and ch.isalpha() for ch in n)
    if letters >= 3:
        rank += 0.3
    elif len(n) > 8:
        rank -= 0.4
    return rank


def _candidates(blocks, matches):
    """OCR 读到但没有命中任何品牌的短文本，作为人工复核线索。"""
    matched = {(m["t"], normalize(m["text"])) for m in matches}
    seen = set()
    out = []
    for b in sorted(blocks, key=_candidate_rank, reverse=True):
        n = normalize(b["text"])
        if (b["t"], n) in matched or n in seen or not (2 <= len(n) <= 14):
            continue
        if b["score"] < 0.7:
            continue
        seen.add(n)
        out.append({"text": b["text"], "score": b["score"], "t": b["t"]})
        if len(out) >= 10:
            break
    return out


def _brand_record(name, brand_id, category, source, confidence, store, needs_review,
                  evidence, candidates=None, asr_match=None, note=None, product=None):
    rec = {
        "brand": name,
        "brand_id": brand_id,
        "category": category,
        "store": store,
        "product": product,
        "source": source,
        "confidence": confidence,
        "needs_review": needs_review,
        "evidence": evidence,
        "candidates": candidates or [],
        "asr_match": asr_match,
    }
    if note:
        rec["note"] = note
    return rec


def _override(cfg, video):
    stem = video.stem
    path = Path(cfg["paths"]["brand_override_dir"]) / f"{stem}.json"
    if not path.exists():
        return None, path
    data = json.loads(path.read_text(encoding="utf-8"))
    if not data.get("brand"):
        return None, path
    return data, path


def _product_override(cfg, video):
    """商品人工确认：runtime/auto-edit/product_overrides/<素材名>.json"""
    path = Path(cfg["paths"].get("product_override_dir", "")) / f"{Path(video).stem}.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if data.get("product") else None


def _apply_product(rec, data):
    if not data:
        return rec
    rec["product"] = data["product"].strip()
    rec["product_source"] = "manual"
    if data.get("note"):
        rec["product_note"] = data["note"]
    return rec


def _cache_ok(path, video, sha1):
    if not path.exists():
        return False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return False
    cache = data.get("cache", {})
    return (
        cache.get("version") == VERSION
        and cache.get("catalog_sha1") == sha1
        and abs(float(cache.get("video_mtime", 0)) - video.stat().st_mtime) < 1e-6
    )


def detect_brand(cfg, video, workdir, asr_text="", force=False):
    """识别一条素材的品牌；结果缓存到 workdir/brand.json。"""
    video = Path(video)
    catalog = load_catalog(cfg)
    product_override = _product_override(cfg, video)
    override, override_path = _override(cfg, video)
    if override:
        name = override["brand"].strip()
        nname = normalize(name)
        hit = next((b for b in catalog["brands"]
                    if nname == normalize(b["name"])
                    or nname in {normalize(a) for a in b["aliases"]}), None)
        rec = _brand_record(
            hit["name"] if hit else name,
            hit["id"] if hit else None,
            hit.get("category", "") if hit else "",
            "manual",
            1.0,
            override.get("store"),
            False,
            [{"text": name, "source": str(override_path), "note": override.get("note", "")}],
            note=override.get("note"),
            product=override.get("product"),
        )
        if not hit:
            log(f"人工品牌「{name}」不在 brands.json，建议补录")
        rec = _apply_product(rec, product_override)
        return rec

    cache_path = workdir / "brand.json"
    if not force and _cache_ok(cache_path, video, catalog["sha1"]):
        data = json.loads(cache_path.read_text(encoding="utf-8"))
        data.pop("cache", None)
        data = _apply_product(data, product_override)
        log(f"复用品牌识别缓存：{data.get('brand') or '未识别'}")
        return data

    bc = cfg["brand_ocr"]
    threshold = bc["fuzzy_threshold"]
    asr_norm = normalize(asr_text)
    asr_hits = _match_text(asr_norm, catalog, threshold) if asr_norm else []
    asr_best = max(asr_hits, key=lambda h: h["similarity"]) if asr_hits else None

    blocks = []
    ocr_error = None
    if bc.get("enabled", True):
        try:
            blocks = ocr_blocks(cfg, video, workdir)
            if not _ocr_matches(blocks, catalog, threshold) and bc.get("retry_scale_width"):
                retry = int(bc["retry_scale_width"])
                log(f"首轮未识别到品牌，按 {retry} 宽重扫")
                blocks = _dedup_blocks(blocks + ocr_blocks(cfg, video, workdir, retry))
        except Exception as exc:
            ocr_error = str(exc)
            log(f"OCR 不可用：{exc}")
    matches = _ocr_matches(blocks, catalog, threshold)
    summary = _summarize_matches(matches)
    candidates = _candidates(blocks, matches)

    rec = None
    if len(summary) >= 2 and summary[0]["confidence"] - summary[1]["confidence"] < 0.05:
        rec = _brand_record(
            None, None, "", "ocr", 0.0, None, True,
            [m for s in summary[:2] for m in s["evidence"]],
            candidates,
            asr_best,
            note="画面同时出现两个品牌且置信接近，需人工确认",
        )
    elif summary and summary[0]["confidence"] >= bc["min_confidence"]:
        top = summary[0]
        if asr_best and asr_best["brand_id"] != top["brand_id"]:
            rec = _brand_record(
                None, None, "", "conflict", 0.0, None, True,
                top["evidence"], candidates, asr_best,
                note=f"画面={top['name']}，口播={asr_best['name']}，需人工确认",
            )
        else:
            source = "ocr+asr" if asr_best else "ocr"
            weak = top.get("weak", False) and not asr_best
            category = next(
                (b["category"] for b in catalog["brands"] if b["id"] == top["brand_id"]), ""
            )
            rec = _brand_record(
                top["name"], top["brand_id"], category,
                source, top["confidence"], None, weak,
                top["evidence"], [], asr_best,
                note="画面只读到短别名的近似匹配，需人工确认" if weak else None,
            )
    elif asr_best:
        rec = _brand_record(
            asr_best["name"], asr_best["brand_id"], "", "asr",
            round(asr_best["similarity"] * 0.8, 3), None, True,
            [], candidates, asr_best,
            note="只有口播命中，画面未确认，需人工复核",
        )
    else:
        rec = _brand_record(
            None, None, "", "none", 0.0, None, True, [], candidates, None,
            note=ocr_error or "画面与口播都没有识别到目录内品牌",
        )

    rec = _apply_product(rec, product_override)
    rec["scanned_at"] = datetime.now().isoformat(timespec="seconds")
    rec["ocr_blocks"] = len(blocks)
    cache_path.write_text(
        json.dumps({"cache": {"version": VERSION, "catalog_sha1": catalog["sha1"],
                              "video_mtime": video.stat().st_mtime}, **rec},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if rec["brand"]:
        log(f"品牌：{rec['brand']}（{rec['source']}，置信 {rec['confidence']:.2f}，"
            f"{len(rec['evidence'])} 条证据）")
    else:
        log("品牌未识别，需人工复核" + (
            f"；画面候选：{', '.join(c['text'] for c in candidates[:5])}" if candidates else ""
        ))
    return rec


def write_index(cfg, stem, clip, rec, output=None):
    path = Path(cfg["paths"]["brand_index_file"])
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        index = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except Exception:
        index = {}
    index[stem] = {
        "clip": Path(clip).name,
        "clip_path": str(clip),
        "output": str(output) if output else (index.get(stem) or {}).get("output"),
        "brand": rec.get("brand"),
        "brand_id": rec.get("brand_id"),
        "store": rec.get("store"),
        "product": rec.get("product"),
        "confidence": rec.get("confidence"),
        "source": rec.get("source"),
        "needs_review": rec.get("needs_review"),
        "evidence": [
            {"t": e.get("t"), "text": e.get("text"), "score": e.get("score"),
             "ocr_score": e.get("ocr_score"), "similarity": e.get("similarity")}
            for e in rec.get("evidence", []) if "t" in e
        ],
        "candidates": rec.get("candidates", []),
        "updated_at": datetime.now().isoformat(timespec="seconds"),
    }
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)
    return path

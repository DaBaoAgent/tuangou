// 字幕发布闸门（宝哥 2026-11-04 固化）：
// 新成片必须先过字幕 OCR 复核才能进入自动发布队列。
// - 自动剪辑成片：按 meta.lines（烧录字幕的来源）逐行 OCR 复核。
// - 手工成片 / 已修字成片：按 subtitle_repair.corrections 复核。
// - 没有校对依据的手工新片：标记 manual，暂缓发布，等人确认。
// - 复核失败：整条移到「字幕待修复」，更新 meta/brand_index，不再自动发。
// 结果按文件 mtime+size 缓存在 runtime/publish/subtitle_audit.json，未变更不重复 OCR。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('./lib');

const ROOT = L.ROOT;
const CONFIG = L.CONFIG;
const CACHE_PATH = CONFIG.paths.subtitle_audit_cache
  || path.join(CONFIG.paths.work_dir, 'subtitle_audit.json');
const PYTHON = process.env.DANBAO_PYTHON || 'D:/@kaifa/openviking/.venv/Scripts/python.exe';
const AUDIT_CLIP = path.join(ROOT, 'scripts/auto-edit/audit_clip.py');
const DEFAULT_ENFORCE_SINCE = '2026-11-04T19:00:00+08:00';

function enforceSinceMs() {
  return Date.parse(CONFIG.publish.subtitle_enforce_since || DEFAULT_ENFORCE_SINCE);
}

function reviewDir() {
  return CONFIG.paths.subtitle_review_dir
    || path.join(CONFIG.paths.video_dir, '字幕待修复');
}

function loadCache() {
  const c = L.readJson(CACHE_PATH, null);
  if (c && c.clips) return c;
  return { updated_at: null, clips: {} };
}
function saveCache(cache) {
  cache.updated_at = new Date().toISOString();
  L.writeJson(CACHE_PATH, cache);
}

function listTopVideos(dir) {
  if (!fs.existsSync(dir)) return [];
  const stableMs = 2 * 60 * 1000;
  return fs.readdirSync(dir)
    .filter(f => /\.(mp4|mov|mkv)$/i.test(f))
    .filter(f => !f.startsWith('_') && !f.startsWith('审核样片'))
    .map(f => path.join(dir, f))
    .filter(p => { try { return Date.now() - fs.statSync(p).mtimeMs > stableMs; } catch { return false; } });
}

function workMetas() {
  const out = [];
  const root = CONFIG.paths.auto_edit_work;
  if (!fs.existsSync(root)) return out;
  for (const d of fs.readdirSync(root)) {
    const m = L.readJson(path.join(root, d, 'meta.json'), null);
    if (m) out.push({ dir: d, m });
  }
  return out;
}

function findMeta(metas, video) {
  const base = path.basename(video);
  return metas.find(x => x.m.output && path.basename(x.m.output) === base) || null;
}

function expectedFor(meta) {
  const repair = meta.subtitle_repair;
  if (repair && repair.corrections && fs.existsSync(repair.corrections)) {
    const c = L.readJson(repair.corrections, null);
    if (c && Array.isArray(c.lines) && c.lines.length) {
      return { kind: 'corrections', lines: c.lines };
    }
  }
  const lines = Array.isArray(meta.lines) ? meta.lines.filter(x => x && x.text) : [];
  if (meta.subtitle_skipped === true) return { kind: 'skipped', lines: [] };
  const autoRendered = !!(meta.verify && Array.isArray(meta.verify.frames) && meta.verify.frames.length);
  if (autoRendered && lines.length) return { kind: 'auto', lines };
  if (lines.length) return { kind: 'external', lines };
  return { kind: 'none', lines: [] };
}

function bandFor(meta) {
  const bars = (meta.subtitle_repair && meta.subtitle_repair.cover_bars) || [];
  if (bars.length) {
    const y0 = Math.max(0, Math.min(...bars.map(b => Number(b.y0))) - 60);
    const y1 = Math.max(...bars.map(b => Number(b.y1))) + 60;
    return {
      bandY: y0, bandH: y1 - y0,
      tightY: y0 + 20, tightH: Math.max(40, (y1 - y0) - 40),
    };
  }
  return { bandY: 1360, bandH: 400, tightY: 1455, tightH: 130 };
}

function runAudit(video, meta, lines, band) {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'subaudit-'));
  const linesFile = path.join(tmpDir, 'lines.json');
  fs.writeFileSync(linesFile, JSON.stringify({ lines }, null, 2));
  const res = spawnSync(PYTHON, [
    AUDIT_CLIP,
    '--video', video,
    '--lines-file', linesFile,
    '--band-y', String(band.bandY),
    '--band-h', String(band.bandH),
    '--tight-y', String(band.tightY),
    '--tight-h', String(band.tightH),
  ], { encoding: 'utf8', timeout: 180000 });
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (res.error || res.status !== 0) {
    return { status: 'unavailable', ok: false, error: (res.error && res.error.message) || res.stderr || 'audit failed' };
  }
  try {
    const line = String(res.stdout).trim().split(/\r?\n/).pop();
    return JSON.parse(line);
  } catch {
    return { status: 'unavailable', ok: false, error: 'bad audit output' };
  }
}

function moveToReview(video, destDir, metas, brandIndex, clipKey) {
  L.ensureDir(destDir);
  const base = path.basename(video);
  let dest = path.join(destDir, base);
  if (fs.existsSync(dest)) {
    const ext = path.extname(base);
    dest = path.join(destDir, `${path.basename(base, ext)}_${Date.now()}${ext}`);
  }
  fs.renameSync(video, dest);
  const hit = metas.find(x => x.dir === clipKey);
  if (hit) {
    hit.m.output = dest;
    L.writeJson(path.join(CONFIG.paths.auto_edit_work, hit.dir, 'meta.json'), hit.m);
  }
  if (brandIndex[clipKey]) {
    brandIndex[clipKey].output = dest;
    brandIndex[clipKey].updated_at = new Date().toISOString();
  }
  return dest;
}

// 扫描待发目录：补齐缓存 / 审计新片 / 把失败片移到「字幕待修复」
function auditInventory(opts = {}) {
  const dryRun = !!opts.dryRun;
  const auditFn = opts.auditFn || runAudit;
  const videoDir = opts.videoDir || CONFIG.paths.video_dir;
  const destDir = opts.reviewDir || reviewDir();
  const since = opts.enforceSinceMs != null ? opts.enforceSinceMs : enforceSinceMs();
  const cache = loadCache();
  const metas = workMetas();
  const brandIndex = L.readJson(CONFIG.paths.brand_index, {});
  const result = { audited: 0, cached: 0, skipped: 0, manual: [], failed: [], unavailable: [], moved: [] };

  for (const video of listTopVideos(videoDir)) {
    const base = path.basename(video);
    const hit = findMeta(metas, video);
    const clipKey = hit ? hit.dir : base.replace(/\.[^.]+$/, '');
    const meta = hit ? hit.m : {};
    let stat;
    try { stat = fs.statSync(video); } catch { continue; }
    const prev = cache.clips[clipKey];
    // unavailable 是临时故障，不信任缓存：下一轮重试，避免 OCR 恢复后成片被永久卡住
    if (prev && prev.status !== 'unavailable' && prev.mtime_ms === stat.mtimeMs && prev.size === stat.size) {
      result.cached++;
      if (prev.status === 'manual') result.manual.push({ file: base, reason: prev.reason });
      if (prev.status === 'fail') result.failed.push({ file: base, reason: prev.reason, to: prev.to });
      if (prev.status === 'unavailable') result.unavailable.push({ file: base });
      if (prev.status === 'skipped' || prev.status === 'legacy_ok') result.skipped++;
      continue;
    }

    const exp = expectedFor(meta);
    const rec = {
      mtime_ms: stat.mtimeMs, size: stat.size, checked_at: new Date().toISOString(), kind: exp.kind,
    };

    if (stat.mtimeMs < since) {
      Object.assign(rec, { status: 'legacy_ok', ok: true, reason: 'enforced after this clip' });
      cache.clips[clipKey] = rec;
      result.skipped++;
      continue;
    }

    if (exp.kind === 'skipped') {
      Object.assign(rec, { status: 'skipped', ok: true });
      cache.clips[clipKey] = rec;
      result.skipped++;
      continue;
    }

    if (exp.kind === 'manual' || exp.kind === 'external' || exp.kind === 'none') {
      Object.assign(rec, {
        status: 'manual', ok: false,
        reason: exp.kind === 'external'
          ? '手工成片缺少字幕校对稿，需人工确认字幕'
          : '缺少字幕依据，需人工确认',
      });
      cache.clips[clipKey] = rec;
      result.manual.push({ file: base, reason: rec.reason });
      continue;
    }

    result.audited++;
    const out = auditFn(video, meta, exp.lines, bandFor(meta));
    const status = out.status || (out.ok ? 'ok' : 'fail');
    Object.assign(rec, { status, ok: !!out.ok, checked: out.checked, bad: out.bad, error: out.error });
    if (status === 'unavailable') {
      result.unavailable.push({ file: base, error: out.error });
    } else if (status === 'ok') {
      result.skipped++;
    } else {
      const reason = (out.bad && out.bad[0] && `${out.bad[0].expect} -> ${out.bad[0].got}`) || '字幕复核失败';
      rec.reason = reason;
      if (!dryRun) {
        rec.to = moveToReview(video, destDir, metas, brandIndex, clipKey);
        result.moved.push({ file: base, to: rec.to });
      }
      result.failed.push({ file: base, reason, to: rec.to || null });
    }
    cache.clips[clipKey] = rec;
  }

  if (!dryRun) {
    if (result.moved.length) L.writeJson(CONFIG.paths.brand_index, brandIndex);
    saveCache(cache);
  }
  return result;
}

function confirmed(videoInfo) {
  if (!videoInfo || !videoInfo.clipKey) return false;
  const rec = loadCache().clips[videoInfo.clipKey];
  if (!rec) return false;
  return rec.ok === true && ['ok', 'skipped', 'legacy_ok'].includes(rec.status);
}

module.exports = {
  CACHE_PATH, enforceSinceMs, reviewDir,
  loadCache, saveCache, expectedFor, bandFor, auditInventory, confirmed,
};

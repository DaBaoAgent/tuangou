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
// 人工放行名单（2026-11-17）：外部剪辑线（Z 盘）的成片项目里没有校对稿，闸门会判「缺字幕依据」并移进
// 字幕待修复。这类片由宝哥人工看过并验收字幕，登记在 scripts/publish/subtitle_approved.json 放行；
// 必须带 mtime+size 指纹，换片/重渲后指纹变了就自动失效，要重新审核。
const APPROVED_PATH = path.join(__dirname, 'subtitle_approved.json');

function loadApproved() {
  const j = L.readJson(APPROVED_PATH, null);
  return (j && j.clips && typeof j.clips === 'object') ? j.clips : {};
}

function approvedFor(clips, base, stat) {
  const e = clips[base];
  if (!e) return null;
  if (Number(e.size) !== stat.size || Number(e.mtime_ms) !== Math.round(stat.mtimeMs)) return null;
  return e;
}
// 审计用的 Python（A5，2026-11-08）：环境变量 → 通用媒体 venv → 剪辑用的 Python312 → PATH 里的 python，
// 取第一个存在的；不再死绑另一个项目的 venv。
// 候选链和"是否真能跑"由 lib 统一判断（A5）：环境变量 → 各大 venv → uv/常规安装 → PATH，
// 不再把另一个项目的 venv 当唯一依靠，也不会挑到"文件在但一执行就退"的解释器。
let PYTHON_CACHE = null;
function python() {
  if (!PYTHON_CACHE) {
    // A（2026-11-08 宝哥要求）：项目自带 .venv 排第一，原来两个候选留作后备；
    // 字幕审计只要 numpy，保持轻量 probe，取不到就自动落到下一个。
    PYTHON_CACHE = L.resolvePython([
      path.join(ROOT, '.venv/Scripts/python.exe'),
      process.env.DANBAO_PYTHON,
      'D:/@kaifa/tools/python-media/Scripts/python.exe',
      'C:/Users/20200/AppData/Local/Programs/Python/Python312/python.exe'], 'import numpy');
  }
  return PYTHON_CACHE;
}

// 批量预算（A2，2026-11-08）：一轮最多审 N 条、总耗时不超过预算，剩下的留给下一轮。
// 预算必须明显低于锁过期时间（默认 600s 对 1800s），否则上一轮还没跑完下一轮就判锁过期、重跑同一批。
const MAX_AUDITS_PER_ROUND = Math.max(1, Number(CONFIG.publish.subtitle_max_audits ?? 3));
const ROUND_BUDGET_MS = Math.max(60, Number(CONFIG.publish.subtitle_round_budget_sec ?? 600)) * 1000;
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

// B8（2026-11-08）：meta 一次建两个 Map（clipKey → 记录、成片名 → 记录），
// 成片多时不再每条都全表 find，避免 O(n²)
function workMetas() {
  const map = new Map();
  const byOutput = new Map();
  const root = CONFIG.paths.auto_edit_work;
  map.byOutput = byOutput;
  if (!fs.existsSync(root)) return map;
  for (const d of fs.readdirSync(root)) {
    const m = L.readJson(path.join(root, d, 'meta.json'), null);
    if (!m) continue;
    const rec = { dir: d, m };
    map.set(d, rec);
    if (m.output) byOutput.set(path.basename(m.output), rec);
  }
  return map;
}

function findMeta(metas, video) {
  return (metas.byOutput && metas.byOutput.get(path.basename(video))) || null;
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
  const res = spawnSync(python(), [
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
  const hit = metas.get(clipKey) || null;
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

// A3（2026-11-08）：manual 超过 N 小时（默认 24）仍没有校对稿，就移进「字幕待修复」，
// 不再原地无限等、也不再每小时提醒一次。
function handleManualExpiry(video, base, stat, rec, ctx) {
  if (rec.manual_moved_to) return;
  const ttlH = Number(CONFIG.publish.subtitle_manual_ttl_hours ?? 24);
  if (Date.now() - stat.mtimeMs < ttlH * 3600 * 1000) return;
  if (ctx.dryRun) { ctx.result.pending_manual_moves = (ctx.result.pending_manual_moves || 0) + 1; return; }
  try {
    const to = moveToReview(video, ctx.destDir, ctx.metas, ctx.brandIndex, ctx.clipKey);
    rec.manual_moved_to = to;
    rec.reason = `超过 ${ttlH} 小时没有字幕校对稿，已移入字幕待修复`;
    ctx.result.moved.push({ file: base, to, reason: rec.reason });
    ctx.result.manual = ctx.result.manual.filter(m => m.file !== base);
  } catch (e) {
    rec.reason = 'manual timeout, move failed: ' + e.message;
  }
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
  const approved = loadApproved();
  const result = { audited: 0, cached: 0, skipped: 0, approved: 0, manual: [], failed: [], unavailable: [], moved: [], deferred: 0 };
  const startedAt = Date.now();

  for (const video of listTopVideos(videoDir)) {
    const base = path.basename(video);
    const hit = findMeta(metas, video);
    const clipKey = hit ? hit.dir : base.replace(/\.[^.]+$/, '');
    const meta = hit ? hit.m : {};
    let stat;
    try { stat = fs.statSync(video); } catch { continue; }
    // 人工放行名单优先：外部剪辑线成片没有项目校对稿，宝哥验收后按指纹登记放行
    const app = approvedFor(approved, base, stat);
    if (app) {
      cache.clips[clipKey] = {
        mtime_ms: stat.mtimeMs, size: stat.size, checked_at: new Date().toISOString(),
        kind: 'approved', status: 'approved', ok: true,
        reason: `人工放行：${app.approved_by || '宝哥'} ${app.approved_at || ''} ${app.note || ''}`.trim(),
      };
      result.approved++;
      continue;
    }
    const prev = cache.clips[clipKey];
    // unavailable 是临时故障，不信任缓存：下一轮重试，避免 OCR 恢复后成片被永久卡住
    if (prev && prev.status !== 'unavailable' && prev.mtime_ms === stat.mtimeMs && prev.size === stat.size) {
      result.cached++;
      if (prev.status === 'manual') {
        result.manual.push({ file: base, reason: prev.reason });
        handleManualExpiry(video, base, stat, prev, { dryRun, destDir, metas, brandIndex, clipKey, result });
      }
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
      handleManualExpiry(video, base, stat, rec, { dryRun, destDir, metas, brandIndex, clipKey, result });
      continue;
    }

    // 预算用完就停：本轮不再 OCR，剩下的下一轮继续（未确认的成片本来就不进发布队列）
    if (result.audited >= MAX_AUDITS_PER_ROUND || Date.now() - startedAt > ROUND_BUDGET_MS) {
      result.deferred++;
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
  if (rec && rec.ok === true && ['ok', 'skipped', 'legacy_ok', 'approved'].includes(rec.status)) return true;
  // 缓存还没落盘（比如刚登记放行、闸门还没跑到）时，直接按人工放行名单判定；指纹不匹配就不放行
  try {
    if (!videoInfo.path) return false;
    const stat = fs.statSync(videoInfo.path);
    if (approvedFor(loadApproved(), path.basename(videoInfo.path), stat)) return true;
  } catch { /* 读不到文件就按未确认处理 */ }
  return false;
}

module.exports = {
  CACHE_PATH, APPROVED_PATH, enforceSinceMs, reviewDir,
  loadCache, saveCache, expectedFor, bandFor, auditInventory, confirmed, loadApproved, approvedFor,
};

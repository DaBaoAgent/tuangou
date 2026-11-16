const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const A = require('./analytics');
const QS = require('./queue_score');

// B1（2026-11-08）：项目根按本文件位置推导，换盘/换目录都不用改这里
function resolveRoot() {
  const env = String(process.env.TUANGOU_ROOT || '').trim();
  if (env) return env.replace(/\\/g, '/');
  const rel = path.resolve(__dirname, '..', '..').replace(/\\/g, '/');
  try { if (fs.existsSync(path.join(rel, 'scripts/auto-edit/brands.json'))) return rel; } catch {}
  // 位置推导失败（沙箱/临时拷贝）才回退历史固定路径
  return 'D:/@kaifa/tuangou';
}
const ROOT = resolveRoot();
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
// B1（2026-11-08）：配置里的相对路径统一按 ROOT 解析，脚本在任意工作目录启动都指向同一份数据
for (const [k, v] of Object.entries(CONFIG.paths || {})) {
  if (typeof v === 'string' && v && !path.isAbsolute(v)) CONFIG.paths[k] = path.join(ROOT, v).replace(/\\/g, '/');
}
// B2（2026-11-08）：品牌库路径也走配置，不再硬编码
const BRANDS = JSON.parse(fs.readFileSync(CONFIG.paths.brands_file || path.join(ROOT, 'scripts/auto-edit/brands.json'), 'utf8'));

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}


function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function minutesOf(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function hhmmOf(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function dayIndex(dateStr) {
  const start = new Date(CONFIG.schedule.start_date + 'T00:00:00');
  const cur = new Date(dateStr + 'T00:00:00');
  return Math.floor((cur - start) / 86400000) + 1;
}

function statePath() { return path.join(CONFIG.paths.work_dir, 'state.json'); }
function loadState() {
  return readJson(statePath(), { paused: false, paused_reason: null, history: [], used_title_suffix: [] });
}
function saveState(s) { writeJson(statePath(), s); }

function planPath(dateStr) { return path.join(CONFIG.paths.work_dir, 'plans', `${dateStr}.json`); }
function loadPlan(dateStr) { return readJson(planPath(dateStr), null); }
function savePlan(dateStr, plan) { writeJson(planPath(dateStr), plan); }

// 2026-11-11：同品牌冷却/每日上限的数据源。只有计划条目带 brand（state.history 不带），
// 所以回看最近几天计划里状态为 published 的条目；缺 published_at 的旧条目用「计划日期 + at」近似。
function publishedAtMs(item, dateStr) {
  const explicit = item.published_at || item.publishedAt;
  const t = explicit ? Date.parse(explicit) : NaN;
  if (Number.isFinite(t)) return t;
  const at = item.at || '00:00';
  const guess = Date.parse(`${dateStr}T${at}:00`);
  return Number.isFinite(guess) ? guess : 0;
}

function brandUsage(dateStr, opts = {}) {
  const days = Math.max(1, Number(opts.days ?? 2));
  const today = dateStr || todayStr();
  const base = new Date(`${today}T00:00:00`);
  const usage = {};
  if (Number.isNaN(base.getTime())) return usage;
  for (let d = days - 1; d >= 0; d--) {
    const ds = todayStr(new Date(base.getTime() - d * 86400000));
    const plan = loadPlan(ds);
    if (!plan || !Array.isArray(plan.items)) continue;
    for (const it of plan.items) {
      if (it.status !== 'published' || !it.brand) continue;
      const u = usage[it.brand] || (usage[it.brand] = { brand: it.brand, lastAt: null, lastMs: 0, todayCount: 0 });
      const ms = publishedAtMs(it, ds);
      if (ms > u.lastMs) { u.lastMs = ms; u.lastAt = new Date(ms).toISOString(); }
      if (ds === today) u.todayCount++;
    }
  }
  return usage;
}

// 稳定随机：同一天同一条计划可复现
function seededRandom(seedStr) {
  let h = crypto.createHash('sha256').update(seedStr).digest();
  let i = 0;
  return () => {
    if (i + 4 > h.length) { h = crypto.createHash('sha256').update(h).digest(); i = 0; }
    const v = h.readUInt32LE(i); i += 4;
    return v / 4294967296;
  };
}

function targetCount(dateStr) {
  const idx = dayIndex(dateStr);
  const ramp = CONFIG.schedule.ramp || [];
  const hit = ramp.find(r => r.day === idx);
  if (hit) return hit.count;
  if (idx < 1) return 0;
  const { steady_min, steady_max } = CONFIG.schedule;
  const rnd = seededRandom(`count:${dateStr}`);
  return steady_min + Math.floor(rnd() * (steady_max - steady_min + 1));
}

function buildTimes(dateStr, count, startMin, endMin) {
  const rnd = seededRandom(`times:${dateStr}`);
  const start = startMin ?? minutesOf(CONFIG.schedule.window.start);
  const end = endMin ?? minutesOf(CONFIG.schedule.window.end);
  const gap = CONFIG.schedule.min_gap_minutes;
  for (let attempt = 0; attempt < 500; attempt++) {
    const times = [];
    let ok = true;
    for (let i = 0; i < count; i++) {
      const t = start + Math.floor(rnd() * (end - start + 1));
      if (times.some(x => Math.abs(x - t) < gap)) { ok = false; break; }
      times.push(t);
    }
    if (ok) return times.sort((a, b) => a - b).map(hhmmOf);
  }
  // 极端兜底：时间窗放不下这么多间隔时宁可少发，也不能把多条挤在同一分钟（如 22:30）
  const span = Math.max(0, end - start);
  const fit = Math.max(1, Math.floor(span / gap) + 1);
  const n = Math.min(count, fit);
  const step = n > 1 ? Math.floor(span / (n - 1)) : 0;
  return Array.from({ length: n }, (_, i) => hhmmOf(start + i * step));
}

// 2026-11-10：按账号历史时段表现给发布时刻加权；样本不足（<30 条）或画像缺失时用原随机排期
function buildTimesProfiled(dateStr, count, startMin, endMin, buckets, weights) {
  const start = startMin ?? minutesOf(CONFIG.schedule.window.start);
  const end = endMin ?? minutesOf(CONFIG.schedule.window.end);
  const gap = CONFIG.schedule.min_gap_minutes;
  const rnd = seededRandom(`times:${dateStr}:profile`);
  if (!buckets || !buckets.length) return null;
  const ranges = buckets
    .map(b => {
      const key = `${String(b.from).padStart(2, '0')}-${String(b.to).padStart(2, '0')}`;
      const lo = Math.max(start, b.from * 60);
      const hi = Math.min(end, b.to * 60 - 1);
      return hi >= lo ? { lo, hi, weight: Number(weights[key]) > 0 ? Number(weights[key]) : 0.4 } : null;
    })
    .filter(Boolean);
  if (!ranges.length) return null;
  const total = ranges.reduce((s, r) => s + r.weight, 0);
  for (let attempt = 0; attempt < 800; attempt++) {
    const times = [];
    let ok = true;
    for (let i = 0; i < count; i++) {
      // 2026-11-11：只在「这一条」撞间隔时重抽，不再整轮作废。
      // 整轮作废会把偏好时段的权重一起洗掉（降量后尤其明显）。
      let t = null;
      for (let k = 0; k < 60; k++) {
        let pick = rnd() * total;
        const r = ranges.find(x => (pick -= x.weight) <= 0) || ranges[ranges.length - 1];
        const cand = r.lo + Math.floor(rnd() * (r.hi - r.lo + 1));
        if (!times.some(x => Math.abs(x - cand) < gap)) { t = cand; break; }
      }
      if (t === null) { ok = false; break; }
      times.push(t);
    }
    if (ok) return times.sort((a, b) => a - b).map(hhmmOf);
  }
  return null;
}

function planTimes(dateStr, count, startMin, endMin) {
  const base = buildTimes(dateStr, count, startMin, endMin);
  if (!CONFIG.publish.use_hour_profile) return base;
  const analytics = A.loadAnalytics(A.statsPaths(ROOT, CONFIG));
  if (!analytics || analytics.count < 30) return base;
  const weights = QS.hourWeights(analytics);
  if (!weights) return base;
  return buildTimesProfiled(dateStr, count, startMin, endMin, analytics.buckets, weights) || base;
}

function ensurePlan(dateStr, opts = {}) {
  let plan = loadPlan(dateStr);
  if (plan) return plan;
  const state = loadState();
  const doneToday = state.history.filter(h => h.date === dateStr).length;
  const count = targetCount(dateStr);
  const remaining = Math.max(0, count - doneToday);
  let times = planTimes(dateStr, remaining);
  // 当天首次建计划时，如果随机时间已过，就压缩到「现在+5分钟 ~ 当天窗口结束」之间
  if (dateStr === todayStr() && remaining > 0) {
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const windowStart = minutesOf(CONFIG.schedule.window.start);
    const windowEnd = minutesOf(CONFIG.schedule.window.end);
    const startMin = Math.max(windowStart, nowMin + 5);
    if (times.some(t => minutesOf(t) <= nowMin)) {
      times = startMin >= windowEnd - 5 ? [] : planTimes(dateStr, remaining, startMin, windowEnd);
    }
  }
  const items = [];
  for (let i = 0; i < doneToday; i++) {
    items.push({
      id: `${dateStr}-${String(i + 1).padStart(2, '0')}`,
      at: null,
      status: 'published',
      note: 'earlier-today',
    });
  }
  times.forEach((t, i) => {
    items.push({
      id: `${dateStr}-${String(doneToday + i + 1).padStart(2, '0')}`,
      at: t,
      status: 'pending',
    });
  });
  plan = {
    date: dateStr,
    day_index: dayIndex(dateStr),
    target_count: count,
    status: 'active',
    created_at: new Date().toISOString(),
    items,
  };
  if (opts.save !== false) savePlan(dateStr, plan);
  return plan;
}

// 来源黑名单（2026-11-14）：runtime/publish/source_blacklist.json。
// 「田」是另一个号专用素材目录，其原片与项目素材库存在同文件双份（SHA256 全等），
// 两线各剪一版会把另一号已发内容在本号重发，故双线都拒收（见 AGENTS 规则 8）。
const BLACKLIST_PATH = path.join(ROOT, 'scripts/publish/source_blacklist.json');
const BLACKLIST_RUNTIME_PATH = path.join(CONFIG.paths.work_dir || path.join(ROOT, 'runtime/publish'), 'source_blacklist.json');
function loadSourceBlacklist() {
  const b = readJson(BLACKLIST_PATH, null) || readJson(BLACKLIST_RUNTIME_PATH, {});
  return b && typeof b === 'object' ? b : {};
}
function blockedVideoNames() {
  const b = loadSourceBlacklist();
  return new Set(Array.isArray(b.video_names) ? b.video_names : []);
}
function isBlockedSource(file) {
  const b = loadSourceBlacklist();
  const norm = String(file || '').replace(/\\/g, '/');
  const base = path.basename(String(file || ''));
  const prefixes = (Array.isArray(b.source_path_prefixes) ? b.source_path_prefixes : [])
    .map(x => String(x || '').replace(/\\/g, '/'));
  if (prefixes.some(p => p && norm.startsWith(p))) return true;
  const pats = Array.isArray(b.source_name_patterns) ? b.source_name_patterns : [];
  return pats.some(p => { try { return new RegExp(p).test(base); } catch { return false; } });
}

function listVideos(dir = CONFIG.paths.video_dir) {
  if (!fs.existsSync(dir)) return [];
  const stableMs = 2 * 60 * 1000;
  const blocked = blockedVideoNames();
  return fs.readdirSync(dir)
    .filter(f => /\.(mp4|mov|mkv)$/i.test(f))
    .filter(f => !f.startsWith('_') && !f.startsWith('审核样片'))
    .filter(f => !blocked.has(f))
    .map(f => path.join(dir, f))
    // 跳过仍在写入的成片：auto_edit 直接渲染到最终路径，未完成时文件已存在
    .filter(p => { try { return Date.now() - fs.statSync(p).mtimeMs > stableMs; } catch { return false; } });
}

// 建立 成片 -> 剪辑元数据 索引
function inspectVideos() {
  const out = [];
  const metas = [];
  const workRoot = CONFIG.paths.auto_edit_work;
  if (fs.existsSync(workRoot)) {
    for (const d of fs.readdirSync(workRoot)) {
      const p = path.join(workRoot, d, 'meta.json');
      if (fs.existsSync(p)) {
        const m = readJson(p, null);
        if (m) metas.push({ dir: d, m });
      }
    }
  }
  // B8（2026-11-08）：成片名 → meta 建一次索引，不再每条成片全量扫 work 目录
  const metaByBase = new Map();
  for (const x of metas) { const k = x.m.output ? path.basename(x.m.output) : null; if (k && !metaByBase.has(k)) metaByBase.set(k, x); }
  const brandIndex = readJson(CONFIG.paths.brand_index, {});
  for (const video of listVideos()) {
    const base = path.basename(video);
    const hit = metaByBase.get(base);
    const clipKey = hit ? hit.dir : base.replace(/\.[^.]+$/, '');
    const meta = hit ? hit.m : {};
    const fallbackBrand = brandIndex[clipKey]?.brand || null;
    // 2026-11-15（宝哥要求「挂准」）：缺 meta 的成片，商品名也要从 brand_index 兜底取，
    // 否则商品名退化成品牌名，按品牌级规则随便挑一款（喜山奈双人餐挂成四人宴就是这么来的）。
    const fallbackProduct = brandIndex[clipKey]?.product || null;
    const metaBrand = typeof meta.brand === 'string' ? meta.brand : null;
    // B（2026-11-08 宝哥要求）：缺 meta 的成片，品牌按文件名确定性匹配，匹配不到才算没有
    const fileBrand = hit ? null : brandFromFilename(base);
    const brand = (meta.brand && meta.brand.brand) || metaBrand || fallbackBrand || (fileBrand && fileBrand.name) || null;
    let lines = (meta.lines || []).map(l => l.text).filter(Boolean);
    // 跳过字幕的素材 meta.lines 为空，退回 ASR 口播：按词间停顿切成自然短句
    if (!lines.length && hit) {
      const asr = readJson(path.join(workRoot, hit.dir, 'asr.json'), null);
      if (Array.isArray(asr)) lines = asrLines(asr);
    }
    out.push({
      path: video,
      file: base,
      clipKey,
      brand: brand || null,
      brand_verified: !!BRANDS.brands.find(b => b.name === brand && b.verified),
      brand_needs_review: !!meta.brand?.needs_review,
      // 品牌置信度：OCR 仿品牌字会误读，低于阈值一律不自动发布（宝哥 2026-11-02）
      brand_confidence: Number(meta.brand?.confidence ?? brandIndex[clipKey]?.confidence) || (fileBrand ? 1 : 0),
      brand_source: meta.brand?.source || brandIndex[clipKey]?.source || (fileBrand ? 'filename' : null),
      // meta 里的商品/品类由画面字幕人工确认过，比 ASR 更可信，优先用于标题兜底
      product: meta.brand?.product || fallbackProduct || null,
      category: BRANDS.brands.find(b => b.name === brand)?.category || meta.brand?.category || null,
      lines,
      copy_override: meta.copy_override || null,
      has_meta: !!hit,
      // 缺 meta、但文件名能定品牌：按 legacy_no_meta 入队（不伪造 meta.json，只写审计记录）
      legacy_no_meta: !hit && !!fileBrand,
    });
  }
  return out;
}

// B（2026-11-08 宝哥要求）：缺 meta 的成片不再直接丢弃——品牌先按文件名里的品牌名/别名做
// 确定性匹配（取命中最长的那个别名，短别名不会盖住长品牌名）；匹配不到再看已有的品牌记录。
// 只做字符串包含，不猜；都匹配不到就留空，交给品牌闸门挡住。
function brandFromFilename(base) {
  const name = String(base || '').replace(/\.[^.]+$/, '').toUpperCase();
  if (!name) return null;
  let hit = null;
  for (const b of BRANDS.brands || []) {
    for (const alias of [b.name, ...(b.aliases || [])]) {
      const t = String(alias || '').toUpperCase();
      if (!t || !name.includes(t)) continue;
      if (!hit || t.length > hit.len) hit = { brand: b, len: t.length };
    }
  }
  return hit ? hit.brand : null;
}

// 品牌闸门：无品牌、待复核、或置信度低于阈值都算「不能确认」
function brandConfirmed(v) {
  const min = CONFIG.publish.brand_min_confidence ?? 0.9;
  return !!v.brand && !v.brand_needs_review && (v.brand_verified || v.brand_confidence >= min);
}

// 品牌不能确认的成片移入「品牌待确认」目录，杜绝猜品牌发布。
// 宝哥 2026-11-04 固化：自动发布每轮先做一次兜底扫描，之后也按此规则执行。
function quarantineUnconfirmed(opts = {}) {
  const videoDir = opts.videoDir || CONFIG.paths.video_dir;
  const reviewDir = opts.reviewDir || CONFIG.paths.brand_review_dir || path.join(videoDir, '品牌待确认');
  const workRoot = opts.workRoot || CONFIG.paths.auto_edit_work;
  const brandIndexPath = opts.brandIndexPath || CONFIG.paths.brand_index;
  const dryRun = !!opts.dryRun;

  const metas = [];
  if (fs.existsSync(workRoot)) {
    for (const d of fs.readdirSync(workRoot)) {
      const m = readJson(path.join(workRoot, d, 'meta.json'), null);
      if (m) metas.push({ dir: d, m });
    }
  }
  // B8（2026-11-08）：品牌待确认扫描同样用索引，避免逐个成片全量比 meta  
  const metaByBase = new Map();
  for (const x of metas) { const k = x.m.output ? path.basename(x.m.output) : null; if (k && !metaByBase.has(k)) metaByBase.set(k, x); }
  const brandIndex = readJson(brandIndexPath, {});
  const moved = [];
  const kept = [];

  for (const video of listVideos(videoDir)) {
    const base = path.basename(video);
    const hit = metaByBase.get(base);
    const clipKey = hit ? hit.dir : base.replace(/\.[^.]+$/, '');
    const meta = hit ? hit.m : {};
    const idx = brandIndex[clipKey] || {};
    const fileBrand = hit ? null : brandFromFilename(base);
    const brand = (meta.brand && meta.brand.brand)
      || (typeof meta.brand === 'string' ? meta.brand : null) || idx.brand || (fileBrand && fileBrand.name) || null;
    const needsReview = hit ? !!meta.brand?.needs_review : !!idx.needs_review;
    const confidence = Number(meta.brand?.confidence ?? idx.confidence) || (fileBrand ? 1 : 0);
    const verified = !!BRANDS.brands.find(b => b.name === brand && b.verified);
    const confirmed = !!brand && !needsReview
      && (verified || confidence >= (CONFIG.publish.brand_min_confidence ?? 0.9));

    if (confirmed) { kept.push(base); continue; }

    const reason = !brand ? 'no brand' : needsReview ? 'needs review'
      : `confidence ${confidence} < ${CONFIG.publish.brand_min_confidence ?? 0.9}`;
    const rec = { file: base, from: video, brand, confidence, needs_review: needsReview, reason };

    if (dryRun) { moved.push({ ...rec, to: null }); continue; }

    ensureDir(reviewDir);
    let dest = path.join(reviewDir, base);
    if (fs.existsSync(dest)) {
      const ext = path.extname(base);
      dest = path.join(reviewDir, `${path.basename(base, ext)}_${Date.now()}${ext}`);
    }
    fs.renameSync(video, dest);
    rec.to = dest;

    if (hit) {
      meta.output = dest;
      writeJson(path.join(workRoot, hit.dir, 'meta.json'), meta);
    }
    if (brandIndex[clipKey]) {
      brandIndex[clipKey].output = dest;
      brandIndex[clipKey].updated_at = new Date().toISOString();
    }
    moved.push(rec);
  }

  if (!dryRun && moved.length) writeJson(brandIndexPath, brandIndex);
  return { moved, kept, dryRun };
}

function pickVideo() {
  const vids = inspectVideos();
  const state = loadState();
  const published = new Set(state.history.map(h => h.file));
  const excluded = new Set(state.excluded_videos || []);
  // 点过发布但结果未知 / 审核不通过的作品绝不能再次自动发：
  // 即使 _unverified_ 改名失败，也按计划状态把它们挡在队列外
  const planDir = path.join(CONFIG.paths.work_dir, 'plans');
  if (fs.existsSync(planDir)) {
    // B8（2026-11-08）：只回看最近 7 天的计划，历史计划不再每轮全量解析
    const planSinceMs = Date.now() - 7 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(planDir).filter(x => x.endsWith('.json'))) {
      try { if (fs.statSync(path.join(planDir, f)).mtimeMs < planSinceMs) continue; } catch { continue; }
      const p = readJson(path.join(planDir, f), null);
      if (!p || !Array.isArray(p.items)) continue;
      for (const it of p.items) {
        if (it.video && (it.status === 'pending_verify' || it.status === 'rejected')) excluded.add(it.video);
      }
    }
  }
  // 只发自动剪辑写全 meta 的成片：渲染中断的半成品没有 meta，避免误发；手动成片用 publish_one.js 单独发
  // B（2026-11-08 宝哥要求）：缺 meta 的成片，只要文件名能确定品牌就照样进队列；
  // 品牌仍由 brandConfirmed 把关，字幕闸门、去重、排除表逻辑一概不动
  return vids.filter(v => !published.has(v.file) && !excluded.has(v.file) && (v.has_meta || v.legacy_no_meta));
}

const FILLER = /^(姐妹们|宝子们|家人们|朋友们|兄弟们|哈喽|大家好|我跟你们说|我跟你说|听我说)[，,！!。.]*/;
const QUESTION_SUFFIX = ['你顶得住吗？', '谁懂这一口？', '看饿了没？', '你会选哪个？', '这一口能忍住吗？'];

// 口播 ASR 常见同音错字，只做确定性替换，避免把错字带上标题和描述
const COPY_FIXES = [
  [/催嫩/g, '脆嫩'],
  [/香辣宝/g, '香辣堡'],
  [/福利别生长/g, '福利别声张'],
  [/太上吼/g, '太上头'],
  [/超丝花/g, '超丝滑'],
  [/不苦不色/g, '不苦不涩'],
  [/香到剁脚/g, '香到跺脚'],
  [/炸底腿/g, '炸鸡腿'],
  [/只有预售才有想抢/g, '只有预售才有，想抢'],
  [/爷爷不跑炸/g, '爷爷不泡茶'],
  [/荔枝冰酿蓝香清宁冲赖水/g, '荔枝冰酿'],
  // 2026-11-01 批量成片实测到的同音错字（只做确定性替换）
  [/买一送衣/g, '买一送一'],
  [/寿库存/g, '库存'],
  [/必须豚/g, '必须囤'],
  [/先豚上/g, '先囤上'],
  [/豚/g, '囤'],
  [/第一烤/g, '第一口'],
  [/催到/g, '脆到'],
  [/吊渣/g, '掉渣'],
  [/炸踢腿/g, '炸鸡腿'],
  [/按头按力/g, '按头安利'],
  [/香道/g, '香到'],
  [/上心啦/g, '上新啦'],
  [/粉紫便便/g, '粉紫渐变'],
  [/粉子渐变/g, '粉紫渐变'],
  [/西一口/g, '吸一口'],
  [/海鲜大叉娃娃宝来来啦/g, '海鲜大咖蛙蛙煲来啦'],
  [/海鲜大茶挖挖宝来啦/g, '海鲜大咖蛙蛙煲来啦'],
  [/海鲜加挖肉/g, '海鲜加蛙肉'],
  [/满满一锅海鹿鲜约朋友/g, '满满一锅海鲜，约朋友'],
  [/聚餐离优惠/g, '聚餐更优惠'],
  [/满满一大份武天超/g, '满满一大份'],
  [/戳接/g, '戳链接'],
  [/紧挑链接/g, '赶紧戳链接'],
  [/挑链接/g, '戳链接'],
  [/手慢真的无碍/g, '手慢真的无'],
  [/完全不补苦不涩/g, '完全不苦不涩'],
  [/完全不苦又的满子/g, ''],
  [/早吧/g, '早八'],
  [/香爆紧/g, '香爆汁'],
  [/合合适/g, '合适'],
  [/香不，香/g, '香不香'],
  [/看得，见/g, '看得见'],
  [/，赶，赶紧/g, '，赶紧'],
  [/赶，赶紧/g, '赶紧'],
  [/连，减肥/g, '连减肥'],
  [/戳链$/g, '戳链接'],
  [/种一口/g, '这一口'],
  [/那杯终于，回来了/g, '那杯终于回来了'],
  [/清爽冰，咖啡/g, '清爽冰咖啡'],
  // 2026-11-03 手动成片实测的品牌名/常见同音错字
  [/CocoDuka/g, 'CoCo都可'],
  [/Cocoduc/g, 'CoCo都可'],
  [/CocoD/g, 'CoCo都可'],
  [/护上阿姨/g, '沪上阿姨'],
  [/(?<!沪)上阿姨/g, '沪上阿姨'],
  [/茶百度/g, '茶百道'],
  [/鱼炸鸡腿/g, '临榆炸鸡腿'],
  [/玉泥/g, '芋泥'],
  [/玉口感/g, '芋口感'],
  [/桃椒/g, '桃胶'],
  [/早鸟玉兽/g, '早鸟预售'],
  [/珍珠奶清/g, '珍珠奶茶'],
  [/买一送团购十佳蒜/g, '买一送一团购优惠'],
  // 2026-11-04 新一批口播实测：螺蛳粉、鲜芋奶绿、品牌名同音错字
  [/原味味螺丝甜品套餐/g, '原味螺蛳粉甜品套餐'],
  [/螺丝粉/g, '螺蛳粉'],
  [/螺丝/g, '螺蛳'],
  [/缩完粉粉来寄来一口/g, '嗦完粉再来一口'],
  [/缩完粉/g, '嗦完粉'],
  [/索完/g, '嗦完'],
  [/鲜鱼奶绿/g, '鲜芋奶绿'],
  [/鲜玉奶绿/g, '鲜芋奶绿'],
  [/奶绿玉香/g, '奶绿芋香'],
  [/肥伊麻/g, '肥姨妈'],
  [/肥呵妈/g, '肥姨妈'],
  [/肥阿妈/g, '肥姨妈'],
  [/可可豆可/g, 'CoCo都可'],
  // 2026-11-04 第二批实测：鸡柳大人、临榆炸鸡腿、三合一的同音错字
  [/姬鲁大人/g, '鸡柳大人'],
  [/三哈盒/g, '三合一'],
  [/三合鹅/g, '三合一'],
  [/淋临榆/g, '临榆'],
  [/01炸鸡腿/g, '临榆炸鸡腿'],
  [/铃银炸腿/g, '临榆炸鸡腿'],
  [/车链，接安排/g, '戳链接安排'],
  [/车链接/g, '戳链接'],
  [/戳链接，接安排/g, '戳链接安排'],
  [/戳链，接安排/g, '戳链接安排'],
  [/手香腿/g, '手枪腿'],
  [/手腔腿/g, '手枪腿'],
  [/外酥里诺/g, '外酥里嫩'],
  [/年糕诺/g, '年糕糯'],
  [/缩干净/g, '嗦干净'],
  [/小时组合/g, '小食组合'],
  [/安立/g, '安利'],
  [/赶，紧贴链接/g, '赶紧戳链接'],
  [/腊味够近/g, '辣味够劲'],
];

// 源视频自带的片尾口播 / ASR 幻觉，不能带进标题和描述
const JUNK_LINE = /(点赞|订阅|转发|打赏|明镜|栏目|双击|关注我|加我微信|小黄车|购物车|淘宝|拼多多|感谢观看|感谢收看|好久不见|请不吝|谢谢大家)/;
const PURE_LATIN = /^[A-Za-z0-9\s.。，,！!？?]+$/;
const STUTTER = /(.)(.)\1\2/;
const STANDALONE = /^(好|好喝|好看|好吃|好吃极了|不错)$/;

// 修完仍残留的 ASR 乱码特征：命中就丢掉这一句，标题/描述里绝不允许出现
const GARBLE = /(豚|食胖|武天|兜皮|兜配|鸡翅肩|离似|娃娃宝|海鹿|三支甲|挖挖宝|零一道|补苦|又的满子|寿库存|买一送衣|赤道称|特大粪|饭滚)/;

// 已确认的 ASR 乱码/低俗词：整条成片不自动发，换下一条
const BAD_COPY = /(粪|赤道称|饭滚|吊渣|傻逼|妈的|卧槽|便便|我操|尼玛|拉屎|操你|日你|去死|贱人)/;
// 断句明显坏掉的痕迹：宁可换下一条，也不发半截话
const SUSPECT = /(，了|，见|合合适|把我，|戳链$|谁拒绝这$|不，香)/;
// 标题只允许中文、字母、数字与常见标点；控制字符 / 换行直接拒绝
const TITLE_CHARS = /^[\u4e00-\u9fa5A-Za-z0-9 ，。！？、：；,.!?:;（）()《》""''“”‘’·\-—~～%$¥#@+]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
function copyClean(copy) {
  const title = String(copy.title || '');
  const desc = String(copy.desc || '');
  const text = `${title}\n${desc}`;
  return title.length >= 5 && !/[，,]$/.test(title)
    && !CONTROL.test(title) && !CONTROL.test(desc)
    && TITLE_CHARS.test(title) && /[\u4e00-\u9fa5A-Za-z0-9]/.test(title)
    && !BAD_COPY.test(text) && !GARBLE.test(text) && !SUSPECT.test(text);
}

// 标题里至少要有一个吃的/卖点词，纯语气词或半截话不当标题
const TITLE_GOOD = /(鸡腿|炸鸡|汉堡|咖啡|奶茶|冰酿|酸奶|黄油|莓果|海鲜|蛙|煲|薯条|年糕|鸡柳|香|脆|嫩|甜|辣|划算|优惠|福利|买一送一|买一赠一|团购|套餐|好吃|解馋|上头|过瘾|绝了|安利|爆汁|拉满|超级全)/;

const PRODUCT_WORDS = {
  '炸鸡': ['炸鸡腿', '炸鸡', '鸡腿', '鸡翅', '鸡块', '汉堡'],
  '汉堡炸鸡': ['汉堡', '炸鸡', '鸡腿', '鸡翅', '套餐'],
  '咖啡': ['生椰拿铁', '拿铁', '美式', '咖啡'],
  '茶饮': ['奶茶', '果茶', '柿子', '茶饮', '饮品'],
  '待确认': ['套餐', '美食'],
};

// ASR 经常把同一句说两遍（「荔枝冰」「荔枝冰酿」），保留更长的那句
function dedupeLines(lines) {
  const out = [];
  for (const t of lines) {
    if (!t) continue;
    const prev = out[out.length - 1];
    if (prev && (prev === t || (t.length < prev.length && prev.startsWith(t)))) continue;
    if (prev && t.startsWith(prev) && prev.length <= 6) { out[out.length - 1] = t; continue; }
    if (prev) {
      // 上一句结尾和这一句开头重复（「…的荔枝冰」+「荔枝冰酿」），去掉重复部分再拼接
      let overlap = 0;
      for (let k = Math.min(prev.length, t.length); k >= 3; k--) {
        if (prev.endsWith(t.slice(0, k))) { overlap = k; break; }
      }
      if (overlap >= 3) { out[out.length - 1] = prev + t.slice(overlap); continue; }
    }
    // 短句已被前面的内容完整覆盖，不再单独重复一遍
    if (t.length <= 8 && out.join('').includes(t)) continue;
    out.push(t);
  }
  return out;
}

function dedupeLineText(text) {
  const parts = text.split(/[，,]/).map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return text;
  const out = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (!prev) { out.push(p); continue; }
    if (prev === p || (p.length < prev.length && prev.startsWith(p))) continue;
    if (p.startsWith(prev) && prev.length <= 6) { out[out.length - 1] = p; continue; }
    let overlap = 0;
    for (let k = Math.min(prev.length, p.length); k >= 3; k--) {
      if (prev.endsWith(p.slice(0, k))) { overlap = k; break; }
    }
    if (overlap >= 3) { out[out.length - 1] = prev + p.slice(overlap); continue; }
    out.push(p);
  }
  return out.join('，');
}

function applyCopyFixes(text) {
  return COPY_FIXES.reduce((s, [re, to]) => s.replace(re, to), text);
}

// ASR 尾部的循环复读：同一 3 字以上片段在一句里出现 3 次以上，正常口播不会有
const ASR_LOOP = /(.{3,12})(?:.*?\1){2,}/;

function cleanLines(lines) {
  return dedupeLines(lines
    .map(applyCopyFixes)
    .map(t => t.replace(FILLER, '').replace(/[，,。！!？?]+$/g, '').trim())
    .map(dedupeLineText)
    // 「的快乐谁能拒绝」这类从半句开始的碎片，没有主语，直接丢弃
    .filter(t => !/^[的地得]/.test(t))
    .filter(t => t.length >= 2 && !STANDALONE.test(t) && !JUNK_LINE.test(t)
      && !PURE_LATIN.test(t) && !STUTTER.test(t) && !GARBLE.test(t))
    .filter(t => !ASR_LOOP.test(t)));
}

// 话题不能带括号和空格，否则抖音不会渲染成胶囊
function topicWord(text) {
  return String(text || '').replace(/[（）()\s+／/、，,。.！!？?]+/g, '').slice(0, 12);
}
function splitClauses(text) {
  return text.split(/[，,。！!？?、；;\s]+/).map(s => s.trim()).filter(Boolean);
}

// 按词间停顿把无标点的 ASR 切成自然短句
function asrLines(asr) {
  const out = [];
  for (const seg of asr) {
    const words = seg && seg.words;
    if (Array.isArray(words) && words.length) {
      let cur = '';
      for (let i = 0; i < words.length; i++) {
        cur += words[i].w || '';
        const next = words[i + 1];
        if (!next || next.start - words[i].end > 0.18) { if (cur) out.push(cur); cur = ''; }
      }
    } else if (seg && seg.text) out.push(seg.text);
  }
  return out.map(s => s.trim()).filter(Boolean);
}

// ASR 常常整段没有标点，按口语连接词切成可用短句；仍过长的按 16 字硬切
const ASR_BREAK = /(宝子们|姐妹们|家人们|今天|现在|我最近|真的|但是|而且|然后|因为|所以|如果|还有|只有|一口|咬下去|外皮|肉质|鸡腿肉|想吃的|赶紧|别等)/;
function splitLongText(text) {
  if (text.length <= 18) return [text];
  const parts = text.split(ASR_BREAK).map(s => s.trim()).filter(Boolean);
  const merged = [];
  for (const p of parts) {
    if (merged.length && (p.length < 4 || merged[merged.length - 1].length < 6)) merged[merged.length - 1] += p;
    else merged.push(p);
  }
  const out = [];
  for (const p of merged) {
    if (p.length <= 24) { out.push(p); continue; }
    for (let i = 0; i < p.length; i += 16) out.push(p.slice(i, i + 16));
  }
  return out;
}

// ASR 片段之间补标点：未说完的片段直接拼接，完整短句之间用逗号
// 「了」通常是完整句尾，不放进未说完标记，否则会误删上一整句
const INCOMPLETE_END = /(一个|一款|一家|的|到|是|把|给|在|和|跟|这|那|有|就|都|还|又|超|特别|真的|终于|看得)$/;

// 已知商品名：ASR 常把词从中间断开，跨句拼接时用它们把断词合回来
const FOOD_VOCAB = [
  '荔枝冰酿', '莓果酸奶饮', '麦辣鸡腿堡', '香辣鸡腿堡', '海鲜大咖蛙蛙煲',
  '生椰拿铁', '小黄油', '柿柿可利', '柿柿椰椰', '柿柿有杏', '买一送一',
];

// 上一句结尾 + 这一句开头恰好组成已知商品名时合并，避免「荔枝冰，酿…」
function mergeProductSplits(lines, vocab) {
  const out = [];
  for (const t of lines) {
    const prev = out[out.length - 1];
    if (prev && vocab.some(w => (prev + t).includes(w) && !prev.includes(w) && !t.includes(w))) {
      out[out.length - 1] = prev + t;
      continue;
    }
    out.push(t);
  }
  return out;
}
function joinSmart(lines) {
  let out = '';
  lines.forEach((line, i) => {
    if (i === 0) { out = line; return; }
    const prev = lines[i - 1];
    // 下一句以助词/补语开头时说明上一句没说完，直接接上不加逗号
    const continues = /^[了的得着见过]/.test(line);
    const needPunct = !continues && !INCOMPLETE_END.test(prev) && out && !/[，,。！!？?]$/.test(out);
    out += (needPunct ? '，' : '') + line;
  });
  return out;
}

function buildCopy(videoInfo, state) {
  const rnd = seededRandom(`copy:${videoInfo.file}`);
  // 2026-11-15（宝哥要求）：未认证品牌只是不挂品牌话题（videoInfo.brand_topic === false），
  // 品牌名不许从标题/描述里丢掉；缺 meta 的成片按文件名兜底识别品牌。
  const filenameBrand = brandFromFilename(videoInfo.file || '');
  const brand = videoInfo.brand || (filenameBrand && filenameBrand.name) || '';
  const lines = mergeProductSplits(
    cleanLines(videoInfo.lines || []),
    [...FOOD_VOCAB, videoInfo.product].filter(Boolean),
  );
  const text = lines.join('');
  const sentences = lines.flatMap(l => l.length > 24 ? splitLongText(l) : [l]);
  const clauses = sentences.flatMap(splitClauses);

  // 商品词：优先用 meta 里人工确认过的商品名，其次跨品类找口播里出现的最长词
  const allVocab = [...new Set(Object.values(PRODUCT_WORDS).flat())].sort((a, b) => b.length - a.length);
  const product = videoInfo.product || allVocab.find(w => text.includes(w)) || '';
  const category = videoInfo.category
    || Object.keys(PRODUCT_WORDS).find(k => (PRODUCT_WORDS[k] || []).includes(product))
    || '';

  // 标题：优先挑含商品词的短句，其次含卖点词的短句；都不行就用商品/品牌兜底
  const candidates = clauses.filter(c => c.length >= 5 && c.length <= 18
    && !/[？?]$/.test(c) && !INCOMPLETE_END.test(c)
    && !/^[了的得着见过]/.test(c) && !/^(回来了|回来|然后|但是|因为|所以)/.test(c));
  const preferred = candidates.filter(c => product && c.includes(product));
  const good = candidates.filter(c => TITLE_GOOD.test(c));
  const pool = preferred.length ? preferred : good;
  const shortProduct = product && product.length > 12 ? topicWord(product) : product;
  // 泛词（零食/套餐/美食/代金券…）不能当标题主体，否则会出现「零食，谁懂这一口？」这类空标题
  const GENERIC_HOOK = /^(零食|美食|套餐|代金券|团购|饮品|小吃|待确认)$/;
  const usableProduct = shortProduct && shortProduct.length >= 4 && !GENERIC_HOOK.test(shortProduct) ? shortProduct : '';
  const fallbackHook = usableProduct || brand || '这一口';
  const hook = pool.length ? pool[Math.floor(rnd() * pool.length)] : fallbackHook;
  const suffixList = state.used_title_suffix || [];
  // 2026-11-15（宝哥要求）：后缀不能和主体重复（曾出现「这一口，谁懂这一口？」）
  const hookCore = String(hook || '').replace(/[？?，,。！!\s]/g, '');
  const suffixPool = QUESTION_SUFFIX.filter(s => {
    const core = s.replace(/[？?，,。！!]/g, '');
    if (!core) return false;
    if (hookCore && (hookCore.includes(core) || core.includes(hookCore))) return false;
    return true;
  });
  const usableSuffix = suffixPool.length ? suffixPool : QUESTION_SUFFIX
    .filter(s => !String(hook || '').includes(s.replace(/[？?]/g, '')));
  const suffixBase = usableSuffix.length ? usableSuffix : QUESTION_SUFFIX;
  let suffix = suffixBase[Math.floor(rnd() * suffixBase.length)];
  let guard = 0;
  while (suffixList.slice(-6).includes(suffix) && guard++ < 10) {
    suffix = suffixBase[Math.floor(rnd() * suffixBase.length)];
  }
  let title = `${hook}，${suffix}`;
  if (title.length > CONFIG.copy.max_title) title = title.slice(0, CONFIG.copy.max_title - 1) + '？';

  // 描述：口播事实，避开与标题重复的短句，再补一个互动提问
  const hookIdx = sentences.findIndex(l => l === hook || l.includes(hook) || hook.includes(l));
  let bodyLines = hookIdx >= 0 ? sentences.filter((_, i) => i !== hookIdx) : sentences.slice();
  if (hookIdx > 0 && INCOMPLETE_END.test(sentences[hookIdx - 1])) {
    bodyLines = bodyLines.filter(l => l !== sentences[hookIdx - 1]);
  }
  if (!bodyLines.length) {
    // 只有一句口播时，描述不再复述标题，改成品牌/商品的通用开场
    const subject = brand || product;
    bodyLines = subject ? [`今天来聊聊${subject}`] : [];
  }
  // 跨行错字只有在拼接、补标点之后才会露出逗号连接，需要再过一遍纠错表
  const descCore = applyCopyFixes(joinSmart(bodyLines));
  const ask = ['你们平时最常点哪一款？', '这一口你最想先尝哪样？', '评论区聊聊你的必点款？'][Math.floor(rnd() * 3)];
  let desc = `${descCore ? descCore.replace(/[。！？!?]+$/, '') + '。' : ''}${ask}`;
  if (desc.length > CONFIG.copy.max_desc) desc = desc.slice(0, CONFIG.copy.max_desc);

  // 话题：品牌 + 商品 + 品类 + 团购；不足 3 个补通用词
  // 未认证品牌（brand_topic === false）不挂品牌话题，但标题/描述里的品牌名保留（宝哥 2026-11-15）
  const topics = [];
  if (brand && videoInfo.brand_topic !== false) topics.push(`#${topicWord(brand)}`);
  if (product) topics.push(`#${topicWord(product)}`);
  const catTag = { '炸鸡': '#炸鸡', '汉堡炸鸡': '#汉堡', '咖啡': '#咖啡', '茶饮': '#奶茶' }[category];
  if (catTag) topics.push(catTag);
  topics.push('#团购');
  const uniq = [...new Set(topics)].slice(0, CONFIG.copy.topics_max);
  const FILLER_TAGS = ['#美食', '#好吃', '#吃货', '#探店'];
  for (let i = 0; uniq.length < CONFIG.copy.topics_min && i < FILLER_TAGS.length; i++) {
    if (!uniq.includes(FILLER_TAGS[i])) uniq.push(FILLER_TAGS[i]);
  }

  // copy_override（2026-11-08 宝哥要求）：meta 里人工定稿的文案优先；只有 meta 带 copy_override 才生效。
  // 覆盖后仍要过 copyClean，不通过就忽略覆盖、回退自动生成，并在日志里记一条（绝不把低质文案发出去）。
  const ov = videoInfo.copy_override;
  if (ov && typeof ov === 'object') {
    const c2 = {
      title: (typeof ov.title === 'string' && ov.title.trim()) ? ov.title.trim() : title,
      desc: (typeof ov.desc === 'string' && ov.desc.trim()) ? ov.desc.trim() : desc,
      topics: (Array.isArray(ov.topics) && ov.topics.length)
        ? ov.topics.map(t => String(t).trim()).filter(Boolean)
        : uniq,
    };
    if (copyClean(c2)) {
      return { title: c2.title, desc: c2.desc, topics: c2.topics, product: product || brand || null, hook, category };
    }
    try {
      const ld = path.isAbsolute(CONFIG.paths.work_dir) ? path.join(CONFIG.paths.work_dir, 'logs') : path.join(ROOT, CONFIG.paths.work_dir, 'logs');
      ensureDir(ld);
      fs.appendFileSync(path.join(ld, `${todayStr()}.log`),
        `[${new Date().toISOString()}] COPY_OVERRIDE_REJECTED ${videoInfo.file} | ${c2.title}\n`);
    } catch (e) { /* 留痕失败不挡出片 */ }
  }

  return { title, desc, topics: uniq, product: product || brand || null, hook, category };
}

// A4（2026-11-08）：Chromium 路径：环境变量 → config → 扫 ms-playwright 最高版本 → 兜底用 playwright 自带
function chromiumPath() {
  const pick = p => { try { return p && fs.existsSync(p) ? String(p).replace(/\\/g, '/') : null; } catch { return null; } };
  const fromEnv = pick(String(process.env.TUANGOU_CHROMIUM || process.env.PLAYWRIGHT_CHROMIUM_PATH || '').trim());
  if (fromEnv) return fromEnv;
  const fromCfg = pick(CONFIG.publish.chromium_path);
  if (fromCfg) return fromCfg;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : null,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData/Local/ms-playwright') : null].filter(Boolean);
  const found = [];
  for (const root of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter(d => /^chromium-\d+/.test(d)); } catch { continue; }
    for (const d of dirs) {
      const ver = Number(d.replace(/^chromium-/, '')) || 0;
      for (const rel of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = pick(path.join(root, d, rel));
        if (p) found.push({ ver, p });
      }
    }
  }
  if (!found.length) return null; // 兜底：playwright 自带的 chromium
  found.sort((a, b) => b.ver - a.ver);
  return found[0].p;
}

// A5（2026-11-08）：Python 候选链（环境变量 → 传入候选 → PATH），能用才算数，不再单点依赖某个 venv
function resolvePython(candidates = [], probe = 'import sys') {
  const list = [process.env.TUANGOU_PYTHON, process.env.DANBAO_PYTHON, ...(candidates || []), 'python'].filter(Boolean);
  for (const exe of list) {
    const s = String(exe);
    if (/[\\/]/.test(s) && !fs.existsSync(s)) continue;
    try { execFileSync(s, ['-c', probe], { timeout: 20000, stdio: 'ignore' }); return s; } catch {}
  }
  return null;
}

// A7（2026-11-08）：判断锁里的 pid 是否还活着
function isPidAlive(pid) {
  const n = Number(pid);
  if (!n || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// B4（2026-11-08）：成片改名收进 lib，prepare 与 run_due 共用一份，不再各抄一遍
function renameAll(dryRun, logFn) {
  const say = typeof logFn === 'function' ? logFn : () => {};
  const renamer = path.join(ROOT, 'scripts/auto-edit/rename_final.js');
  if (!fs.existsSync(renamer)) return false;
  const args = [renamer];
  if (dryRun) args.push('--dry');
  try { execFileSync(process.execPath, args, { cwd: ROOT, timeout: 600000, stdio: 'ignore' }); return true; }
  catch (e) { say('rename failed: ' + e.message); return false; }
}

// B（2026-11-08 宝哥要求）：缺 meta 入队的成片留一条审计记录，便于以后追溯是哪条、品牌怎么定的。
// 只写审计文件，绝不伪造 meta.json。
function auditLegacyNoMeta() {
  const list = inspectVideos().filter(v => v.legacy_no_meta);
  const p = CONFIG.paths.legacy_no_meta_log || path.join(CONFIG.paths.work_dir, 'legacy_no_meta.json');
  const prev = readJson(p, { records: [] });
  const known = new Map((prev.records || []).map(r => [r.file, r]));
  for (const v of list) {
    if (known.has(v.file)) continue;
    known.set(v.file, {
      file: v.file, brand: v.brand, brand_source: v.brand_source,
      at: new Date().toISOString(), note: '缺 meta：品牌取自文件名',
    });
  }
  const records = [...known.values()];
  writeJson(p, { updated_at: new Date().toISOString(), count: records.length, records });
  return records;
}

module.exports = {
  ROOT, CONFIG, BRANDS,
  ensureDir, readJson, writeJson,
  todayStr, minutesOf, hhmmOf, dayIndex,
  loadState, saveState, loadPlan, savePlan, ensurePlan, targetCount, buildTimes, planTimes, buildTimesProfiled,
  brandUsage, publishedAtMs,
  inspectVideos, pickVideo, buildCopy, copyClean, seededRandom,
  listVideos, loadSourceBlacklist, isBlockedSource,
  brandConfirmed, quarantineUnconfirmed,
  isPidAlive, resolvePython, chromiumPath, renameAll,
  brandFromFilename, auditLegacyNoMeta,
};

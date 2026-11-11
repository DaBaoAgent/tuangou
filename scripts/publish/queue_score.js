// 发布队列打分：用账号历史数据决定「先发哪条、哪个时段发」。
// 纯函数；没有数据时退化成原来的「优先品牌 + 品牌可信度」顺序，不会让队列停摆。
// 2026-11-10 目标：先把号做起来，排序看「播放量 / 团购等级 / 出单量」，不看佣金率。

const DEFAULT_WEIGHTS = {
  base: 20,
  brandPlays: 35,   // 品牌历史播放（相对最好的品牌）
  orders: 45,       // 有出单数据时，品牌订单数权重最高
  category: 10,     // 品类完播/点击表现
  verified: 4,      // 品牌已认证（能挂品牌话题）
  hasProduct: 3,    // meta 里有确认过的商品名，文案更具体
  priority: 8,      // 宝哥指定优先品牌
  freshness: 12,    // 库存放久了先发，避免成片积压过期
};

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function maxOf(values) {
  let m = 0;
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v) && v > m) m = v;
  return m;
}

function ageDays(publishedOrMtime, now) {
  const t = typeof publishedOrMtime === 'number' ? publishedOrMtime : Date.parse(publishedOrMtime);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (now - t) / 86400000);
}

// 播放量差异通常跨数量级，用对数压缩；+50 给新品牌一个中位数起步，避免 0 播放被判死
function playIndex(playsAvg, maxPlays) {
  if (typeof playsAvg !== 'number' || !Number.isFinite(playsAvg)) return 0.5;
  const x = Math.log10(Math.max(1, playsAvg) + 50);
  const top = Math.log10(Math.max(1, maxPlays) + 50);
  return top > 0 ? clamp(x / top, 0, 1) : 0.5;
}

// 完播率/点击率是「内容质量」信号：高于账号均值加分，低于均值不加分
function qualityIndex(stat, overall) {
  if (!stat || !overall) return 0;
  const parts = [];
  if (typeof stat.finish_avg === 'number' && typeof overall.finish_avg === 'number' && overall.finish_avg > 0) {
    parts.push(clamp(stat.finish_avg / overall.finish_avg - 1, 0, 1));
  }
  if (typeof stat.cover_ctr_avg === 'number' && typeof overall.cover_ctr_avg === 'number' && overall.cover_ctr_avg > 0) {
    parts.push(clamp(stat.cover_ctr_avg / overall.cover_ctr_avg - 1, 0, 1));
  }
  if (!parts.length) return 0;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

// video: lib.inspectVideos() 的一条；ctx: {analytics, orders, priorityBrands, now, mtimeOf}
function scoreVideo(video, ctx = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(ctx.weights || {}) };
  const now = ctx.now || Date.now();
  const analytics = ctx.analytics || null;
  const orders = ctx.orders && ctx.orders.brands ? ctx.orders.brands : null;
  const brands = (analytics && analytics.brands) || {};
  const categories = (analytics && analytics.categories) || {};
  const overall = analytics && analytics.overall;

  const b = video.brand ? brands[video.brand] : null;
  const cat = video.category ? categories[video.category] : null;
  const maxPlays = maxOf(Object.values(brands).map(x => x.plays_avg));
  const maxOrders = orders ? maxOf(Object.values(orders).map(x => x.orders)) : 0;

  const why = [];
  let score = weights.base;

  const pi = b ? playIndex(b.plays_avg, maxPlays) : 0.5;
  score += weights.brandPlays * pi;
  if (b) why.push(`brandPlays=${Math.round(pi * 100)}%`);

  if (orders && video.brand && orders[video.brand] && maxOrders > 0) {
    const oi = clamp(orders[video.brand].orders / maxOrders, 0, 1);
    score += weights.orders * oi;
    why.push(`orders=${orders[video.brand].orders}`);
  }

  const qi = qualityIndex(cat, overall);
  score += weights.category * qi;
  if (qi > 0) why.push(`categoryQuality=${Math.round(qi * 100)}%`);

  if (video.brand_verified) score += weights.verified;
  if (video.product) score += weights.hasProduct;

  const list = ctx.priorityBrands || [];
  const pIdx = list.indexOf(video.brand);
  if (pIdx >= 0) {
    score += weights.priority;
    why.push('priorityBrand');
  }

  const age = ageDays(video.mtime || (ctx.mtimeOf && ctx.mtimeOf(video)), now);
  const freshBonus = weights.freshness * clamp(age / 7, 0, 1);
  score += freshBonus;
  if (age >= 3) why.push(`age=${age.toFixed(1)}d`);

  const priorityRank = pIdx < 0 ? list.length : pIdx;
  return { score: Math.round(score * 10) / 10, priorityRank, why: why.join(',') };
}

// 稳定排序：分数高先发；同分按宝哥优先品牌、再按文件名固定顺序，保证同日可复现
function rankVideos(videos, ctx = {}) {
  return videos
    .map(v => ({ v, ...scoreVideo(v, ctx) }))
    .sort((a, b) => b.score - a.score || a.priorityRank - b.priorityRank || String(a.v.file).localeCompare(String(b.v.file)))
    .map(x => ({ ...x.v, queue_score: x.score, queue_why: x.why }));
}

// 2026-11-11（宝哥拍板）：同品牌冷却 + 每日上限。
// 2026-11-10 一天连发七条鸡柳大人，既压播放也伤稿均内容力；这里按品牌挡住过密发布。
// usage: lib.brandUsage() 的输出 { 品牌: { lastMs, todayCount } }；纯函数，不做 IO。
function filterBrandRhythm(videos, usage = {}, ctx = {}) {
  const cooldownMs = Math.max(0, Number(ctx.cooldownMinutes ?? 180)) * 60000;
  const dailyCap = Math.max(0, Number(ctx.dailyCap ?? 2));
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const kept = [];
  const blocked = [];
  for (const v of videos) {
    const u = v.brand ? usage[v.brand] : null;
    if (u && cooldownMs > 0 && u.lastMs && now >= u.lastMs && now - u.lastMs < cooldownMs) {
      blocked.push({
        video: v, brand: v.brand, reason: 'cooldown',
        next_at: new Date(u.lastMs + cooldownMs).toISOString(),
      });
      continue;
    }
    if (u && dailyCap > 0 && (u.todayCount || 0) >= dailyCap) {
      blocked.push({ video: v, brand: v.brand, reason: 'daily-cap' });
      continue;
    }
    kept.push(v);
  }
  return { kept, blocked };
}

// 时段画像：每个时段的平均播放相对最好时段的比例（0.2~1），给排期加权用
function hourWeights(analytics, fallback = 0.5) {
  const hours = (analytics && analytics.hours) || {};
  const entries = Object.entries(hours).filter(([, s]) => s && s.n > 0 && typeof s.plays_avg === 'number');
  // 样本少于 2 条的时段不信，也不参与「最好时段」的基准
  const solid = entries.filter(([, s]) => s.n >= 2);
  if (!solid.length) return null;
  const max = maxOf(solid.map(([, s]) => s.plays_avg));
  if (!(max > 0)) return null;
  const out = {};
  for (const [k, s] of entries) {
    out[k] = s.n >= 2 ? clamp(0.2 + (s.plays_avg / max) * 0.8, 0.2, 1) : fallback;
  }
  return out;
}

module.exports = {
  DEFAULT_WEIGHTS, playIndex, qualityIndex, scoreVideo, rankVideos, hourWeights, ageDays,
  filterBrandRhythm,
};

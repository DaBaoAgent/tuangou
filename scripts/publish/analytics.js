// 作品数据：把抖音「作品列表导出.xlsx」变成可用的账号画像（按品牌 / 品类 / 时段聚合）。
// 纯函数为主，不依赖 lib.js，方便单测；只有 ingest/load 才碰磁盘。
const fs = require('fs');
const path = require('path');
const { readXlsxRows } = require('./xlsx');

const COLUMNS = {
  title: '作品名称',
  published_at: '发布时间',
  genre: '体裁',
  audit: '审核状态',
  plays: '播放量',
  finish_rate: '完播率',
  five_sec_rate: '5s完播率',
  cover_ctr: '封面点击率',
  bounce_2s: '2s跳出率',
  avg_duration: '平均播放时长',
  likes: '点赞量',
  shares: '分享量',
  comments: '评论量',
  favorites: '收藏量',
  profile_visits: '主页访问量',
  follower_delta: '粉丝增量',
};

const EMPTY = '—';

function num(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/,/g, '');
  if (!s || s === EMPTY || /^(-|--|无)$/.test(s)) return null;
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*(亿|万|千|[wWkK])?/);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2];
  if (u === '亿') return n * 1e8;
  if (u === '万' || u === 'w' || u === 'W') return n * 1e4;
  if (u === '千' || u === 'k' || u === 'K') return n * 1e3;
  return n;
}

function pct(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === EMPTY) return null;
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*%/);
  if (m) return Number(m[1]) / 100;
  // 有些导出直接给 0.15 这种小数
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

function seconds(v) {
  if (v == null) return null;
  const s = String(v).trim();
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (m) return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// '2026年11月10日 18:25' / '2026-11-10 18:25' / '11-10 18:25'
function parsePublished(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  let m = s.match(/(\d{4})\D(\d{1,2})\D(\d{1,2})\D+(\d{1,2}):(\d{2})/);
  let y;
  if (m) {
    y = Number(m[1]);
  } else {
    m = s.match(/(\d{1,2})\D(\d{1,2})\D+(\d{1,2}):(\d{2})/);
    if (!m) return null;
    y = new Date().getFullYear();
    m = [m[0], y, m[1], m[2], m[3], m[4]].map((x, i) => (i === 1 ? String(x) : x));
  }
  const mo = Number(m[2]), d = Number(m[3]), hh = Number(m[4]), mi = Number(m[5]);
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && hh >= 0 && hh <= 23)) return null;
  const at = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00+08:00`;
  const ts = Date.parse(at);
  return { at, ts: Number.isFinite(ts) ? ts : null, hour: hh };
}

function headerIndex(header) {
  const idx = {};
  for (const [key, label] of Object.entries(COLUMNS)) {
    const i = header.findIndex(h => String(h).trim() === label);
    if (i >= 0) idx[key] = i;
  }
  return idx;
}

// 行 → 统一结构；没有标题或标题看起来像表头的行直接丢
function normalizeWorks(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const hIdx = headerIndex(rows[0]);
  if (hIdx.title == null) throw new Error('xlsx 缺少「作品名称」表头');
  const out = [];
  for (const row of rows.slice(1)) {
    const get = k => (hIdx[k] == null ? '' : String(row[hIdx[k]] ?? '').trim());
    const title = get('title');
    if (!title || title === COLUMNS.title) continue;
    const pub = parsePublished(get('published_at'));
    out.push({
      key: `${title}|${pub ? pub.at : get('published_at')}`,
      title,
      published_at: pub ? pub.at : (get('published_at') || null),
      published_ts: pub ? pub.ts : null,
      hour: pub ? pub.hour : null,
      genre: get('genre') || null,
      audit: get('audit') || null,
      plays: num(get('plays')),
      finish_rate: pct(get('finish_rate')),
      five_sec_rate: pct(get('five_sec_rate')),
      cover_ctr: pct(get('cover_ctr')),
      bounce_2s: pct(get('bounce_2s')),
      avg_duration_sec: seconds(get('avg_duration')),
      likes: num(get('likes')),
      shares: num(get('shares')),
      comments: num(get('comments')),
      favorites: num(get('favorites')),
      profile_visits: num(get('profile_visits')),
      follower_delta: num(get('follower_delta')),
    });
  }
  return out;
}

// 计划里记了 title→brand，导出表没有品牌列，靠标题把两边接起来
function loadPlanIndex(plansDir, sinceDays = 45, now = Date.now()) {
  const index = new Map();
  if (!plansDir || !fs.existsSync(plansDir)) return index;
  const since = now - sinceDays * 86400000;
  for (const f of fs.readdirSync(plansDir).filter(x => x.endsWith('.json'))) {
    let p;
    try { p = JSON.parse(fs.readFileSync(path.join(plansDir, f), 'utf8')); } catch { continue; }
    if (!p || !Array.isArray(p.items)) continue;
    if (p.items[0] && p.items[0].id && p.date) {
      const t = Date.parse(p.date + 'T00:00:00+08:00');
      if (Number.isFinite(t) && t < since) continue;
    }
    for (const it of p.items) {
      const title = it.copy && it.copy.title;
      if (!title) continue;
      index.set(String(title).trim(), {
        brand: it.brand || null,
        category: it.category || null,
        item_id: it.id || null,
        date: p.date || null,
        at: it.at || null,
        video: it.video || null,
        status: it.status || null,
        product: it.product && it.product.selected ? it.product.selected : null,
      });
    }
  }
  return index;
}

function defaultBuckets(startMin = 360, endMin = 1140, parts = 4) {
  const startH = Math.floor(startMin / 60);
  const endH = Math.max(startH + 1, Math.ceil(endMin / 60));
  const step = Math.max(1, Math.round((endH - startH) / parts));
  const out = [];
  for (let h = startH; h < endH; h += step) out.push({ from: h, to: Math.min(endH, h + step) });
  return out;
}

function bucketOf(hour, buckets) {
  if (hour == null) return null;
  const b = buckets.find(x => hour >= x.from && hour < x.to);
  return b ? `${String(b.from).padStart(2, '0')}-${String(b.to).padStart(2, '0')}` : null;
}

function avg(list) {
  const xs = list.filter(x => typeof x === 'number' && Number.isFinite(x));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function summarize(works) {
  const s = {
    n: works.length,
    plays_total: 0,
    plays_avg: null,
    finish_avg: null,
    five_sec_avg: null,
    cover_ctr_avg: null,
    bounce_2s_avg: null,
    likes_total: 0,
    comments_total: 0,
    favorites_total: 0,
    shares_total: 0,
    profile_visits_total: 0,
    follower_delta_total: 0,
  };
  for (const w of works) {
    s.plays_total += w.plays || 0;
    s.likes_total += w.likes || 0;
    s.comments_total += w.comments || 0;
    s.favorites_total += w.favorites || 0;
    s.shares_total += w.shares || 0;
    s.profile_visits_total += w.profile_visits || 0;
    s.follower_delta_total += w.follower_delta || 0;
  }
  s.plays_avg = avg(works.map(w => w.plays));
  s.finish_avg = avg(works.map(w => w.finish_rate));
  s.five_sec_avg = avg(works.map(w => w.five_sec_rate));
  s.cover_ctr_avg = avg(works.map(w => w.cover_ctr));
  s.bounce_2s_avg = avg(works.map(w => w.bounce_2s));
  return s;
}

function groupBy(works, pickKey) {
  const groups = new Map();
  for (const w of works) {
    const k = pickKey(w);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(w);
  }
  return groups;
}

// 导出表的「作品名称」是标题+描述+话题的整段，计划里只存标题，先找精确匹配再找最长前缀
function matchPlan(title, planIndex) {
  const t = String(title || '').trim();
  if (!t || !(planIndex instanceof Map)) return null;
  const exact = planIndex.get(t);
  if (exact) return exact;
  let best = null;
  for (const [k, v] of planIndex) {
    if (!k || !t.startsWith(k)) continue;
    if (!best || k.length > best.k.length) best = { k, v };
  }
  return best ? best.v : null;
}

// 老作品（西瓜迁移过来的）在导出里播放量为 0、点赞却上万，会把均值拖死；统计只看最近 N 天
function recentWorks(works, now = Date.now(), days = 30) {
  const cut = now - days * 86400000;
  const recent = works.filter(w => w.published_ts && w.published_ts >= cut);
  return recent.length ? recent : works;
}

function aggregate(works, planIndex, opts = {}) {
  const withBrand = works.map(w => {
    const plan = matchPlan(w.title, planIndex);
    return { ...w, brand: plan ? plan.brand : null, category: plan ? plan.category : null };
  });
  const brands = {};
  for (const [k, list] of groupBy(withBrand, w => w.brand)) brands[k] = summarize(list);
  const categories = {};
  for (const [k, list] of groupBy(withBrand, w => w.category)) categories[k] = summarize(list);
  const buckets = opts.buckets || defaultBuckets();
  const hours = {};
  for (const [k, list] of groupBy(withBrand, w => bucketOf(w.hour, buckets))) hours[k] = summarize(list);
  return {
    updated_at: opts.updated_at || new Date().toISOString(),
    count: withBrand.length,
    buckets,
    overall: summarize(withBrand),
    brands,
    categories,
    hours,
    works: withBrand,
  };
}

function statsPaths(root, config) {
  const p = (config && config.paths) || {};
  // 没显式配 stats_dir 时跟着 work_dir 走，沙箱/换目录都不会读到真实账号数据
  const rel = p.stats_dir || (p.work_dir ? path.join(p.work_dir, 'stats') : 'runtime/publish/stats');
  const base = (path.isAbsolute(rel) ? rel : path.join(root, rel)).replace(/\\/g, '/');
  const p2 = (...xs) => path.join(base, ...xs).replace(/\\/g, '/');
  return { dir: base, works: p2('works.json'), orders: p2('orders.json'), raw: p2('raw') };
}

function ingest({ xlsxPath, root, config, plansDir, now = new Date(), write = true }) {
  const rows = readXlsxRows(xlsxPath);
  const works = normalizeWorks(rows);
  const planIndex = loadPlanIndex(plansDir, 45, now.getTime());
  const days = Number((config && config.publish && config.publish.analytics_window_days) || 30);
  const recent = recentWorks(works, now.getTime(), days);
  const data = aggregate(recent, planIndex, { updated_at: now.toISOString() });
  data.source = path.basename(xlsxPath);
  data.exported_at = now.toISOString();
  data.window_days = days;
  data.total_count = works.length;
  data.works = works;
  const paths = statsPaths(root, config);
  if (write) {
    fs.mkdirSync(paths.dir, { recursive: true });
    const tmp = paths.works + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, paths.works);
  }
  return data;
}

function loadAnalytics(paths) {
  try { return JSON.parse(fs.readFileSync(paths.works, 'utf8')); } catch { return null; }
}

// 出单数据由宝哥从精选联盟/来客导出后放到 stats/orders.json；
// 认两种格式：{brands:{名:{orders,gmv}}} 或 [{brand,orders,gmv}]
function loadOrders(paths) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(paths.orders, 'utf8')); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  if (Array.isArray(raw)) {
    for (const r of raw) {
      const name = r.brand || r.品牌 || r.name;
      if (!name) continue;
      out[name] = {
        orders: num(r.orders ?? r.订单 ?? r.订单数) || 0,
        gmv: num(r.gmv ?? r.GMV ?? r.成交额) || 0,
        commission: num(r.commission ?? r.佣金) || 0,
      };
    }
    return { updated_at: null, brands: out };
  }
  const brands = raw.brands || raw;
  for (const [name, v] of Object.entries(brands)) {
    if (!v || typeof v !== 'object') continue;
    out[name] = {
      orders: num(v.orders ?? v.订单 ?? v.订单数) || 0,
      gmv: num(v.gmv ?? v.GMV ?? v.成交额) || 0,
      commission: num(v.commission ?? v.佣金) || 0,
    };
  }
  return { updated_at: raw.updated_at || null, brands: out };
}

module.exports = {
  COLUMNS, num, pct, seconds, parsePublished,
  normalizeWorks, loadPlanIndex, defaultBuckets, bucketOf, aggregate, recentWorks, matchPlan,
  statsPaths, ingest, loadAnalytics, loadOrders,
};

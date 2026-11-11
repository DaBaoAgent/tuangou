const test = require('node:test');
const assert = require('node:assert/strict');
const QS = require('./queue_score');

const NOW = Date.parse('2026-11-10T12:00:00+08:00');
const VIDEO = {
  file: 'a.mp4', brand: '品牌A', brand_verified: true, brand_needs_review: false,
  category: '炸鸡', product: '炸鸡腿', brand_confidence: 0.99, mtime: NOW - 3 * 86400000,
};

function analytics(brands, overall = { finish_avg: 0.1, cover_ctr_avg: 0.05 }, hours = {}) {
  return {
    count: 40, overall, brands, categories: { 炸鸡: { n: 5, finish_avg: 0.15, cover_ctr_avg: 0.06 } }, hours,
  };
}

test('没有数据时打分只由品牌可信度/新鲜度决定，且不抛错', () => {
  const r = QS.scoreVideo(VIDEO, { now: NOW });
  assert.ok(r.score > 0);
  assert.equal(typeof r.why, 'string');
});

test('品牌历史播放越高分越高；出单数据权重最大', () => {
  const low = QS.scoreVideo({ ...VIDEO, brand: '低' }, {
    now: NOW, analytics: analytics({ 低: { n: 5, plays_avg: 20 }, 高: { n: 5, plays_avg: 5000 } }),
  });
  const high = QS.scoreVideo({ ...VIDEO, brand: '高' }, {
    now: NOW, analytics: analytics({ 低: { n: 5, plays_avg: 20 }, 高: { n: 5, plays_avg: 5000 } }),
  });
  assert.ok(high.score > low.score);

  const withOrders = QS.scoreVideo({ ...VIDEO, brand: '高' }, {
    now: NOW,
    analytics: analytics({ 高: { n: 5, plays_avg: 10 } }),
    orders: { brands: { 高: { orders: 30, gmv: 900 } } },
  });
  assert.ok(withOrders.score > high.score);
});

test('rankVideos：分数降序、同日可复现、优先品牌同分靠前', () => {
  const videos = [
    { ...VIDEO, file: 'b.mp4', brand: '高' },
    { ...VIDEO, file: 'a.mp4', brand: '低' },
    { ...VIDEO, file: 'c.mp4', brand: '低' },
  ];
  const ctx = {
    now: NOW,
    analytics: analytics({ 高: { n: 5, plays_avg: 800 }, 低: { n: 5, plays_avg: 10 } }),
    priorityBrands: ['低'],
  };
  const r1 = QS.rankVideos(videos, ctx).map(v => v.file);
  const r2 = QS.rankVideos(videos, ctx).map(v => v.file);
  assert.deepEqual(r1, r2);
  assert.equal(r1[0], 'b.mp4');
  // 同品牌同分时按文件名稳定排序
  assert.deepEqual(r1.slice(1), ['a.mp4', 'c.mp4']);
});

test('hourWeights：样本不足的时段压到中性，最好时段为 1', () => {
  const w = QS.hourWeights(analytics({}, { finish_avg: 0.1, cover_ctr_avg: 0.05 }, {
    '06-09': { n: 3, plays_avg: 50 },
    '09-12': { n: 3, plays_avg: 500 },
    '12-15': { n: 1, plays_avg: 9999 },
  }));
  assert.equal(w['09-12'], 1);
  assert.ok(w['06-09'] < 0.5);
  assert.equal(w['12-15'], 0.5);
  assert.equal(QS.hourWeights(null), null);
});

test('同品牌冷却：冷却窗口内挡同品牌，其他品牌照常入选', () => {
  const now = Date.parse('2026-11-11T12:00:00+08:00');
  const videos = [
    { ...VIDEO, file: 'a.mp4', brand: '品牌A' },
    { ...VIDEO, file: 'b.mp4', brand: '品牌B' },
  ];
  const usage = { 品牌A: { lastMs: now - 60 * 60000, todayCount: 1 } };
  const r = QS.filterBrandRhythm(videos, usage, { cooldownMinutes: 240, dailyCap: 2, now });
  assert.deepEqual(r.kept.map(v => v.file), ['b.mp4']);
  assert.equal(r.blocked.length, 1);
  assert.equal(r.blocked[0].reason, 'cooldown');
  assert.equal(r.blocked[0].next_at, new Date(now - 60 * 60000 + 240 * 60000).toISOString());
});

test('每日上限：冷却已过但当天已发满，仍然挡', () => {
  const now = Date.parse('2026-11-11T12:00:00+08:00');
  const videos = [{ ...VIDEO, file: 'a.mp4', brand: '品牌A' }];
  const usage = { 品牌A: { lastMs: now - 5 * 3600000, todayCount: 2 } };
  const r = QS.filterBrandRhythm(videos, usage, { cooldownMinutes: 240, dailyCap: 2, now });
  assert.equal(r.kept.length, 0);
  assert.equal(r.blocked[0].reason, 'daily-cap');
});

test('没有品牌或没上限：一律放行，绝不因规则配置错误让队列停摆', () => {
  const now = Date.parse('2026-11-11T12:00:00+08:00');
  const videos = [{ ...VIDEO, file: 'a.mp4', brand: null }, { ...VIDEO, file: 'b.mp4', brand: '品牌A' }];
  const usage = { 品牌A: { lastMs: now, todayCount: 99 } };
  assert.equal(QS.filterBrandRhythm(videos, {}, { cooldownMinutes: 0, dailyCap: 0, now }).kept.length, 2);
  assert.equal(QS.filterBrandRhythm(videos, usage, { cooldownMinutes: 0, dailyCap: 0, now }).kept.length, 2);
});

test('ageDays：库存越久加分越多，最多 7 天封顶', () => {
  const fresh = QS.scoreVideo({ ...VIDEO, mtime: NOW }, { now: NOW });
  const old = QS.scoreVideo({ ...VIDEO, mtime: NOW - 30 * 86400000 }, { now: NOW });
  assert.ok(old.score > fresh.score);
  assert.equal(QS.ageDays(NOW - 86400000, NOW), 1);
  assert.equal(QS.ageDays(null, NOW), 0);
});

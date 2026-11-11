// 账号周报：把 works.json / orders.json 变成一段人能直接看懂的结论 + 明确建议。
const fs = require('fs');
const path = require('path');

const pctText = v => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');
const numText = v => (typeof v === 'number' && Number.isFinite(v) ? (v >= 10000 ? `${(v / 10000).toFixed(1)}万` : String(Math.round(v * 10) / 10)) : '—');

function rankedBrands(analytics) {
  const brands = (analytics && analytics.brands) || {};
  return Object.entries(brands)
    .filter(([, s]) => s && s.n > 0 && typeof s.plays_avg === 'number')
    .map(([name, s]) => ({ name, ...s }))
    .sort((a, b) => b.plays_avg - a.plays_avg);
}

function buildReport(analytics, orders) {
  const lines = [];
  if (!analytics) {
    return { text: '还没有作品数据：先跑 stats_fetch.js 从创作者中心导出。', suggestions: ['先导出一次作品列表数据'] };
  }
  const o = analytics.overall || {};
  const day = String(analytics.exported_at || analytics.updated_at || '').slice(0, 10);
  lines.push(`# 账号数据周报（${day || '未知日期'}）`);
  lines.push('');
  lines.push(`样本：${analytics.count || 0} 条作品；播放合计 ${numText(o.plays_total)}，单条均值 ${numText(o.plays_avg)}。`);
  lines.push(`完播率 ${pctText(o.finish_avg)}；5s 完播 ${pctText(o.five_sec_avg)}；封面点击 ${pctText(o.cover_ctr_avg)}；2s 跳出 ${pctText(o.bounce_2s_avg)}。`);
  lines.push(`涨粉 ${numText(o.follower_delta_total)}；主页访问 ${numText(o.profile_visits_total)}；评论 ${numText(o.comments_total)}。`);
  lines.push('');

  const brands = rankedBrands(analytics);
  const solid = brands.filter(b => b.n >= 2);
  if (solid.length) {
    lines.push('## 品牌表现（按单条均播）');
    for (const b of solid.slice(0, 6)) {
      lines.push(`- ${b.name}：${b.n} 条，均播 ${numText(b.plays_avg)}，完播 ${pctText(b.finish_avg)}，2s 跳出 ${pctText(b.bounce_2s_avg)}`);
    }
    if (solid.length > 6) lines.push(`- …… 其余 ${solid.length - 6} 个品牌`);
    lines.push('');
  }

  const hours = Object.entries((analytics.hours) || {})
    .filter(([, s]) => s && s.n > 0)
    .sort((a, b) => (b[1].plays_avg || 0) - (a[1].plays_avg || 0));
  if (hours.length) {
    lines.push('## 时段表现（按单条均播）');
    for (const [k, s] of hours) lines.push(`- ${k} 点：${s.n} 条，均播 ${numText(s.plays_avg)}，完播 ${pctText(s.finish_avg)}`);
    lines.push('');
  }

  if (orders && orders.brands && Object.keys(orders.brands).length) {
    lines.push('## 出单（精选联盟/来客导出）');
    const list = Object.entries(orders.brands).sort((a, b) => (b[1].orders || 0) - (a[1].orders || 0));
    for (const [name, s] of list.slice(0, 10)) {
      lines.push(`- ${name}：${s.orders} 单，GMV ￥${s.gmv}，佣金 ￥${s.commission}`);
    }
    lines.push('');
  }

  const suggestions = [];
  if (typeof o.bounce_2s_avg === 'number' && o.bounce_2s_avg > 0.45) {
    suggestions.push(`2s 跳出率 ${pctText(o.bounce_2s_avg)} 偏高：前 2 秒必须给结果（价格/份量/成品特写），不要先铺垫。`);
  }
  if (typeof o.plays_avg === 'number' && o.plays_avg < 100) {
    suggestions.push(`单条均播只有 ${numText(o.plays_avg)}：先排查账号是否被限流（连续低播放 + 高跳出），再考虑降频、提高原创度。`);
  }
  if (typeof o.finish_avg === 'number' && o.finish_avg < 0.1) {
    suggestions.push(`完播率 ${pctText(o.finish_avg)} 偏低：把最香的 3 秒放开头，总时长压到 15 秒内。`);
  }
  if (solid.length >= 2) {
    const best = solid[0], worst = solid[solid.length - 1];
    if (best.plays_avg > worst.plays_avg * 2) {
      suggestions.push(`品牌差异明显（${best.name} 均播是 ${worst.name} 的 ${(best.plays_avg / Math.max(1, worst.plays_avg)).toFixed(1)} 倍），队列已按品牌表现自动加权。`);
    }
  }
  if (!orders || !orders.brands || !Object.keys(orders.brands).length) {
    suggestions.push('还没有出单数据：从精选联盟/来客导出后放进 runtime/publish/stats/orders.json，队列会把订单权重拉满。');
  }
  if (suggestions.length) {
    lines.push('## 建议');
    for (const s of suggestions) lines.push(`- ${s}`);
  }
  return { text: lines.join('\n'), suggestions };
}

function writeReport(analytics, orders, outPath) {
  const r = buildReport(analytics, orders);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, r.text + '\n');
  return r;
}

module.exports = { buildReport, writeReport, rankedBrands };

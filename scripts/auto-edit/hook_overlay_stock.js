#!/usr/bin/env node
'use strict';
// 给「原始素材已不在」的库存成片补开头钩子卡（2026-11-11 宝哥：29 条只叠钩子卡）。
// 不重剪、不推近：直接读现成成片，选钩子文案后只把 ASS 卡叠上去，音轨尽量直拷。
//
// 用法：
//   node scripts/auto-edit/hook_overlay_stock.js --dry-run      # 先看会处理哪些片
//   node scripts/auto-edit/hook_overlay_stock.js --limit 2      # 先渲 2 条验收
//   node scripts/auto-edit/hook_overlay_stock.js                # 全量到 素材库/已剪成片/钩子-YYYYMMDD/
//
// 名单来源：rerender_stock.js 的 manifest.skipped（源素材已不在/找不到工作目录）。
// 只处理仍在库存顶层的成片；已被品牌/字幕闸门挪走的片不碰。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.env.TUANGOU_ROOT || path.resolve(__dirname, '..', '..');
const PY = process.env.TUANGOU_PYTHON || 'D:/@kaifa/tools/python-media/Scripts/python.exe';
const TODAY = new Date();
const DATE = `${TODAY.getFullYear()}${String(TODAY.getMonth() + 1).padStart(2, '0')}${String(TODAY.getDate()).padStart(2, '0')}`;
const DRY = process.argv.includes('--dry-run');
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const LIMIT = Number(arg('--limit', 0));
const STOCK = path.join(ROOT, '素材库', '已剪成片');
// 名单默认取最近一次重剪 manifest；也可 --manifest 指定
const manifests = fs.readdirSync(path.join(ROOT, 'runtime', 'auto-edit'))
  .filter((f) => /^rerender-\d{8}\.json$/.test(f)).sort();
const manifestPath = arg('--manifest', manifests.length ? path.join('runtime', 'auto-edit', manifests[manifests.length - 1]) : null);
if (!manifestPath || !fs.existsSync(path.join(ROOT, manifestPath))) {
  console.error('找不到 rerender-YYYYMMDD.json（重剪清单），请用 --manifest 指定');
  process.exit(1);
}
const skipped = JSON.parse(fs.readFileSync(path.join(ROOT, manifestPath), 'utf8')).skipped || [];
const outDir = path.join(STOCK, `钩子-${DATE}`);
const reportPath = path.join(ROOT, 'runtime', 'auto-edit', `hook-overlay-${DATE}.json`);
const report = fs.existsSync(reportPath)
  ? JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  : { date: DATE, manifest: manifestPath, items: [] };
const done = new Map(report.items.map((x) => [x.film, x]));

const queue = [];
for (const x of skipped) {
  const film = x.film;
  const top = path.join(STOCK, film);
  if (!fs.existsSync(top)) { continue; } // 已被闸门挪走或已归档
  const prev = done.get(film);
  if (prev && prev.status !== 'error') continue;
  queue.push({ film, file: top });
}
// .mov 成片输出同名 .mp4，避免把 mp4 写成 .mov
const outName = (film) => film.replace(/\.(mov|mkv)$/i, '.mp4');

// 渲染后回读 meta.hook，报告里带上实际钩子文案，便于复核
function hookOf(outName) {
  const work = path.join(ROOT, 'runtime', 'auto-edit', 'work');
  let dirs = [];
  try { dirs = fs.readdirSync(work); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(work, d, 'meta.json');
    if (!fs.existsSync(p)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (m.output && path.basename(m.output) === outName) return m.hook ? m.hook.text : null;
    } catch { /* 坏 meta 跳过 */ }
  }
  return null;
}

console.log(`清单：${manifestPath}（缺源 ${skipped.length} 条）`);
console.log(`仍在库存顶层且未处理：${queue.length} 条；输出 ${path.relative(ROOT, outDir)}`);
const picked = LIMIT > 0 ? queue.slice(0, LIMIT) : queue;
if (DRY) {
  for (const q of picked) console.log(`  [dry] ${q.film}`);
  console.log('未加 --dry-run 之外的动作；本次只列计划');
  process.exit(0);
}
fs.mkdirSync(outDir, { recursive: true });

let cards = 0; let none = 0; let failed = 0;
for (const q of picked) {
  const name = outName(q.film);
  const out = path.join(outDir, name);
  if (fs.existsSync(out)) {
    console.log(`  已有输出，跳过：${name}`);
    continue;
  }
  console.log(`\n== ${q.film}`);
  const r = spawnSync(PY, [
    'scripts/auto-edit/auto_edit.py',
    '--hook-only',
    '--clip', q.film,
    '--out-dir', path.relative(ROOT, outDir),
    '--name', name,
  ], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, TUANGOU_ROOT: ROOT } });
  let status = 'error';
  let hook = null;
  if (r.status === 0) {
    if (fs.existsSync(out)) { status = 'card'; cards++; hook = hookOf(name); }
    else { status = 'none'; none++; }
  } else { failed++; }
  const rec = { film: q.film, out: fs.existsSync(out) ? path.relative(ROOT, out) : null, status, hook, at: new Date().toISOString() };
  report.items = report.items.filter((x) => x.film !== q.film).concat(rec);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}
console.log(`\n完成：加卡 ${cards} 条，无合格钩子 ${none} 条，失败 ${failed} 条；记录 ${path.relative(ROOT, reportPath)}`);

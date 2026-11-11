#!/usr/bin/env node
'use strict';
// 用重剪批次替换库存成片：重剪目录里的同名成片换掉「已剪成片」顶层那一版，
// 旧版移到 已剪成片/旧版-<日期>/ 留档（不直接删）。发布端只扫顶层，替换前新片不会被发出去。
//
// 用法：
//   node scripts/auto-edit/swap_rerender.js                 # 默认 dry-run，只列计划
//   node scripts/auto-edit/swap_rerender.js --apply         # 真正替换
//   node scripts/auto-edit/swap_rerender.js --dir 素材库/已剪成片/重剪-20261111
const fs = require('fs');
const path = require('path');

const ROOT = process.env.TUANGOU_ROOT || path.resolve(__dirname, '..', '..');
const APPLY = process.argv.includes('--apply');
// 默认只换「库存顶层已有的同名成片」。批处理期间被品牌/字幕闸门挪进子目录的片子
// （品牌待确认 / 字幕待修复）不能借替换动作混回发布队列，要加 --include-new 才搬。
const INCLUDE_NEW = process.argv.includes('--include-new');
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};

const outDir = path.join(ROOT, '素材库', '已剪成片');
const batchDir = path.resolve(ROOT, arg('--dir', findLatestBatch()));
function findLatestBatch() {
  const dirs = fs.readdirSync(outDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^重剪-\d{8}$/.test(e.name))
    .map((e) => e.name)
    .sort();
  if (!dirs.length) { console.error('没有找到 重剪-YYYYMMDD 目录，请用 --dir 指定'); process.exit(1); }
  return path.join('素材库', '已剪成片', dirs[dirs.length - 1]);
}
if (!fs.existsSync(batchDir)) { console.error(`批次目录不存在：${batchDir}`); process.exit(1); }

const tag = path.basename(batchDir);
const oldDir = path.join(outDir, `旧版-${tag.replace(/^重剪-/, '')}`);
const files = fs.readdirSync(batchDir).filter((f) => /\.(mp4|mov|mkv)$/i.test(f)).sort();
const toSwap = [];
const onlyNew = [];
for (const f of files) {
  const dst = path.join(outDir, f);
  (fs.existsSync(dst) ? toSwap : onlyNew).push(f);
}

console.log(`批次：${path.relative(ROOT, batchDir)}（${files.length} 条）`);
console.log(`替换同名成片 ${toSwap.length} 条；库存顶层没有的新片 ${onlyNew.length} 条`
  + (INCLUDE_NEW ? '（--include-new 会搬入）' : '（默认不动）'));
if (!APPLY) {
  for (const f of toSwap) console.log(`  [dry] ${f} ← ${path.relative(ROOT, batchDir)}/${f}`);
  for (const f of onlyNew) console.log(`  [dry] 跳过 ${f}：不在库存顶层`);
  console.log('未加 --apply，未改动任何文件');
  process.exit(0);
}
if (!INCLUDE_NEW) onlyNew.length = 0;

fs.mkdirSync(oldDir, { recursive: true });
let moved = 0;
for (const f of toSwap) {
  const src = path.join(batchDir, f);
  const dst = path.join(outDir, f);
  const bak = path.join(oldDir, f);
  if (fs.existsSync(bak)) fs.unlinkSync(bak); // 同一次重跑只留最新一版旧片
  fs.renameSync(dst, bak);
  fs.renameSync(src, dst);
  moved++;
}
for (const f of onlyNew) fs.renameSync(path.join(batchDir, f), path.join(outDir, f));
console.log(`已替换 ${moved} 条，新增 ${onlyNew.length} 条；旧版留档 ${path.relative(ROOT, oldDir)}`);

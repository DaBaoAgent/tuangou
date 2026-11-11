#!/usr/bin/env node
'use strict';
// 库存重剪：把「已剪成片」里还没发的成片，按当前剪辑配置重渲一遍（新开头结构）。
//
// 背景（2026-11-11）：开头 1.5 秒推近 + 顶部钩子卡上线时，库存成片是旧结构剪的。
// 源素材处理完会归档到「未剪素材/已剪」，auto_edit.py 默认只扫顶层，所以这里
// 用 --source-dir 指过去重剪，输出先落到单独目录，验收后再整体替换，避免新旧混发。
//
// 用法：
//   node scripts/auto-edit/rerender_stock.js --dry-run          # 只出计划
//   node scripts/auto-edit/rerender_stock.js --limit 2          # 先渲 2 条
//   node scripts/auto-edit/rerender_stock.js                    # 全量
//   node scripts/auto-edit/rerender_stock.js --only 华莱士-香酥翅尖-01.mp4
//
// 只处理能找回原始素材的成片（workdir/meta.json 指向的旧成片名 + 已剪源存在）。
// 源是上一版成片、原素材已经不在的，跳过并记到 manifest，交人工决定。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.env.TUANGOU_ROOT || path.resolve(__dirname, '..', '..');
const CFG_PATH = path.join(ROOT, 'scripts', 'auto-edit', 'config.json');
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));

const arg = (name, def = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : def;
};
const DRY = process.argv.includes('--dry-run');
const LIMIT = Number(arg('--limit', 0)) || 0;
const ONLY = arg('--only');
const OUT_DIR = arg('--out-dir', path.join('素材库', '已剪成片', `重剪-${stamp()}`));

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

const abs = (p) => path.resolve(ROOT, p);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// ---- 1) 库存成片：顶层 mp4，排除已发/审核样片/下划线开头
const outDir = abs(cfg.paths.output_dir);
const stock = fs.readdirSync(outDir, { withFileTypes: true })
  .filter((e) => e.isFile() && /\.(mp4|mov|mkv)$/i.test(e.name))
  .map((e) => e.name)
  .filter((n) => !n.startsWith('_') && !n.startsWith('审核样片'))
  .sort();

// ---- 2) 成片名 -> 剪辑工作目录（meta.json 及其备份，谁指向这条成片用谁）
const workRoot = abs(cfg.paths.work_dir);
const byOutput = new Map();
function noteMeta(wd, meta, backedUp) {
  const out = meta && meta.output ? path.basename(meta.output) : '';
  if (!out) return;
  const list = byOutput.get(out) || [];
  list.push({ stem: path.basename(wd), workdir: wd, meta, backedUp });
  byOutput.set(out, list);
}
for (const entry of fs.readdirSync(workRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const wd = path.join(workRoot, entry.name);
  const files = fs.readdirSync(wd).filter((f) => /^meta\.json(\.bak-.*)?$/.test(f));
  for (const f of files) {
    const meta = readJson(path.join(wd, f));
    if (meta) noteMeta(wd, meta, f !== 'meta.json');
  }
}

// ---- 3) 逐条判定能不能重剪
const srcDir = abs(cfg.paths.source_dir);
const doneSrcDir = abs(cfg.paths.done_source_dir);
const plan = [];
const skipped = [];
for (const film of stock) {
  if (ONLY && film !== ONLY) continue;
  const cands = (byOutput.get(film) || []).filter((c) => {
    const src = ['.mp4', '.MP4', '.mov', '.MOV', '.m4v'].map((x) => path.join(doneSrcDir, c.stem + x)).find((p) => fs.existsSync(p));
    return Boolean(src);
  });
  if (!cands.length) {
    const anyMeta = byOutput.get(film) || [];
    skipped.push({ film, reason: anyMeta.length ? '原始素材已不在「未剪素材/已剪」' : '找不到对应剪辑工作目录' });
    continue;
  }
  // 同一成片有多份 meta 时，选工作目录里 asr.json 最新的（最像这版成片的识别结果）
  cands.sort((a, b) => {
    const m = (c) => { try { return fs.statSync(path.join(c.workdir, 'asr.json')).mtimeMs; } catch { return 0; } };
    return m(b) - m(a);
  });
  const pick = cands[0];
  const src = ['.mp4', '.MP4', '.mov', '.MOV', '.m4v'].map((x) => path.join(doneSrcDir, pick.stem + x)).find((p) => fs.existsSync(p));
  plan.push({ film, stem: pick.stem, source: src, workdir: pick.workdir });
}

const todo = LIMIT ? plan.slice(0, LIMIT) : plan;
const manifestPath = path.join(ROOT, 'runtime', 'auto-edit', `rerender-${stamp()}.json`);
console.log(`库存成片 ${stock.length} 条；可重剪 ${plan.length} 条；本次处理 ${todo.length} 条`);
console.log(`输出目录：${OUT_DIR}`);
if (skipped.length) {
  console.log(`跳过 ${skipped.length} 条：`);
  for (const s of skipped) console.log(`  - ${s.film}：${s.reason}`);
}
if (DRY) {
  for (const p of todo) console.log(`  [dry] ${p.film} <- ${path.basename(p.source)}`);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({ date: stamp(), dryRun: true, outDir: OUT_DIR, plan: todo, skipped }, null, 1), 'utf8');
  console.log(`计划已写入 ${manifestPath}`);
  process.exit(0);
}

fs.mkdirSync(abs(OUT_DIR), { recursive: true });
// 先落 manifest，渲染中途失败也知道这批都包含哪些
const record = { date: stamp(), outDir: OUT_DIR, plan: todo, skipped, done: [], failed: [] };
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
const save = () => fs.writeFileSync(manifestPath, JSON.stringify(record, null, 1), 'utf8');
save();

const PY = process.env.TUANGOU_PYTHON || 'D:/@kaifa/tools/python-media/Scripts/python.exe';
for (const item of todo) {
  const args = [
    path.join(ROOT, 'scripts', 'auto-edit', 'auto_edit.py'),
    '--source-dir', path.relative(ROOT, doneSrcDir),
    '--out-dir', OUT_DIR,
    // 用带扩展名的完整文件名做匹配：源名经常是「xxx (1)」「xxx」这种前缀套前缀，
    // 只给 stem 会同时命中好几条，auto_edit 会列出来后直接返回、不渲染
    '--clip', path.basename(item.source),
    '--no-move',
    '--name', item.film,
  ];
  console.log(`\n===== 重剪 ${item.film} <- ${path.basename(item.source)}`);
  const r = spawnSync(PY, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, TUANGOU_ROOT: ROOT } });
  // --clip 命中多条时 auto_edit 会列出来直接返回 0，不算成功；以成片是否真的落地为准
  const made = fs.existsSync(path.join(abs(OUT_DIR), item.film));
  if (r.status === 0 && made) record.done.push(item);
  else record.failed.push({ ...item, status: r.status, made, error: r.error ? String(r.error) : '' });
  save();
}
console.log(`\n完成 ${record.done.length}/${todo.length}；失败 ${record.failed.length}`);
if (record.failed.length) for (const f of record.failed) console.log(`  失败 ${f.film}（status=${f.status}）`);
console.log(`记录：${manifestPath}`);

#!/usr/bin/env node
// 库存准备：待发成片不足时，自动把 素材库/未剪素材 剪成新成片（剪完的源素材移到 未剪素材/已剪）。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const L = require('./lib');

const PYTHON = 'C:/Users/20200/AppData/Local/Programs/Python/Python312/python.exe';
const AUTO_EDIT = path.join(L.ROOT, 'scripts/auto-edit/auto_edit.py');
const BUFFER = 2;

function log(msg) {
  const dir = path.join(L.CONFIG.paths.work_dir, 'logs');
  L.ensureDir(dir);
  fs.appendFileSync(path.join(dir, `${L.todayStr()}.log`), `[${new Date().toISOString()}] [prepare] ${msg}\n`);
  console.log(msg);
}

function sourceClips() {
  const dir = path.join(L.ROOT, '素材库/未剪素材');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /\.(mp4|mov|mkv)$/i.test(f))
    .map(f => path.join(dir, f))
    .sort((a, b) => { try { return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs; } catch { return 0; } });
}
function countFinished() {
  const dir = L.CONFIG.paths.video_dir;
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir)
    .filter(f => /\.(mp4|mov|mkv)$/i.test(f) && !f.startsWith('_') && !f.startsWith('审核样片')).length;
}
function wechat(text) {
  const r = L.pushWeChat(text);
  if (!r.ok) log(`wechat push failed: ${r.error}`);
}
function countSourceClips() { return sourceClips().length; }
// 刚复制进来的素材可能还没写完，等文件稳定 2 分钟再剪
function sourcesReady() {
  return sourceClips().every(p => { try { return Date.now() - fs.statSync(p).mtimeMs > 2 * 60 * 1000; } catch { return false; } });
}

const LOCK = path.join(L.CONFIG.paths.work_dir, 'prepare.lock');

function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!dryRun && fs.existsSync(LOCK) && Date.now() - fs.statSync(LOCK).mtimeMs < 4 * 60 * 60 * 1000) {
    log('prepare already running, skip');
    return;
  }
  if (!dryRun) { L.ensureDir(path.dirname(LOCK)); fs.writeFileSync(LOCK, String(process.pid)); }
  try { run(); } finally { if (!dryRun) { try { fs.unlinkSync(LOCK); } catch {} } }
}

function isOutsideWindow() {
  const now = new Date();
  const min = now.getHours() * 60 + now.getMinutes();
  const start = L.minutesOf(L.CONFIG.schedule.window.start);
  const end = L.minutesOf(L.CONFIG.schedule.window.end);
  return min < start - 15 || min > end + 15;
}

function isIdle() {
  const now = new Date();
  const min = now.getHours() * 60 + now.getMinutes();
  const start = L.minutesOf(L.CONFIG.schedule.window.start);
  // 发布窗口外直接算空闲
  if (isOutsideWindow()) return true;
  // 窗口内：距离下一个待发作品还有 60 分钟以上才算空闲
  const runLock = path.join(L.CONFIG.paths.work_dir, 'run.lock');
  if (fs.existsSync(runLock)) return false;
  const plan = L.loadPlan(L.todayStr());
  if (!plan) return min < start;
  const next = plan.items
    .filter(i => i.status === 'pending' && i.at)
    .map(i => L.minutesOf(i.at))
    .filter(m => m > min)
    .sort((a, b) => a - b)[0];
  return next == null || next - min > 60;
}

// 手动批量剪辑和计划任务可能同时存在：已有 auto_edit 进程时不重复抢同一个素材
function editRunning() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -match 'auto_edit.py' } | Select-Object -First 1 -ExpandProperty ProcessId"],
      { timeout: 15000, encoding: 'utf8' });
    return !!String(out).trim();
  } catch { return false; }
}

function runEdit(args) {
  log(`running auto_edit ${args.join(' ')}`);
  const before = countFinished();
  try {
    const out = execFileSync(PYTHON, [AUTO_EDIT, ...args], {
      cwd: L.ROOT, timeout: 45 * 60 * 1000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8',
    });
    log('auto_edit done\n' + out.split('\n').slice(-25).join('\n'));
    const added = countFinished() - before;
    if (added > 0) {
      wechat(`🎬 自动剪辑完成\n新增 ${added} 个成片，待发库存 ${L.pickVideo().length} 个`);
    }
  } catch (e) {
    log('auto_edit failed: ' + e.message);
    if (e.stdout) log('stdout tail:\n' + String(e.stdout).split('\n').slice(-20).join('\n'));
    wechat(`❌ 自动剪辑失败\n${String(e.message || e).slice(0, 200)}`);
  }
}

function run() {
  const dryRun = process.argv.includes('--dry-run');
  const date = L.todayStr();
  const state = L.loadState();
  const publishedToday = state.history.filter(h => h.date === date).length;
  const target = L.targetCount(date);
  const remaining = Math.max(0, target - publishedToday);
  const available = L.pickVideo().length;
  const source = countSourceClips();
  const idle = isIdle();
  log(`day=${L.dayIndex(date)} target=${target} published=${publishedToday} remaining=${remaining} available=${available} source=${source} idle=${idle}`);

  if (source <= 0) { log('no source clips left'); return; }
  if (!sourcesReady()) { log('source clips still being copied, skip this round'); return; }

  const lowInventory = available < remaining + BUFFER;
  if (!lowInventory && !idle) { log('inventory sufficient and busy'); return; }
  if (dryRun) {
    log(lowInventory
      ? `would clip up to ${remaining + BUFFER - available} more`
      : `idle: would clip ${isOutsideWindow() ? `all ${source}` : '1 of ' + source} source clips`);
    return;
  }

  if (editRunning()) { log('auto_edit already running, skip this round'); return; }

  if (lowInventory) {
    log('low inventory, clipping all sources');
    runEdit(['--all']);
    return;
  }
  // 空闲但在发布窗口内：一次只剪一条，避免长时间占满 CPU 影响定时发布
  if (isOutsideWindow()) {
    log('idle outside window, clearing source backlog');
    runEdit(['--all']);
  } else {
    const clip = sourceClips()[0];
    log(`idle slot, clipping one: ${path.basename(clip)}`);
    runEdit(['--clip', path.basename(clip)]);
  }
}

main();

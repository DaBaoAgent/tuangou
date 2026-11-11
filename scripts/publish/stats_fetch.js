#!/usr/bin/env node
// 账号数据采集：用已登录的浏览器档案打开「内容管理」→ 导出数据 → 解析 xlsx →
// 落 runtime/publish/stats/works.json，并生成一份文字周报。
// 由 Windows 计划任务 TuangouStats 每天调用；发布正在跑时自动让路（不抢同一个浏览器档案）。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const L = require('./lib');
const A = require('./analytics');
const SR = require('./stats_report');
const RV = require('./revenue');

const MANAGE_URL = 'https://creator.douyin.com/creator-micro/content/manage';
const EXPORT_TIMEOUT_MS = 240000;

function log(line) {
  const dir = path.join(L.CONFIG.paths.work_dir, 'logs');
  L.ensureDir(dir);
  const p = path.join(dir, `${L.todayStr()}.log`);
  fs.appendFileSync(p, `[${new Date().toISOString()}] [stats] ${line}\n`);
  console.log(line);
}

function notify(title, msg) {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'notify.ps1'), '-Title', title, '-Message', msg], { timeout: 15000 });
  } catch (e) { log(`notify failed: ${e.message}`); }
}

// 发布进程持锁时让路：同一个人工浏览器档案不能两个进程同时用
function publishBusy() {
  const lock = path.join(L.CONFIG.paths.work_dir, 'run.lock');
  if (!fs.existsSync(lock)) return false;
  let pid = 0;
  try { pid = Number(String(fs.readFileSync(lock, 'utf8')).trim()) || 0; } catch {}
  if (pid && L.isPidAlive(pid)) return true;
  try { return Date.now() - fs.statSync(lock).mtimeMs < 60 * 1000; } catch { return false; }
}

async function fetchExport(paths) {
  const launchOpts = {
    headless: true,
    viewport: { width: 1440, height: 960 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    acceptDownloads: true,
  };
  const chromiumPath = L.chromiumPath();
  if (chromiumPath) launchOpts.executablePath = chromiumPath;
  const browser = await chromium.launchPersistentContext(L.CONFIG.paths.profile_dir, launchOpts);
  const page = browser.pages()[0] || await browser.newPage();
  try {
    await page.goto(MANAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    const body = await page.locator('body').innerText().catch(() => '');
    if (body.includes('扫码登录') || page.url().includes('/login')) return { ok: false, reason: 'auth' };
    if (/验证码|安全验证|拖动滑块/.test(body)) return { ok: false, reason: 'captcha' };

    const btn = page.getByText('导出数据', { exact: true }).first();
    if (!(await btn.count())) return { ok: false, reason: 'no-export-button' };

    L.ensureDir(paths.raw);
    // 用本地时间命名，和日志/计划日期对得上（toISOString 是 UTC，21:33 会写成 1333）
    const d = new Date();
    const p2 = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`
      + `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const dest = path.join(paths.raw, `作品列表导出_${stamp}.xlsx`);
    const downloadPromise = page.waitForEvent('download', { timeout: EXPORT_TIMEOUT_MS });
    await btn.click({ force: true });
    const download = await downloadPromise;
    await download.saveAs(dest);
    // 顺带把「收入变现」的金额读下来（默认被遮挡，需要点开眼睛开关）
    let revenue = null;
    try { revenue = await RV.readRevenue(page); }
    catch (e) { log('revenue read failed: ' + String(e.message || e).split('\n')[0]); }
    return { ok: true, file: dest, revenue };
  } finally {
    await browser.close().catch(e => log('browser close failed: ' + e.message));
  }
}

function pruneRaw(dir, keep = 30) {
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.xlsx'))
      .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const x of files.slice(keep)) {
      try { fs.unlinkSync(path.join(dir, x.f)); } catch {}
    }
  } catch {}
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (publishBusy()) { log('publish running, skip this round'); return; }
  const paths = A.statsPaths(L.ROOT, L.CONFIG);
  const got = await fetchExport(paths);
  if (!got.ok) {
    log(`export failed: ${got.reason}`);
    if (got.reason === 'auth' || got.reason === 'captcha') {
      notify('团购数据采集暂停', got.reason === 'auth' ? '登录失效，需要重新扫码' : '遇到验证码/安全校验');
    }
    process.exit(got.reason === 'auth' || got.reason === 'captcha' ? 2 : 1);
  }
  log(`exported ${got.file}`);
  if (dryRun) { log('DRY_RUN skip ingest'); return; }

  const data = A.ingest({
    xlsxPath: got.file,
    root: L.ROOT,
    config: L.CONFIG,
    plansDir: path.join(L.CONFIG.paths.work_dir, 'plans'),
  });
  pruneRaw(paths.raw);
  if (got.revenue && got.revenue.ok) {
    try {
      log(`revenue ${RV.saveRevenue(paths.dir, got.revenue)}`
        + ` kpi_total=${got.revenue.kpi && got.revenue.kpi.total}`
        + ` last30=${got.revenue.kpi && got.revenue.kpi.last30}`);
    } catch (e) { log('revenue save failed: ' + e.message); }
  } else if (!got.revenue) {
    log('revenue read failed (see warning above)');
  } else {
    log(`revenue not ok: ${got.revenue.reason || 'kpi 未读到金额'}`);
  }
  const report = SR.writeReport(data, A.loadOrders(paths), path.join(paths.dir, 'report.md'));
  const o = data.overall || {};
  log(`ingested ${data.count} works; plays_avg=${o.plays_avg}; bounce_2s=${o.bounce_2s_avg}`);
  notify('团购账号数据已更新',
    `${data.count} 条作品；单条均播 ${Math.round(o.plays_avg || 0)}；完播 ${((o.finish_avg || 0) * 100).toFixed(1)}%；`
    + `2s 跳出 ${((o.bounce_2s_avg || 0) * 100).toFixed(1)}%`
    + (report.suggestions.length ? `\n建议：${report.suggestions[0]}` : ''));
}

main().catch(e => { log('FATAL ' + e.stack); process.exit(1); });

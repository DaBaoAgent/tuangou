#!/usr/bin/env node
// 收入变现采集：创作者中心的金额默认被「眼睛」开关遮成图片，
// 必须先点开才能读到数字，所以这里先派发点击再解析文本。
// 分两个层面：① 总览 KPI（昨日/近7日/近30日/累计/可提现）
//            ② 明细页各分类（选品带货=电商佣金、广告分成、变现任务…）
// 注意：本地生活「团购佣金」不在创作者中心，只在手机端团购达人中心，这里读不到。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const L = require('./lib');
const A = require('./analytics');

const CENTER_URL = 'https://creator.douyin.com/creator-micro/revenue/center';
const DETAIL_URL = 'https://creator.douyin.com/creator-micro/revenue/detail';
const TABS = ['选品带货', '变现任务', '创作基金', '内容付费', '更多变现'];

function numOf(s) {
  if (s === undefined || s === null) return null;
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function grab(text, re) {
  const m = String(text || '').match(re);
  return m ? numOf(m[1]) : null;
}

// 总览卡片：昨日收入 ¥ 0.69 较前日 +0.69 …
function parseKpi(text) {
  return {
    yesterday: grab(text, /昨日收入\s*¥\s*([\d,]+(?:\.\d+)?)/),
    last7: grab(text, /近7日收入\s*¥\s*([\d,]+(?:\.\d+)?)/),
    last30: grab(text, /近30日收入\s*¥\s*([\d,]+(?:\.\d+)?)/),
    total: grab(text, /收入总\s*¥\s*([\d,]+(?:\.\d+)?)/),
    withdrawable: grab(text, /可提现\s*¥\s*([\d,]+(?:\.\d+)?)/),
  };
}

// 分类卡片带日期区间：昨日 11.09 ¥ 0.00 近7日 11.03~11.09 ¥ 0.00 …
function parseTab(text) {
  const s = String(text || '');
  return {
    yesterday: grab(s, /昨日\s*\d{1,2}\.\d{1,2}\s*¥\s*([\d,]+(?:\.\d+)?)/),
    last7: grab(s, /近7日\s*[\d.\-~]{5,}\s*¥\s*([\d,]+(?:\.\d+)?)/),
    last30: grab(s, /近30日\s*[\d.\-~]{5,}\s*¥\s*([\d,]+(?:\.\d+)?)/),
    total: grab(s, /全部累计[^¥]{0,24}¥\s*([\d,]+(?:\.\d+)?)/),
  };
}

async function bodyText(page) {
  const t = await page.locator('body').innerText().catch(() => '');
  return String(t || '').replace(/\s+/g, ' ');
}

// 金额被遮住时页面上没有「¥」；点开所有 eye_closed 图标后才会换成数字。
// 每个图标只点一次再轮询：它是开关，外框和图标各点一下会点两次、把金额又遮回去。
async function revealAmounts(page) {
  if (/¥/.test(await bodyText(page))) return true;
  const clicked = await page.evaluate(() => {
    let n = 0;
    for (const el of document.querySelectorAll('[aria-label]')) {
      const lab = el.getAttribute('aria-label') || '';
      if (!/eye/i.test(lab) || /open/i.test(lab)) continue;
      const target = el.closest('button,[role=button]') || el.parentElement || el;
      target.click();
      n++;
    }
    return n;
  });
  if (!clicked) return false;
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(2000);
    if (/¥/.test(await bodyText(page))) return true;
  }
  return false;
}

async function isAuthPage(page) {
  if (/\/login/.test(page.url())) return true;
  return /扫码登录|请登录|登录后查看/.test(await bodyText(page));
}

// 复用调用方已打开的 page（stats_fetch 里），也可以单独跑 main()
async function readRevenue(page) {
  const out = { at: new Date().toISOString(), source: 'creator.douyin.com' };
  await page.goto(CENTER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000);
  if (await isAuthPage(page)) return { ok: false, reason: 'auth' };
  out.revealed = await revealAmounts(page);
  out.kpi = parseKpi(await bodyText(page));

  await page.goto(DETAIL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);
  out.tabs = {};
  for (const tab of TABS) {
    try {
      const el = page.getByText(tab, { exact: true }).first();
      if (await el.count()) {
        await el.click({ force: true });
        await page.waitForTimeout(5000);
      }
      await revealAmounts(page);
      out.tabs[tab] = parseTab(await bodyText(page));
    } catch (e) {
      out.tabs[tab] = { error: String(e.message || e).split('\n')[0] };
    }
  }
  out.ok = out.kpi.total !== null;
  return out;
}

function saveRevenue(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'revenue.json');
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
  return p;
}

module.exports = { parseKpi, parseTab, revealAmounts, readRevenue, saveRevenue, TABS };

if (require.main === module) {
  (async () => {
    const paths = A.statsPaths(L.ROOT, L.CONFIG);
    const lock = path.join(L.CONFIG.paths.work_dir, 'run.lock');
    if (fs.existsSync(lock)) {
      let pid = 0;
      try { pid = Number(String(fs.readFileSync(lock, 'utf8')).trim()) || 0; } catch {}
      if (pid && L.isPidAlive(pid)) { console.log('publish running, skip'); return; }
    }
    const launchOpts = {
      headless: true,
      viewport: { width: 1440, height: 1400 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      executablePath: L.chromiumPath() || undefined,
    };
    const ctx = await chromium.launchPersistentContext(L.CONFIG.paths.profile_dir, launchOpts);
    const page = ctx.pages()[0] || await ctx.newPage();
    try {
      const data = await readRevenue(page);
      if (!data.ok) { console.error('revenue read failed: ' + data.reason); process.exitCode = 2; return; }
      const file = saveRevenue(paths.dir, data);
      console.log(file);
      console.log(JSON.stringify(data, null, 1));
    } finally {
      await ctx.close().catch(() => {});
    }
  })().catch(e => { console.error(e); process.exit(1); });
}

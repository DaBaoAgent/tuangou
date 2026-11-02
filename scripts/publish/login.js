const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PROFILE_DIR = 'D:/@kaifa/tuangou/runtime/browser-profile';
const SHOT_DIR = 'D:/@kaifa/tuangou/runtime/publish/shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });

async function isLoggedIn(page) {
  const url = page.url();
  if (!url.includes('creator.douyin.com')) return false;
  if (url.includes('/login')) return false;
  const loginBtn = await page.locator('text=扫码登录').count().catch(() => 0);
  const userAvatar = await page.locator('[class*="avatar"], [class*="user-info"], [class*="header"] img').count().catch(() => 0);
  return loginBtn === 0 && userAvatar > 0;
}

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://creator.douyin.com/creator-micro/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  console.log('URL:', page.url());

  let ok = false;
  const deadline = Date.now() + 8 * 60 * 1000;
  let shotAt = 0;
  while (Date.now() < deadline) {
    if (await isLoggedIn(page)) { ok = true; break; }
    if (Date.now() - shotAt > 15000) {
      shotAt = Date.now();
      await page.screenshot({ path: path.join(SHOT_DIR, `login_${Date.now()}.png`) }).catch(() => {});
    }
    await page.waitForTimeout(2000);
  }
  if (ok) {
    await page.goto('https://creator.douyin.com/creator-micro/content/manage', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(SHOT_DIR, 'logged_in_manage.png') }).catch(() => {});
    console.log('LOGIN_OK');
  } else {
    console.log('LOGIN_TIMEOUT');
  }
  console.log('FINAL_URL:', page.url());
  await ctx.close();
  process.exit(ok ? 0 : 2);
})().catch(e => { console.error('ERR', e.stack); process.exit(1); });

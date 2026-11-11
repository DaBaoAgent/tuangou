
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const L = require('./lib');
const P = require('./publish_one');

const CHROMIUM = L.chromiumPath();
const POST_URL = 'https://creator.douyin.com/creator-micro/content/post/video?enter_from=publish_page';
const MANAGE_URL = 'https://creator.douyin.com/creator-micro/content/manage';

function log(msg) {
  const dir = path.join(L.CONFIG.paths.work_dir, 'logs');
  L.ensureDir(dir);
  fs.appendFileSync(path.join(dir, L.todayStr() + '.log'), '[' + new Date().toISOString() + '] [draft] ' + msg + '\n');
  console.log(msg);
}

// 只存草稿、绝不发布：抖音这一版发布页没有「保存草稿」按钮，草稿入口是底部的「暂存离开」。
async function saveDraft(videoInfo, copy, opts) {
  opts = opts || {};
  const launchOpts = {
    headless: opts.headless !== false,
    viewport: { width: 1440, height: 960 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    acceptDownloads: false,
  };
  if (CHROMIUM) launchOpts.executablePath = CHROMIUM;
  const browser = await chromium.launchPersistentContext(L.CONFIG.paths.profile_dir, launchOpts);
  const page = browser.pages()[0] || await browser.newPage();
  const shots = L.ensureDir(path.join(L.CONFIG.paths.work_dir, 'shots'));
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const shotPaths = [];
  const shot = async (name) => {
    const p = path.join(shots, stamp + '_' + name + '.png');
    try { await page.screenshot({ path: p }); shotPaths.push(p); } catch (e) {}
    return p;
  };
  let clickedDraft = false;

  try {
    await page.goto(POST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3500);

    if ((await page.locator('text=扫码登录').count()) > 0) { await shot('auth'); return { ok: false, reason: 'auth', shots: shotPaths }; }
    if ((await page.locator('text=验证码').count()) > 0 && (await page.locator('text=安全验证').count()) > 0) { await shot('captcha'); return { ok: false, reason: 'captcha', shots: shotPaths }; }

    await page.locator('input[type=file][accept*="video"]').setInputFiles(videoInfo.path);
    if (!(await P.waitUploadComplete(page))) { await shot('upload_timeout'); return { ok: false, reason: 'upload-timeout', shots: shotPaths }; }
    log('uploaded ' + videoInfo.file);

    const know = page.locator('text=我知道了');
    if (await know.count()) await know.first().click().catch(() => {});
    await page.waitForTimeout(500);

    const copyInfo = await P.fillCopy(page, copy);
    log('copy ' + JSON.stringify(copyInfo));

    const cover = await P.setCovers(page);
    log('cover ' + JSON.stringify(cover));

    let loc = { ok: false, reason: 'skipped' };
    const brand = videoInfo.locationBrand || videoInfo.brand;
    if (L.CONFIG.publish.add_location && brand) {
      loc = await P.setLocation(page, brand);
      log('location ' + JSON.stringify(loc));
    }

    const decl = await P.setDeclaration(page);
    log('declaration ' + decl);

    let settings = await P.ensureNotSimultaneous(page);
    if (settings.selected == null || (settings.syncChecked || []).length > 0) {
      await page.waitForTimeout(900);
      settings = await P.ensureNotSimultaneous(page);
    }
    await page.waitForTimeout(400);
    const check = await P.verifyBeforePublish(page, settings);
    log('precheck ' + JSON.stringify(check));
    await shot('before_draft');

    // 唯一的草稿入口：底部「暂存离开」。绝不点「发布」。
    const isPublish = t => /^\s*发\s*布\s*$/.test(t || '');
    for (const label of ['暂存离开', '暂存并离开']) {
      const cands = page.locator('button, [role=button], div, span').filter({ hasText: label });
      const n = await cands.count();
      for (let i = n - 1; i >= 0; i--) {
        const el = cands.nth(i);
        const t = (await el.innerText().catch(() => '')) || '';
        if (isPublish(t)) continue;
        if (t.replace(/\s/g, '') !== label) continue;
        try { await el.click({ force: true, timeout: 8000 }); clickedDraft = true; log('clicked ' + label); break; } catch (e) {}
      }
      if (clickedDraft) break;
    }
    if (!clickedDraft) { await shot('no_draft_button'); return { ok: false, reason: 'draft-button-missing', check, cover, loc, copyInfo, shots: shotPaths }; }

    await page.waitForTimeout(2500);
    await shot('after_draft_click');
    // 可能弹「确认暂存并离开？」之类确认框
    for (let i = 0; i < 3; i++) {
      const dlg = page.locator('.semi-modal button, .semi-modal-footer button, [role=dialog] button');
      const n = await dlg.count();
      let done = false;
      for (let j = 0; j < n; j++) {
        const t = ((await dlg.nth(j).innerText().catch(() => '')) || '').trim();
        if (/^(确定|确认|暂存并离开|暂存|保存)$/.test(t)) {
          await dlg.nth(j).click({ force: true }).catch(() => {});
          log('confirm dialog: ' + t); done = true; break;
        }
      }
      if (!done) break;
      await page.waitForTimeout(2000);
    }
    await page.waitForTimeout(3000);
    await shot('after_draft');
    const afterUrl = page.url();

    // 核实：先回发布页看有没有「继续编辑」的草稿恢复入口，再去内容管理找标题
    let found = false, where = null, boxText = '';
    const visit = async (url, tag) => {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(4000);
        const t = await page.locator('body').innerText().catch(() => '');
        await shot(tag);
        return t;
      } catch (e) { return ''; }
    };
    let body1 = await visit(MANAGE_URL, 'verify_manage');
    if (body1.includes(copy.title)) { found = true; where = 'manage'; boxText = body1; }
    if (!found) {
      const draftTab = page.locator('text=草稿').first();
      if (await draftTab.count()) {
        await draftTab.click().catch(() => {});
        await page.waitForTimeout(3500);
        const t2 = await page.locator('body').innerText().catch(() => '');
        await shot('verify_manage_draft');
        if (t2.includes(copy.title)) { found = true; where = 'manage_draft_tab'; boxText = t2; }
      }
    }
    if (!found) {
      const t3 = await visit('https://creator.douyin.com/creator-micro/content/draft', 'verify_draft_url');
      if (t3.includes(copy.title)) { found = true; where = 'draft_url'; boxText = t3; }
    }
    if (!found) {
      const t4 = await visit('https://creator.douyin.com/creator-micro/content/post/video', 'verify_post_restore');
      if (t4.includes('继续编辑') || t4.includes(copy.title)) { found = true; where = 'post_restore_prompt'; boxText = t4; }
    }
    log('verify found=' + found + ' where=' + where);
    const snapshot = boxText.replace(/\n+/g, '\n').slice(0, 2500);
    fs.writeFileSync(path.join(L.CONFIG.paths.work_dir, 'draft_verify.txt'), snapshot, 'utf8');
    return {
      ok: found, reason: found ? null : 'draft-not-found', where, title: copy.title, file: videoInfo.file,
      check, cover, loc, declaration: decl, settings, copyInfo,
      urlAfter: afterUrl, shots: shotPaths, pageTail: snapshot.slice(0, 600),
    };
  } catch (e) {
    log('ERROR ' + e.message);
    await shot('error');
    return { ok: false, reason: 'error', error: e.message, clickedDraft, shots: shotPaths };
  } finally {
    await browser.close().catch(e => log('browser close failed: ' + e.message));
  }
}

module.exports = { saveDraft };


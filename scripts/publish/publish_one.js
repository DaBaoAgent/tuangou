#!/usr/bin/env node
// 单条视频发布：上传 → 文案/话题 → 封面 → 位置门店 → AI 声明 → 发布 → 核实
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const L = require('./lib');

const CHROMIUM = 'C:/Users/20200/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe';
const POST_URL = 'https://creator.douyin.com/creator-micro/content/post/video?enter_from=publish_page';
const MANAGE_URL = 'https://creator.douyin.com/creator-micro/content/manage';

function log(msg) {
  const dir = path.join(L.CONFIG.paths.work_dir, 'logs');
  L.ensureDir(dir);
  fs.appendFileSync(path.join(dir, `${L.todayStr()}.log`), `[${new Date().toISOString()}] ${msg}\n`);
  console.log(msg);
}

async function clickByTextIn(page, rootSelector, text, { exact = true } = {}) {
  return page.evaluate(({ rootSelector, text, exact }) => {
    const root = rootSelector ? document.querySelector(rootSelector) : document;
    if (!root) return false;
    const els = [...root.querySelectorAll('button,div,span')].filter(e => {
      const t = (e.innerText || '').trim();
      return exact ? t === text : t.includes(text);
    });
    const btn = els.find(e => e.tagName === 'BUTTON') || els[els.length - 1];
    if (!btn) return false;
    btn.click();
    return true;
  }, { rootSelector, text, exact });
}

async function isVisible(page, selector) {
  return page.locator(selector).first().isVisible().catch(() => false);
}

async function waitUploadComplete(page) {
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1500);
    const body = await page.locator('body').innerText();
    if (body.includes('重新上传')) return true;
  }
  return false;
}

async function fillCopy(page, copy) {
  const titleInput = page.locator('input[placeholder*="作品标题"]');
  await titleInput.click();
  await titleInput.fill(copy.title);

  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.type(copy.desc, { delay: 12 });
  for (const topic of copy.topics) {
    await page.keyboard.type(topic, { delay: 10 });
    await page.waitForTimeout(800);
    await page.keyboard.press('Space');
    await page.waitForTimeout(350);
  }
  // 校验话题胶囊
  const html = await editor.evaluate(e => e.innerHTML);
  const got = (html.match(/data-mention="#"/g) || []).length;
  return { titleLen: copy.title.length, descLen: copy.desc.length, topicsRendered: got };
}

async function setDeclaration(page) {
  const trigger = page.locator('text=请选择自主声明').first();
  if (await trigger.count()) {
    await trigger.click();
    await page.waitForTimeout(900);
    await page.locator('.semi-modal .semi-radio', { hasText: '内容由AI生成' }).first().click();
    await page.waitForTimeout(300);
    await page.locator('.semi-modal button', { hasText: '确定' }).first().click();
    await page.waitForTimeout(900);
  }
  const body = await page.locator('body').innerText();
  return body.includes('内容由AI生成');
}

async function setCovers(page) {
  const openBtn = page.locator('text=选择封面').first();
  if (!(await openBtn.count())) return { ok: false, reason: 'no-cover-button' };
  await openBtn.click();
  await page.waitForTimeout(2200);
  const dlgSelector = '.dy-creator-content-modal-content';
  if (!(await page.locator(dlgSelector).count())) return { ok: false, reason: 'cover-dialog-missing' };

  // 竖封面「完成」后，抖音会自动基于竖封面生成横封面
  await clickByTextIn(page, dlgSelector, '完成');
  await page.waitForTimeout(2500);

  // 可能出现「设置横封面获更多流量」提示框：横封面已自动生成，选暂不设置
  for (let i = 0; i < 3; i++) {
    const promo = await page.locator('text=设置横封面获更多流量').count();
    if (!promo) break;
    await clickByTextIn(page, null, '暂不设置');
    await page.waitForTimeout(700);
  }
  // 若弹窗仍在，关闭它
  const closeBtn = page.locator('.dy-creator-content-modal-content .semi-modal-close, .dy-creator-content-modal-content [aria-label="Close"]').first();
  if (await closeBtn.count()) await closeBtn.click({ force: true }).catch(() => {});
  const body = await page.locator('body').innerText();
  return { ok: !body.includes('横/竖双封面缺失'), missing: body.includes('横/竖双封面缺失') };
}

async function setLocation(page, brand) {
  if (!brand) return { ok: false, reason: 'no-brand' };
  const trigger = page.locator('text=输入地理位置').first();
  if (!(await trigger.count())) return { ok: false, reason: 'no-location-input' };
  await trigger.click();
  await page.waitForTimeout(1200);
  const input = page.locator('.semi-select-open input').first();
  if (!(await input.count())) return { ok: false, reason: 'no-search-input' };
  await input.click();
  await page.keyboard.type(brand, { delay: 60 });
  await page.waitForTimeout(2600);

  const options = await page.evaluate(() => [...document.querySelectorAll('.semi-select-option')]
    .map((el, i) => ({ i, text: el.innerText.trim() }))
    .filter(o => o.text));
  if (!options.length) return { ok: false, reason: 'no-options' };
  // 只选品牌匹配的门店；没有匹配就不挂位置，绝不选不相关门店
  const matched = options.filter(o => o.text.includes(brand));
  if (!matched.length) {
    await page.keyboard.press('Escape').catch(() => {});
    return { ok: false, reason: 'no-matching-store', candidates: options.length };
  }
  const pick = matched.find(o => o.text.includes('商品')) || matched[0];
  const target = page.locator('.semi-select-option').nth(pick.i);
  await target.click({ force: true });
  await page.waitForTimeout(1200);
  const selectedText = pick.text.split('\n')[0];
  const body = await page.locator('body').innerText();
  return { ok: body.includes(selectedText), selected: selectedText, candidates: options.length };
}

// 确认「不同时发布」被选中：只认文字上下文匹配的 radio；读不到状态就点一下并按未知放行
async function ensureNotSimultaneous(page) {
  return page.evaluate(() => {
    const text = '不同时发布';
    const exact = [...document.querySelectorAll('label,div,span')]
      .filter(e => (e.innerText || '').trim() === text);
    let el = exact[exact.length - 1];
    if (!el) {
      el = [...document.querySelectorAll('label,div,span')]
        .filter(e => (e.innerText || '').includes(text))
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
    }
    if (!el) return { found: false, selected: null, clicked: false, via: 'missing' };

    // 先看祖先 className 是否已标记选中，避免对已选中的自定义单选框再点一次
    let node = el;
    for (let i = 0; i < 4 && node; i++, node = node.parentElement) {
      if (/checked|selected|active/i.test(String(node.className || ''))) {
        return { found: true, selected: true, clicked: false, via: 'class' };
      }
    }

    // 只接受文字上下文里也包含「不同时发布」的 input，避免误读同组第一个 radio
    let input = null;
    node = el;
    for (let i = 0; i < 4 && node && !input; i++, node = node.parentElement) {
      const inputs = [...(node.querySelectorAll ? node.querySelectorAll('input[type=radio],input[type=checkbox]') : [])];
      input = inputs.find(inp => {
        const lab = inp.closest && inp.closest('label');
        const ctx = (lab && lab.innerText) || (inp.parentElement && inp.parentElement.innerText) || '';
        return ctx.includes(text);
      }) || null;
    }
    if (input) {
      const was = !!input.checked;
      if (!was) el.click();
      return { found: true, selected: !!input.checked, clicked: !was, via: 'input' };
    }
    el.click();
    return { found: true, selected: null, clicked: true, via: 'text' };
  });
}

async function verifyBeforePublish(page, settings = {}) {
  const body = await page.locator('body').innerText();
  return {
    aiDeclaration: body.includes('内容由AI生成'),
    // 必须读到明确选中状态才放行；读不到（selected=null）一律按未确认处理
    notSimultaneous: body.includes('不同时发布') && settings.selected === true,
    publishNow: body.includes('立即发布'),
    coverMissing: body.includes('横/竖双封面缺失'),
    hasLocation: !body.includes('输入地理位置'),
  };
}

async function publishOne(videoInfo, copy, opts = {}) {
  const dryRun = !!opts.dryRun;
  const browser = await chromium.launchPersistentContext(L.CONFIG.paths.profile_dir, {
    executablePath: CHROMIUM,
    headless: opts.headless !== false,
    viewport: { width: 1440, height: 960 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    acceptDownloads: false,
  });
  const page = browser.pages()[0] || await browser.newPage();
  const shots = L.ensureDir(path.join(L.CONFIG.paths.work_dir, 'shots'));
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  let clickedPublish = false;

  try {
    await page.goto(POST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3500);

    if ((await page.locator('text=扫码登录').count()) > 0) return { ok: false, reason: 'auth' };
    if ((await page.locator('text=验证码').count()) > 0 && (await page.locator('text=安全验证').count()) > 0) return { ok: false, reason: 'captcha' };

    await page.locator('input[type=file][accept*="video"]').setInputFiles(videoInfo.path);
    if (!(await waitUploadComplete(page))) return { ok: false, reason: 'upload-timeout' };
    log('uploaded ' + videoInfo.file);

    const know = page.locator('text=我知道了');
    if (await know.count()) await know.first().click().catch(() => {});
    await page.waitForTimeout(500);

    const copyInfo = await fillCopy(page, copy);
    log('copy filled ' + JSON.stringify(copyInfo));
    if (!dryRun && copyInfo.topicsRendered < L.CONFIG.copy.topics_min) {
      return { ok: false, reason: 'topics-missing', topicsRendered: copyInfo.topicsRendered };
    }

    const cover = await setCovers(page);
    log('cover ' + JSON.stringify(cover));

    let loc = { ok: false, reason: 'skipped' };
    const locationBrand = videoInfo.locationBrand || videoInfo.brand;
    if (L.CONFIG.publish.add_location && locationBrand) {
      loc = await setLocation(page, locationBrand);
      log('location ' + JSON.stringify(loc));
    }

    const decl = await setDeclaration(page);
    log('declaration ' + decl);

    let settings = await ensureNotSimultaneous(page);
    // 读不到选中状态时再确认一次；仍然读不到就按未选中处理，不发布
    if (settings.selected == null) {
      await page.waitForTimeout(900);
      settings = await ensureNotSimultaneous(page);
    }
    await page.waitForTimeout(400);
    log('settings ' + JSON.stringify(settings));

    const check = await verifyBeforePublish(page, settings);
    log('precheck ' + JSON.stringify(check));
    await page.screenshot({ path: path.join(shots, `${stamp}_before_publish.png`), fullPage: false });

    if (dryRun) {
      return { ok: true, dryRun: true, check, copyInfo, cover, loc, declaration: decl, settings };
    }
    if (!check.aiDeclaration) return { ok: false, reason: 'ai-declaration-missing' };
    if (!check.notSimultaneous) return { ok: false, reason: 'not-simultaneous-missing' };
    if (check.coverMissing) return { ok: false, reason: 'cover-missing' };
    // 品牌已确认时必须挂上位置门店（宝哥 2026-11-02）；门店没挂上就不发，留队重试/通知
    // add_location 关闭时不做此拦截（兼容手动关闭位置标签的配置）
    if (L.CONFIG.publish.add_location && locationBrand && !loc.ok && !check.hasLocation) {
      return { ok: false, reason: 'location-missing', loc, check, copyInfo, cover, declaration: decl, settings };
    }

    // 点击底部「发布」。标志位先置位：点击一旦发起，后续任何异常都可能意味着已发布
    clickedPublish = true;
    const publishBtn = page.locator('button', { hasText: /^发布$/ }).last();
    await publishBtn.click({ force: true });

    // 等待发布结果
    let success = false;
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(2000);
      const url = page.url();
      const body = await page.locator('body').innerText().catch(() => '');
      if (body.includes('发布成功') || url.includes('content/manage')) { success = true; break; }
      // 已经点过「发布」，无论后面遇到验证码还是登录失效都不能当成未发布：可能已经发出去
      if (/验证码|安全验证|拖动滑块/.test(body)) return { ok: false, reason: 'captcha', clickedPublish };
      if (url.includes('/login') || body.includes('扫码登录')) return { ok: false, reason: 'auth', clickedPublish };
    }
    await page.screenshot({ path: path.join(shots, `${stamp}_after_publish.png`) });
    if (!success) return { ok: false, reason: 'publish-result-unknown', clickedPublish };

    // 到内容管理核实
    await page.goto(MANAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    const manageBody = await page.locator('body').innerText();
    const html = await page.content();
    const idMatches = [...html.matchAll(/work-detail\/(\d+)/g)].map(m => m[1]);
    // 只认这条作品自己的状态：在标题所在行的后续几行里找审核/发布状态
    const lines = manageBody.split('\n').map(s => s.trim());
    const idx = lines.findIndex(l => l.includes(copy.title));
    const cardWindow = idx >= 0 ? lines.slice(idx, idx + 8).join(' ') : '';
    const status = (cardWindow.match(/已发布|审核中|审核通过|审核不通过|仅自己可见/) || [null])[0];
    await page.screenshot({ path: path.join(shots, `${stamp}_manage.png`) });
    log(`verified found=${idx >= 0} status=${status} id=${idMatches[0] || 'none'}`);
    // 已经跳转并出现「发布成功」，列表暂时看不到不能当失败重试，否则会重复发布
    if (idx < 0) return { ok: true, workId: idMatches[0] || null, status: 'unknown', check, loc, verify_note: 'title-not-found' };
    if (status === '审核不通过') return { ok: false, reason: 'verify-failed', status, loc };
    return { ok: true, workId: idMatches[0] || null, status: status || 'unknown', check, loc };
  } catch (e) {
    log('ERROR ' + e.message);
    await page.screenshot({ path: path.join(shots, `${stamp}_error.png`) }).catch(() => {});
    return { ok: false, reason: 'error', error: e.message, clickedPublish };
  } finally {
    // 关闭浏览器失败不能覆盖上面已经确定的发布结果
    await browser.close().catch(e => log('browser close failed: ' + e.message));
  }
}

module.exports = { publishOne };

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fileArg = args.find(a => a.endsWith('.mp4'));
  const videos = L.inspectVideos();
  const video = fileArg ? videos.find(v => v.file === path.basename(fileArg)) : videos.find(v => v.brand) || videos[0];
  if (!video) { console.error('no video'); process.exit(2); }
  const state = L.loadState();
  const copy = L.buildCopy(video, state);
  console.log('VIDEO', video.file, 'BRAND', video.brand);
  console.log('COPY', JSON.stringify(copy, null, 2));
  publishOne(video, copy, { dryRun }).then(r => {
    console.log('RESULT', JSON.stringify(r, null, 2));
    if (r.ok && !dryRun) {
      const destDir = L.ensureDir(L.CONFIG.paths.published_dir);
      let dest = path.join(destDir, path.basename(video.path));
      if (fs.existsSync(dest)) {
        const ext = path.extname(video.path);
        dest = path.join(destDir, `${path.basename(video.path, ext)}_${Date.now()}${ext}`);
      }
      fs.renameSync(video.path, dest);
      state.history.push({ date: L.todayStr(), file: video.file, at: new Date().toISOString(), work_id: r.workId || null, title: copy.title });
      L.saveState(state);
      console.log('MOVED', dest);
    }
    process.exit(r.ok ? 0 : 1);
  });
}

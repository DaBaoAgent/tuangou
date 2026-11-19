#!/usr/bin/env node
// 单条视频发布：上传 → 文案/话题 → 封面 → 位置门店 → AI 声明 → 发布 → 核实
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const L = require('./lib');
const { decideProduct, promoTitle } = require('./product_pick');

// Chromium（A4，2026-11-08）：环境变量 → config.publish.chromium_path → 扫 ms-playwright 最高版本；
// 都没有就留空，走 playwright 自带的那一份，升级/换机不会整条断。
const CHROMIUM = L.chromiumPath();
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

// 上传等待（B6，2026-11-08）：默认 240 秒，从 config 读，长视频不再 90 秒就判超时白传一次
const UPLOAD_TIMEOUT_MS = Math.max(30, Number(L.CONFIG.publish.upload_timeout_sec ?? 240)) * 1000;
const PUBLISH_RESULT_TIMEOUT_MS = Math.max(30, Number(L.CONFIG.publish.publish_result_timeout_sec ?? 240)) * 1000;

async function waitUploadComplete(page) {
  const tries = Math.max(1, Math.ceil(UPLOAD_TIMEOUT_MS / 1500));
  for (let i = 0; i < tries; i++) {
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

  // 2026-11-14 实跑修正：这个弹窗是「设置竖封面 / 设置横封面」两个 tab，
  // 只点一次「完成」只保存竖封面，发文助手会一直挂「横/竖双封面缺失」。
  // 正确做法：竖封面 tab 点完成 → 重新打开弹窗 → 切到横封面 tab → 再点完成。
  const tabDone = async (tabName) => {
    const tab = page.locator(dlgSelector).getByText(tabName, { exact: true }).first();
    if (await tab.count()) { await tab.click({ force: true }).catch(() => {}); await page.waitForTimeout(1800); }
    const done = page.locator(dlgSelector).getByText('完成', { exact: true }).first();
    if (await done.count()) await done.click({ force: true }).catch(() => {});
    await page.waitForTimeout(2600);
    // 「设置横封面获更多流量」营销弹窗：直接关掉，横封面自己走 tab 设
    for (let i = 0; i < 3; i++) {
      const promo = await page.locator('text=设置横封面获更多流量').count();
      if (!promo) break;
      await clickByTextIn(page, null, '暂不设置');
      await page.waitForTimeout(700);
    }
    const stillOpen = await page.locator(dlgSelector).count();
    if (stillOpen) {
      const closeBtn = page.locator(`${dlgSelector} .semi-modal-close, ${dlgSelector} [aria-label="Close"]`).first();
      if (await closeBtn.count()) await closeBtn.click({ force: true }).catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(1200);
    }
  };

  await tabDone('设置竖封面');

  // 横封面：保存竖封面后弹窗关闭，页面会浮出提示「已基于竖封面为你生成横封面。效果不满意？独立编辑」。
  // 抖音自动生成的那张横封面，发文助手仍判「横封面缺失」，必须点「独立编辑」进横封面 tab 再保存一次。
  // 2026-11-14 实跑：此时「选择封面」按钮已消失，只能走「独立编辑」。
  // 2026-11-17：08:37 那条保存竖封面后只等了 0.9s 没等到「独立编辑」入口（horizontalEdits=0），
  // 直接被判 cover-missing 白跑一遍。改成轮询等入口（约 10s），等不到就用「选择封面」重开弹窗直接设横封面。
  const waitForEntry = async (tries = 12) => {
    for (let i = 0; i < tries; i++) {
      const el = page.getByText('独立编辑', { exact: true }).first();
      if (await el.count()) return el;
      await page.mouse.move(560, 470);
      await page.waitForTimeout(800);
    }
    return null;
  };
  let horizontalEdits = 0;
  let link = await waitForEntry();
  if (!link) {
    const reopen = page.locator('text=选择封面').first();
    if (await reopen.count()) {
      await reopen.click({ force: true }).catch(() => {});
      await page.waitForTimeout(2200);
      if (await page.locator(dlgSelector).count()) {
        await tabDone('设置横封面');
        horizontalEdits += 1;
      }
    }
  }
  for (let attempt = 0; attempt < 3 && link; attempt++) {
    await link.click({ force: true }).catch(() => {});
    await page.waitForTimeout(2500);
    if (!(await page.locator(dlgSelector).count())) { link = null; break; }
    const htab = page.locator(dlgSelector).getByText('设置横封面', { exact: true }).first();
    if (await htab.count()) { await htab.click({ force: true }).catch(() => {}); await page.waitForTimeout(2200); }
    const done2 = page.locator(dlgSelector).getByText('完成', { exact: true }).first();
    if (await done2.count()) await done2.click({ force: true }).catch(() => {});
    await page.waitForTimeout(3000);
    horizontalEdits += 1;
    if (await page.locator(dlgSelector).count()) {
      const closeBtn = page.locator(`${dlgSelector} .semi-modal-close, ${dlgSelector} [aria-label="Close"]`).first();
      if (await closeBtn.count()) await closeBtn.click({ force: true }).catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(1200);
    }
    const b0 = await page.locator('body').innerText();
    if (!(/横封面缺失/.test(b0))) { link = null; break; }
    link = await waitForEntry(6);
  }
  // 发文助手的检测结果会滞后，主动点一次「重新检测」再判
  const redetect = page.getByText('重新检测', { exact: true }).first();
  if (await redetect.count()) { await redetect.click({ force: true }).catch(() => {}); await page.waitForTimeout(3000); }
  // 「检测中 35%」阶段文案是旧的，等它跑完再读结论
  for (let i = 0; i < 14; i++) {
    const b = await page.locator('body').innerText();
    if (!/检测中/.test(b)) break;
    await page.waitForTimeout(3000);
  }
  const body = await page.locator('body').innerText();
  const missing = body.includes('横/竖双封面缺失') || body.includes('横封面缺失');
  return { ok: !missing, missing, horizontalEdits };
}

// 品牌名里常带品类后缀（茶芭蕾新疆酸奶 / 某某烤肉自助），而 POI 门店名只写品牌主词。
// 2026-11-14 实跑：茶芭蕾新疆酸奶-待确认-03 整串搜出 12 个候选、无一含品牌串 → 挂不上门店 → PUBLISH_FAIL location-missing。
// 这里给出「品牌整串 → 去括号 → 去品类后缀」的搜索词序列，逐个试；只有门店名包含当前搜索词才选，绝不乱选。
const CATEGORY_SUFFIXES = ['新疆酸奶', '新疆奶茶', '鲜奶茶', '鲜果茶', '奶茶', '酸奶', '茶饮', '果茶', '咖啡', '美式', '拿铁', '火锅', '烤肉', '自助', '炸鸡', '鸡排', '汉堡', '螺蛳粉', '米线', '麻辣烫', '串串', '甜品', '蛋糕', '烘焙', '零食', '食品', '饮品', '水饺', '饺子', '拌面', '披萨', '比萨', '套餐', '代金券'];
// alias（2026-11-19）：品牌的官方叫法常常和我们的品牌名不一样（比格披萨 vs 比格比萨、BIGPIZZA），
// 只用品牌名搜门店会搜不到分店、退化成品牌级 POI。从 brands.json 的 aliases 里补中文别名一起搜。
function brandAliases(brand) {
  const list = (L.BRANDS && Array.isArray(L.BRANDS.brands)) ? L.BRANDS.brands : [];
  const e = list.find(x => String((x && x.name) || '') === brand)
    || list.find(x => (x && x.aliases || []).includes(brand));
  if (!e) return [];
  return (e.aliases || []).filter(a => /[\u4e00-\u9fff]/.test(String(a)) && !String(a).includes(brand));
}

function brandKeywords(brand) {
  const raw = String(brand || '').trim();
  if (!raw) return [];
  const seeds = [raw, ...brandAliases(raw)];
  const out = [];
  const push = (k) => { const v = String(k || '').trim(); if (v.length >= 2 && !out.includes(v)) out.push(v); };
  // 先按原样搜（品牌名、官方别名），再用去掉品类后缀的核心词兜底——核心词要排在别名之后，
  // 否则「比格」会先命中品牌级 POI，把分店挡在后面（2026-11-19 实测）。
  for (const seed of seeds) {
    push(seed);
    const noParen = seed.replace(/（[^）]*）|\([^)]*\)|\[[^\]]*\]/g, '').trim();
    push(noParen);
  }
  for (const seed of seeds) {
    let core = seed.replace(/（[^）]*）|\([^)]*\)|\[[^\]]*\]/g, '').trim() || seed;
    const sorted = CATEGORY_SUFFIXES.slice().sort((a, b) => b.length - a.length);
    for (const suf of sorted) {
      if (core.length > suf.length && core.endsWith(suf)) {
        core = core.slice(0, core.length - suf.length).trim();
        break;
      }
    }
    push(core);
  }
  return out;
}

async function searchStoreOptions(page, keyword) {
  const input = page.locator('.semi-select-open input').first();
  if (!(await input.count())) return null;
  await input.click();
  await input.fill('').catch(() => {});
  await page.keyboard.type(keyword, { delay: 60 });
  await page.waitForTimeout(2600);
  return page.evaluate(() => [...document.querySelectorAll('.semi-select-option')]
    .map((el, i) => ({ i, text: el.innerText.trim() }))
    .filter(o => o.text));
}

async function setLocation(page, brand) {
  if (!brand) return { ok: false, reason: 'no-brand' };
  const trigger = page.locator('text=输入地理位置').first();
  if (!(await trigger.count())) return { ok: false, reason: 'no-location-input' };
  const keywords = brandKeywords(brand);
  let lastCandidates = 0;
  for (let k = 0; k < keywords.length; k++) {
    const kw = keywords[k];
    if (k === 0) {
      await trigger.click();
    } else {
      await trigger.click().catch(() => {});
    }
    await page.waitForTimeout(1200);
    const options = await searchStoreOptions(page, kw);
    if (options === null) return { ok: false, reason: 'no-search-input' };
    if (!options.length) {
      await page.keyboard.press('Escape').catch(() => {});
      continue;
    }
    lastCandidates = options.length;
    // 只选门店名包含当前搜索词的；没有匹配就换下一个搜索词，绝不选不相关门店。
    // 2026-11-17：命中之后还要排序——带分店后缀的优先，品牌级 POI（名字就是「肯德基」）排最后，
    // 避免像 08:37 那条一样把锚点挂到没有门店的品牌页上。
    const pick = L.pickStoreOption(options, kw);
    if (!pick) {
      await page.keyboard.press('Escape').catch(() => {});
      continue;
    }
    const target = page.locator('.semi-select-option').nth(pick.i);
    await target.click({ force: true });
    await page.waitForTimeout(1200);
    const selectedText = pick.text.split('\n')[0];
    const body = await page.locator('body').innerText();
    const ok = body.includes(selectedText);
    if (ok) {
      if (pick.brand_poi) log(`location brand-level POI: ${selectedText}（列表里没有分店，锚点退化为品牌页）`);
      return { ok, selected: selectedText, candidates: pick.candidates, keyword: kw, brand_poi: pick.brand_poi };
    }
    await page.keyboard.press('Escape').catch(() => {});
  }
  return { ok: false, reason: 'no-matching-store', candidates: lastCandidates, tried: keywords };
}

// 挂团购商品（2026-11-10）：位置 → 团购 → 请选择团购商品 → 输品牌过滤 → 选最合适的一条。
// 商品挂上后位置自动跟商品走，不再单独挂门店；挂不上返回 ok:false，由调用方决定是否退回只挂门店。
const PRODUCT_HINTS = (() => {
  try { return L.readJson(path.join(__dirname, 'brand_product_hints.json'), {}) || {}; } catch { return {}; }
})();
const GENERIC_PRODUCT = /^(零食|美食|套餐|代金券|团购|饮品|小吃|待确认)$/;
async function setProduct(page, { brand, product } = {}) {
  if (!brand) return { ok: false, reason: 'no-brand' };
  // 2026-11-15（宝哥要求）：品牌有固定主推单品时（如 好想来 → 99 买 100 代金券），
  // 文案没指定具体商品就按主推词搜，命中不了宁可不挂商品。
  const hint = ((PRODUCT_HINTS.brands || {})[brand] || {});
  const hintTerms = Array.isArray(hint.terms) ? hint.terms.slice() : [];
  const productGeneric = !product || GENERIC_PRODUCT.test(String(product).trim());
  const effectiveProduct = productGeneric ? null : product;
  // 标签行里的「位置」是类型下拉入口；直接点「输入地理位置」只会打开 POI 搜索面板，
  // 那里没有团购入口（2026-11-10 实跑发现，改成点标签 chip）
  // 标签行的类型下拉是一个 semi-select（文本显示「位置」）。2026-11-14 实跑发现
  // 直接点文字节点打不开菜单，必须按 semi-select 触发器本体点击；菜单项在
  // .semi-select-option 里，选项有 位置 / 团购 / 购物车 / 影视演艺 / 小程序 / 游戏手柄 / 标记万物。
  const trigger = page.locator('.semi-select').filter({ hasText: /^位置$/ }).first();
  if (await trigger.count()) {
    // 必须让 playwright 自己 scrollIntoView 再点：标签行常在视口下方，
    // 手动算坐标 mouse.click 会点到视口外（2026-11-14 踩过，选项一直取不到）
    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(400);
    await trigger.click({ force: true });
  } else {
    const chip = page.getByText('位置', { exact: true }).first();
    if (!(await chip.count())) return { ok: false, reason: 'no-location-chip' };
    await chip.click({ force: true });
  }
  await page.waitForTimeout(1600);

  const tg = page.locator('.semi-select-option').filter({ hasText: /^团购$/, visible: true }).first();
  if (!(await tg.count())) {
    await page.keyboard.press('Escape').catch(() => {});
    return { ok: false, reason: 'no-tuangou-option' };
  }
  await tg.click({ force: true });
  await page.waitForTimeout(2000);

  // 挂不上商品时必须把标签类型退回「位置」，否则团购类型留在那里、位置框消失，
  // 后续 setLocation 也挂不上门店（2026-11-14 踩过：loc=no-location-input）。
  const resetType = async () => {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
    const t2 = page.locator('.semi-select').filter({ hasText: /^(位置|团购)$/ }).first();
    if (!(await t2.count())) return;
    await t2.scrollIntoViewIfNeeded().catch(() => {});
    await t2.click({ force: true });
    await page.waitForTimeout(1200);
    const posOpt = page.locator('.semi-select-option').filter({ hasText: /^位置$/, visible: true }).first();
    if (await posOpt.count()) { await posOpt.click({ force: true }); await page.waitForTimeout(1500); }
  };
  const fail = async (payload) => { await resetType(); return { ok: false, ...payload }; };

  const picker = page.getByText('请选择团购商品', { exact: true }).first();
  if (!(await picker.count())) return fail({ reason: 'no-product-picker' });
  await picker.click({ force: true });
  await page.waitForTimeout(3000);

  const input = page.locator('.semi-select-open input').first();
  if (!(await input.count())) return fail({ reason: 'no-search-input' });

  const readOptions = () => page.evaluate(() => [...document.querySelectorAll('.semi-select-option,[role=option]')]
    .map((el, i) => ({ i, text: (el.innerText || '').trim() }))
    .filter(o => o.text));
  const typeTerm = async (term) => {
    await input.click().catch(() => {});
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.type(term, { delay: 60 });
    await page.waitForTimeout(3200);
    return readOptions();
  };

  // 先用商品词搜（比按品牌搜准得多），搜不到再用品牌/主推词搜
  const firstTerm = effectiveProduct || hintTerms[0] || brand;
  let options = await typeTerm(firstTerm);
  let decision = decideProduct(options, brand, { product: effectiveProduct, hintTerms });
  if (!decision.ok && (effectiveProduct || hintTerms.length) && firstTerm !== brand) {
    const byBrand = await typeTerm(hintTerms[0] || brand);
    if (byBrand.length > options.length) options = byBrand;
    const d2 = decideProduct(options, brand, { product: effectiveProduct, hintTerms });
    if (d2.ok) decision = d2;
  }
  if (!options.length) return fail({ reason: 'no-product-options' });

  // 硬性选品规则（2026-11-11 宝哥定）：视频文案写了什么商品，就只挂那个商品的团购。
  // 一条都不命中就不挂商品（调用方退回只挂门店），绝不为了「有链接」去挂错商品。
  if (!decision.ok) {
    return fail({
      reason: decision.reason,
      candidates: options.length,
      product,
      terms: decision.terms,
      mismatched: decision.rejected.slice(0, 3).map(r => r.title),
    });
  }
  const chosen = decision.best;

  // 商品列表索引跟 DOM 顺序一致，但隐藏项会错位，按文本重新定位
  const chosenLoc = page.locator('.semi-select-option,[role=option]').filter({ hasText: chosen.title }).first();
  if (await chosenLoc.count()) await chosenLoc.click({ force: true });
  else await page.locator('.semi-select-option,[role=option]').nth(chosen.i).click({ force: true });
  await page.waitForTimeout(2500);

  // 点选商品只打开抽屉，还要填「推广标题」+ 点「添加」才算挂上（2026-11-10 实跑）
  const sheet = page.locator('.semi-sidesheet').first();
  const base = { selected: chosen.title, store: chosen.store, price: chosen.price,
    commission_rate: chosen.commission_rate, score: chosen.score, candidates: options.length,
    product_expected: product || null, product_match: chosen.matched_term || null };
  if (!(await sheet.count())) return fail({ reason: 'no-product-sheet', ...base });
  const titleInput = sheet.locator('input.semi-input').first();
  // 推广标题用商品名+规格，不再只写品牌名（2026-11-10 新规：锚点标题应贴近商品本身）
  const promo = promoTitle(chosen, brand);
  if (!(await titleInput.count())) return fail({ reason: 'no-promo-title-input', ...base });
  await titleInput.fill(promo);
  const sameBrand = sheet.getByText('仅推荐同品牌商品', { exact: true }).first();
  if (await sameBrand.count()) await sameBrand.click({ force: true }).catch(() => {});
  await page.waitForTimeout(500);

  const add = sheet.getByText('添加', { exact: true }).first();
  if (!(await add.count())) return fail({ reason: 'no-add-button', ...base });
  await add.click();
  await page.waitForTimeout(3000);

  const pickerGone = (await page.getByText('请选择团购商品', { exact: true }).count()) === 0;
  // 真正的挂载标志：选择区的「请选择团购商品」消失，且没有可见的抽屉遮罩挡住后续操作
  const maskVisible = await page.locator('.semi-sidesheet-mask').evaluateAll(els => els.some(e => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
  })).catch(() => false);
  const applied = pickerGone && !maskVisible;
  if (!applied) return fail({ reason: 'product-not-applied', promo_title: promo, ...base });
  return { ok: true, promo_title: promo, ...base };
}

// 控件的文字标签：优先 label，其次 aria/title，再退回相邻兄弟；
// 父容器仅在只含一个控件时启用，避免把整组选项的文字误当成某一个控件
const CONTROL_TEXT_SRC = `
  const boxText = el => (el && (el.innerText || el.textContent || '').trim()) || '';
  const controlText = inp => {
    const lab = inp.closest && inp.closest('label');
    if (lab) return boxText(lab);
    const aria = [inp.getAttribute('aria-label'), inp.getAttribute('aria-valuetext'), inp.getAttribute('title')]
      .filter(Boolean).join(' ');
    if (aria) return aria;
    const next = boxText(inp.nextElementSibling);
    if (next) return next;
    const prev = boxText(inp.previousElementSibling);
    if (prev) return prev;
    const p = inp.parentElement;
    if (p && p.querySelectorAll('input[type=radio],input[type=checkbox]').length === 1) return boxText(p);
    return '';
  };
`;

// 确认「不同时发布」被选中，并主动取消「同步到今日头条 / 红果短剧」：
// 只认文字关联匹配的 radio，避免误读同组第一个选项；同步项若被默认勾选，先取消再复核
async function ensureNotSimultaneous(page) {
  return page.evaluate(`(() => {
    const text = '不同时发布';
    const OTHER = '同时发布到';
    const SYNC = /(今日头条|红果)/;
    ${CONTROL_TEXT_SRC}

    // 先收集并取消同步平台的 checkbox；点击「不同时发布」后这些选项可能被页面卸载
    const syncChecked = [];
    for (const inp of [...document.querySelectorAll('input[type=checkbox]')]) {
      const ctx = controlText(inp);
      if (!SYNC.test(ctx) || !inp.checked) continue;
      syncChecked.push(ctx.slice(0, 20));
      (inp.closest && inp.closest('label') || inp).click();
    }
    for (const el of [...document.querySelectorAll('[role=checkbox][aria-checked=true]')]) {
      const ctx = boxText(el.closest('label')) || el.getAttribute('aria-label') || boxText(el);
      if (!SYNC.test(ctx)) continue;
      syncChecked.push(ctx.slice(0, 20));
      el.click();
    }

    const nodes = [...document.querySelectorAll('label,div,span')];
    const exact = nodes.filter(e => boxText(e) === text);
    let el = exact[exact.length - 1];
    if (!el) {
      el = nodes.filter(e => boxText(e).includes(text))
        .sort((a, b) => boxText(a).length - boxText(b).length)[0];
    }
    if (!el) return { found: false, selected: null, clicked: false, via: 'missing', syncChecked };

    // 候选控件的文字上下文必须包含「不同时发布」且不能同时包含「同时发布到」；
    // 抖音该组其实是 input[type=checkbox].radio-native，radio 与 checkbox 都要认
    let input = null;
    let node = el;
    for (let i = 0; i < 4 && node && !input; i++, node = node.parentElement) {
      const inputs = [...(node.querySelectorAll ? node.querySelectorAll('input[type=radio],input[type=checkbox]') : [])];
      input = inputs.find(inp => {
        const ctx = controlText(inp);
        return ctx.includes(text) && !ctx.includes(OTHER);
      }) || null;
    }
    if (input) {
      const was = !!input.checked;
      if (!was) (input.closest('label') || input).click();
      return { found: true, selected: !!input.checked, clicked: !was, via: 'input', syncChecked };
    }

    // 自定义单选框：只认文字元素自身/直接父级的选中类名；容器同时含两种选项时按未知处理
    node = el;
    for (let i = 0; i < 2 && node; i++, node = node.parentElement) {
      const t = boxText(node);
      if (t.includes(OTHER) && t.includes(text)) continue;
      if (/checked|selected|active/i.test(String(node.className || ''))) {
        return { found: true, selected: true, clicked: false, via: 'class', syncChecked };
      }
    }
    el.click();
    return { found: true, selected: null, clicked: true, via: 'text', syncChecked };
  })()`);
}

// 预检时独立读实时 DOM：任何仍被勾选的今日头条/红果同步项都算未通过
async function liveSyncChecked(page) {
  return page.evaluate(`(() => {
    const SYNC = /(今日头条|红果)/;
    ${CONTROL_TEXT_SRC}
    const out = [];
    for (const inp of [...document.querySelectorAll('input[type=checkbox]')]) {
      const ctx = controlText(inp);
      if (SYNC.test(ctx) && inp.checked) out.push(ctx.slice(0, 20));
    }
    for (const el of [...document.querySelectorAll('[role=checkbox][aria-checked=true]')]) {
      const ctx = boxText(el.closest('label')) || el.getAttribute('aria-label') || boxText(el);
      if (SYNC.test(ctx)) out.push(ctx.slice(0, 20));
    }
    return out;
  })()`);
}

async function verifyBeforePublish(page, settings = {}) {
  const [body, syncCheckedLive] = await Promise.all([
    page.locator('body').innerText(),
    liveSyncChecked(page),
  ]);
  return {
    aiDeclaration: body.includes('内容由AI生成'),
    // 必须读到明确选中状态，且操作结果与预检时实时 DOM 都没有同步项残留才放行
    notSimultaneous: body.includes('不同时发布') && settings.selected === true
      && (settings.syncChecked || []).length === 0 && syncCheckedLive.length === 0,
    syncCheckedLive,
    publishNow: body.includes('立即发布'),
    coverMissing: body.includes('横/竖双封面缺失') || body.includes('横封面缺失'),
    hasLocation: !body.includes('输入地理位置'),
  };
}

async function publishOne(videoInfo, copy, opts = {}) {
  const dryRun = !!opts.dryRun;
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

    // 先挂团购商品（能带成交），挂不上再退回只挂门店（带曝光）
    let prod = { ok: false, reason: 'skipped' };
    let loc = { ok: false, reason: 'skipped' };
    const locationBrand = videoInfo.locationBrand || videoInfo.brand;
    if (L.CONFIG.publish.attach_product && locationBrand) {
      // 商品名以 meta 为准（人工确认过）；缺 meta 时用文案里的商品名兜底
      const productName = videoInfo.product || (copy && copy.product) || null;
      prod = await setProduct(page, { brand: locationBrand, product: productName });
      log('product ' + JSON.stringify(prod));
      if (!prod.ok && prod.reason === 'product-mismatch') {
        log(`product not attached: 文案商品「${productName}」在列表里没有对应团购，退回只挂门店`);
      }
    }
    if (L.CONFIG.publish.add_location && locationBrand && !prod.ok) {
      loc = await setLocation(page, locationBrand);
      log('location ' + JSON.stringify(loc));
    }

    const decl = await setDeclaration(page);
    log('declaration ' + decl);

    let settings = await ensureNotSimultaneous(page);
    // 读不到选中状态或有同步项刚被取消时再确认一次；仍不满足就按未选中处理，不发布
    if (settings.selected == null || (settings.syncChecked || []).length > 0) {
      await page.waitForTimeout(900);
      settings = await ensureNotSimultaneous(page);
    }
    await page.waitForTimeout(400);
    log('settings ' + JSON.stringify(settings));

    const check = await verifyBeforePublish(page, settings);
    log('precheck ' + JSON.stringify(check));
    // 审核要看整张表单：先滚到顶拍标题/简介/话题区，再拍整页，最后拍当前视口
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(shots, `${stamp}_before_publish_top.png`), fullPage: false });
    await page.screenshot({ path: path.join(shots, `${stamp}_before_publish_full.png`), fullPage: true });
    await page.screenshot({ path: path.join(shots, `${stamp}_before_publish.png`), fullPage: false });

    if (dryRun) {
      return { ok: true, dryRun: true, check, copyInfo, cover, loc, product: prod, declaration: decl, settings };
    }
    if (!check.aiDeclaration) return { ok: false, reason: 'ai-declaration-missing' };
    if (!check.notSimultaneous) return { ok: false, reason: 'not-simultaneous-missing' };
    if (check.coverMissing) return { ok: false, reason: 'cover-missing' };
    // 品牌已确认时必须有定位：团购商品或门店标签，任一个挂上都算（宝哥 2026-11-02/11-10）
    // add_location 关闭时不做此拦截（兼容手动关闭位置标签的配置）
    if (L.CONFIG.publish.add_location && locationBrand && !prod.ok && !loc.ok && !check.hasLocation) {
      return { ok: false, reason: 'location-missing', loc, product: prod, check, copyInfo, cover, declaration: decl, settings };
    }

    // 点击底部「发布」。标志位先置位：点击一旦发起，后续任何异常都可能意味着已发布
    clickedPublish = true;
    const publishBtn = page.locator('button', { hasText: /^发布$/ }).last();
    await publishBtn.click({ force: true });

    // 等待发布结果
    let success = false;
    const resultTries = Math.max(1, Math.ceil(PUBLISH_RESULT_TIMEOUT_MS / 2000));
    for (let i = 0; i < resultTries; i++) {
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
    if (idx < 0) return { ok: true, workId: idMatches[0] || null, status: 'unknown', check, loc, product: prod, verify_note: 'title-not-found' };
    if (status === '审核不通过') return { ok: false, reason: 'verify-failed', status, loc, product: prod };
    return { ok: true, workId: idMatches[0] || null, status: status || 'unknown', check, loc, product: prod };
  } catch (e) {
    log('ERROR ' + e.message);
    await page.screenshot({ path: path.join(shots, `${stamp}_error.png`) }).catch(() => {});
    return { ok: false, reason: 'error', error: e.message, clickedPublish };
  } finally {
    // 关闭浏览器失败不能覆盖上面已经确定的发布结果
    await browser.close().catch(e => log('browser close failed: ' + e.message));
  }
}

module.exports = { publishOne, ensureNotSimultaneous, verifyBeforePublish, clickByTextIn, waitUploadComplete, fillCopy, setCovers, setLocation, setProduct, setDeclaration, liveSyncChecked, brandKeywords };

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

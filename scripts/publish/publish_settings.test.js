// 发布设置回归：必须选中「不同时发布」，且同步到今日头条/红果短剧不能被勾选。
// 用本地 HTML 复现发布页的单选/复选结构，不访问抖音、不读真实素材。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { chromium } = require('playwright');
const { ensureNotSimultaneous, verifyBeforePublish } = require('./publish_one');

const CHROMIUM = 'C:/Users/20200/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe';

const ROW = `
  <div class="publish-settings">
    <span>同时发布</span>
    <label><input id="no" type="radio" name="simul">不同时发布</label>
    <label><input id="yes" type="radio" name="simul" checked>同时发布到</label>
    <div class="platforms">
      <label><input id="toutiao" type="checkbox" checked>同步到今日头条</label>
      <label><input id="hongguo" type="checkbox" checked>同步到红果短剧</label>
    </div>
  </div>`;

const ROW_OK = ROW
  .replace('id="no" type="radio" name="simul"', 'id="no" type="radio" name="simul" checked')
  .replace('id="yes" type="radio" name="simul" checked', 'id="yes" type="radio" name="simul"')
  .replace('id="toutiao" type="checkbox" checked', 'id="toutiao" type="checkbox"')
  .replace('id="hongguo" type="checkbox" checked', 'id="hongguo" type="checkbox"');

// 同步项文字只存在于 aria-label，没有 label 包裹
const ROW_ARIA = `
  <div>
    <label><input id="no" type="radio" name="simul" checked>不同时发布</label>
    <label><input id="yes" type="radio" name="simul">同时发布到</label>
    <input id="toutiao" type="checkbox" checked aria-label="同步到今日头条">
  </div>`;

// 无关 checkbox 与同步文字同处一个无 label 容器：不能误取消无关项
const ROW_SHARED = `
  <div>
    <label><input id="no" type="radio" name="simul" checked>不同时发布</label>
    <label><input id="yes" type="radio" name="simul">同时发布到</label>
    <div id="group">
      <input id="unrelated" type="checkbox" checked><span>允许下载</span>
      <span>同步到今日头条</span>
    </div>
  </div>`;

// 兄弟节点式单选组：input 与文字是兄弟，首项「同时发布到」默认选中
const ROW_SIBLING = `
  <div>
    <input id="yes" type="radio" name="simul" checked><span>同时发布到</span>
    <input id="no" type="radio" name="simul"><span>不同时发布</span>
  </div>`;

// 抖音真实结构：单选组用 input[type=checkbox].radio-native + label，JS 互斥
const ROW_REAL = `
  <div class="publish-settings">
    <span>同时发布</span>
    <div class="radio-group">
      <label class="radio-item"><input id="no" class="radio-native" type="checkbox" value="0">不同时发布</label>
      <label class="radio-item"><input id="yes" class="radio-native" type="checkbox" value="1" checked>同时发布到</label>
    </div>
  </div>
  <script>
    document.querySelectorAll('.radio-native').forEach(inp => inp.addEventListener('change', () => {
      if (!inp.checked) return;
      document.querySelectorAll('.radio-native').forEach(o => { if (o !== inp) o.checked = false; });
    }));
  </script>`;

async function withPage(html, fn) {
  const opts = { headless: true };
  if (fs.existsSync(CHROMIUM)) opts.executablePath = CHROMIUM;
  const browser = await chromium.launch(opts);
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    return await fn(page);
  } finally {
    await browser.close();
  }
}

// 与 publish_one.js 相同的两次确认策略
async function confirmTwice(page) {
  let settings = await ensureNotSimultaneous(page);
  if (settings.selected == null || (settings.syncChecked || []).length > 0) {
    await page.waitForTimeout(80);
    settings = await ensureNotSimultaneous(page);
  }
  return settings;
}

function box(page, id) {
  return page.evaluate(id => !!document.querySelector('#' + id).checked, id);
}

test('默认选中「同时发布到」且同步平台已勾选：改为不同时发布并取消同步', async () => {
  await withPage(ROW, async page => {
    const settings = await confirmTwice(page);
    assert.equal(settings.found, true);
    assert.equal(settings.selected, true);
    assert.deepEqual(settings.syncChecked, []);
    assert.equal(await box(page, 'no'), true);
    assert.equal(await box(page, 'yes'), false);
    assert.equal(await box(page, 'toutiao'), false);
    assert.equal(await box(page, 'hongguo'), false);
    assert.equal((await verifyBeforePublish(page, settings)).notSimultaneous, true);
  });
});

test('已经是「不同时发布」且未同步：不改动、预检通过', async () => {
  await withPage(ROW_OK, async page => {
    const settings = await ensureNotSimultaneous(page);
    assert.equal(settings.selected, true);
    assert.equal(settings.clicked, false);
    assert.deepEqual(settings.syncChecked, []);
    assert.equal((await verifyBeforePublish(page, settings)).notSimultaneous, true);
  });
});

test('同步项只写在 aria-label 也能识别并取消', async () => {
  await withPage(ROW_ARIA, async page => {
    const settings = await confirmTwice(page);
    assert.equal(settings.selected, true);
    assert.deepEqual(settings.syncChecked, []);
    assert.equal(await box(page, 'toutiao'), false);
    assert.equal((await verifyBeforePublish(page, settings)).notSimultaneous, true);
  });
});

test('无关 checkbox 与同步文字同容器：不误取消无关项', async () => {
  await withPage(ROW_SHARED, async page => {
    const settings = await confirmTwice(page);
    assert.equal(settings.selected, true);
    assert.deepEqual(settings.syncChecked, []);
    assert.equal(await box(page, 'unrelated'), true);
    assert.equal((await verifyBeforePublish(page, settings)).notSimultaneous, true);
  });
});

test('抖音真实结构（checkbox.radio-native）：能读到并选中「不同时发布」', async () => {
  await withPage(ROW_REAL, async page => {
    const settings = await confirmTwice(page);
    assert.equal(settings.found, true);
    assert.equal(settings.selected, true);
    assert.equal(settings.via, 'input');
    assert.equal(await box(page, 'no'), true);
    assert.equal(await box(page, 'yes'), false);
    assert.equal((await verifyBeforePublish(page, settings)).notSimultaneous, true);
  });
});

test('兄弟节点式单选组：按文字关联选中「不同时发布」，不误读同组首项', async () => {
  await withPage(ROW_SIBLING, async page => {
    const settings = await confirmTwice(page);
    assert.equal(settings.selected, true);
    assert.equal(await box(page, 'no'), true);
    assert.equal(await box(page, 'yes'), false);
    assert.equal((await verifyBeforePublish(page, settings)).notSimultaneous, true);
  });
});

test('操作结果称已取消，但实时 DOM 仍有同步项：预检拒绝发布', async () => {
  await withPage(ROW_ARIA, async page => {
    const check = await verifyBeforePublish(page, { selected: true, syncChecked: [] });
    assert.deepEqual(check.syncCheckedLive, ['同步到今日头条']);
    assert.equal(check.notSimultaneous, false);
  });
});

test('预检读到设置里仍有同步项时拒绝发布（fail-closed）', async () => {
  await withPage(ROW_OK, async page => {
    const check = await verifyBeforePublish(page, { selected: true, syncChecked: ['同步到今日头条'] });
    assert.equal(check.notSimultaneous, false);
  });
});

test('页面读不到「不同时发布」：不伪造选中状态', async () => {
  await withPage('<div><label><input type="radio" checked>同时发布到</label></div>', async page => {
    const settings = await ensureNotSimultaneous(page);
    assert.equal(settings.found, false);
    assert.equal(settings.selected, null);
    assert.equal((await verifyBeforePublish(page, settings)).notSimultaneous, false);
  });
});

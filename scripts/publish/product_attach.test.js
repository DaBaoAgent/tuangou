// 团购商品挂载回归：用本地 HTML 复现发布页「位置 chip → 团购 → 请选择团购商品」的层级。
// 关键点：入口必须是标签行里的「位置」，点「输入地理位置」只会打开 POI 搜索、没有团购入口。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { chromium } = require('playwright');
const { setProduct } = require('./publish_one');

const CHROMIUM = require('./lib').chromiumPath();

const CARD_POOL = [
  {
    title: '【2斤肉】火锅随心选自由涮6人餐',
    store: '锅圈食汇火锅烧烤食材超市(迎春路店)',
    price: '89',
    commission_rate: '2%',
  },
  {
    // 真实页面上的商品卡写法（2026-11-10 实跑）：营销括号 + 品类前缀 + 商品名+规格
    title: '【专属特惠】熟食·冬菇马蹄云饺2选1',
    store: '袁记云饺(万科店)',
    price: '15.9',
    commission_rate: '3%',
  },
  {
    title: '招牌锅贴10只1份',
    store: '袁记小笼锅贴',
    price: '9.9',
    commission_rate: '0%',
  },
];

function cardText(c) {
  return `${c.title}\n${c.store}\n等35252店通用\n￥${c.price}\n赚￥ 0 .48 佣金率${c.commission_rate}`;
}

// 真实页面里每行是独立元素，innerText 才带换行；直接写裸换行会被 HTML 折成空格
function cardHtmlOf(c) {
  return cardText(c).split('\n').map(l => `<div class="ln">${l}</div>`).join('');
}

// 结构与抖音发布页一致：标签行在正文，类型下拉和商品面板挂在 body 末尾的弹层里
function pageHtml(cards) {
  const cardHtml = cards.map(c => `<div class="semi-select-option">${cardHtmlOf(c)}</div>`).join('');
  return `<!doctype html><meta charset="utf-8">
  <div id="tags"><span class="chip">位置</span><span class="chip">带货模式</span></div>
  <div id="location-input">输入地理位置</div>
  <div id="poi-panel" style="display:none">本地 国内 国际 七里山塘景区</div>
  <div id="row"></div>
  <div id="dropdown" style="display:none">
    <div class="dd-item">位置</div>
    <div class="dd-item" id="dd-tuangou">团购</div>
    <div class="dd-item">购物车</div>
  </div>
  <div id="picker" style="display:none">
    <div class="semi-select-open"><input></div>
    <div id="options">${cardHtml}</div>
  </div>
  <div id="sheet-mask" class="semi-sidesheet-mask" style="display:none"></div>
  <div id="sheet" class="semi-sidesheet" style="display:none">
    <div>推广标题</div><input class="semi-input" placeholder="如：袁记红油云吞全家福">
    <div>智能推荐相关商品</div>
    <div class="switchOptionItemWrapper"><div class="title">仅推荐同品牌商品</div></div>
    <div class="switchOptionItemWrapper"><div class="title">可推荐其他品牌的商品</div></div>
    <div id="add-btn">添加</div>
  </div>
  <script>
    document.querySelector('.chip').addEventListener('click', () => {
      document.getElementById('dropdown').style.display = 'block';
    });
    // 旧实现的入口：点这里只会打开 POI 面板，不出现团购
    document.getElementById('location-input').addEventListener('click', () => {
      document.getElementById('poi-panel').style.display = 'block';
    });
    document.getElementById('dd-tuangou').addEventListener('click', () => {
      document.getElementById('dropdown').style.display = 'none';
      document.getElementById('row').innerHTML = '<span>团购</span><span>全国</span><span id="pick">请选择团购商品</span>';
      document.getElementById('pick').addEventListener('click', () => {
        document.getElementById('picker').style.display = 'block';
        document.querySelector('.semi-select-open input').focus();
      });
    });
    const allCards = ${JSON.stringify(cards)};
    const ln = s => '<div class="ln">' + s + '</div>';
    const render = list => {
      document.getElementById('options').innerHTML = list.map(c =>
        '<div class="semi-select-option">' + ln(c.title) + ln(c.store) + ln('等35252店通用')
        + ln('￥' + c.price) + ln('赚￥ 0 .48 佣金率' + c.commission_rate) + '</div>').join('');
    };
    const input = document.querySelector('.semi-select-open input');
    input.addEventListener('input', () => {
      const q = input.value.trim();
      render(allCards.filter(c => !q || (c.title + c.store).includes(q)));
    });
    document.getElementById('options').addEventListener('click', e => {
      const opt = e.target.closest('.semi-select-option');
      if (!opt) return;
      // 真实页面：点商品只开抽屉，行里仍是「请选择团购商品」，要点「添加」才生效
      document.getElementById('picker').style.display = 'none';
      document.getElementById('sheet-mask').style.display = 'block';
      document.getElementById('sheet').style.display = 'block';
    });
    document.getElementById('add-btn').addEventListener('click', () => {
      const promo = document.querySelector('#sheet input.semi-input').value.trim();
      if (!promo) return;
      document.getElementById('sheet-mask').style.display = 'none';
      document.getElementById('sheet').style.display = 'none';
      document.getElementById('row').innerHTML = '<span>团购</span><span>全国</span><span>' + promo + '</span>';
    });
  </script>`;
}

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

test('从标签行「位置」进入团购并挂上品牌匹配的商品', async () => {
  await withPage(pageHtml(CARD_POOL), async page => {
    const r = await setProduct(page, { brand: '袁记云饺', product: '袁记云饺' });
    assert.equal(r.ok, true);
    assert.match(r.selected, /冬菇马蹄云饺/);
    assert.equal(r.store, '袁记云饺(万科店)');
    assert.equal(r.commission_rate, 3);
    // 推广标题用商品名+规格，不是光秃秃的品牌名
    assert.equal(r.promo_title, '冬菇马蹄云饺2选1');
    // 抽屉点「添加」后，行里应显示推广标题，且不再有「请选择团购商品」
    const picked = await page.locator('#row').innerText();
    assert.match(picked, /冬菇马蹄云饺2选1/);
    assert.equal(await page.getByText('请选择团购商品', { exact: true }).count(), 0);
  });
});

test('弹层里没有品牌匹配的商品：不挂载，返回失败原因', async () => {
  await withPage(pageHtml(CARD_POOL.filter(c => !c.store.includes('袁记'))), async page => {
    const r = await setProduct(page, { brand: '袁记云饺' });
    assert.equal(r.ok, false);
    assert.ok(['no-product-options', 'no-matching-product'].includes(r.reason));
    const row = await page.locator('#row').innerText();
    assert.doesNotMatch(row, /袁记/);
  });
});

test('输入品牌只保留匹配项，且优先选有佣金的商品', async () => {
  await withPage(pageHtml(CARD_POOL), async page => {
    const r = await setProduct(page, { brand: '袁记云饺' });
    assert.equal(r.ok, true);
    assert.equal(r.candidates, 1);
    assert.equal(r.commission_rate > 0, true);
  });
});

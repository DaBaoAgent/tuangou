const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./lib');

test('排期：第 1–4 天为 2/4/6/8，时间窗内且相邻间隔 ≥25 分钟', () => {
  for (let d = 0; d < 4; d++) {
    const ds = L.todayStr(new Date(2026, 10, 1 + d));
    const count = L.targetCount(ds);
    assert.equal(count, [2, 4, 6, 8][d]);
    const mins = L.buildTimes(ds, count).map(L.minutesOf);
    assert.equal(mins.length, count);
    assert.ok(mins.every(m => m >= L.minutesOf('09:00') && m <= L.minutesOf('22:30')));
    for (let i = 1; i < mins.length; i++) assert.ok(mins[i] - mins[i - 1] >= 25);
  }
});

test('排期：同一天可复现', () => {
  assert.deepEqual(L.buildTimes('2026-11-10', 10), L.buildTimes('2026-11-10', 10));
});

test('文案：片尾口播、纯英文、口吃重复不进描述', () => {
  const v = {
    file: 'junk.mp4', brand: '爷爷不泡茶', category: '茶饮',
    lines: ['这一口太上头', '请不吝点赞订阅转发打赏支持明镜与点点栏目', 'anas', '一次一次吃到'],
  };
  const c = L.buildCopy(v, { used_title_suffix: [] });
  assert.ok(!c.desc.includes('点赞'));
  assert.ok(!c.desc.includes('anas'));
  assert.ok(!c.desc.includes('一次一次'));
});

test('文案：乱码黑名单整条不通过', () => {
  assert.equal(L.copyClean({ title: '鸡腿肉脆嫩多汁，看饿了没？', desc: '秋季狂欢特大粪这一份。' }), false);
  assert.equal(L.copyClean({ title: '鸡腿肉脆嫩多汁，看饿了没？', desc: '外皮酥脆。' }), true);
});

test('文案：单句素材的描述不复述标题', () => {
  const v = { file: 'single.mp4', brand: '临榆炸鸡腿', category: '炸鸡', lines: ['外皮酥脆到掉渣'] };
  const c = L.buildCopy(v, { used_title_suffix: [] });
  assert.ok(c.title.includes('外皮酥脆到掉渣'));
  assert.ok(!c.desc.includes(c.hook));
});

test('文案：标题 ≤30 字、描述 ≤1000 字、话题 3–5 且不重复', () => {
  const v = { file: 'len.mp4', brand: null, category: null, lines: ['今天必须给你们安利这个', '外皮炸的酥酥脆脆'] };
  const c = L.buildCopy(v, { used_title_suffix: [] });
  assert.ok(c.title.length <= L.CONFIG.copy.max_title);
  assert.ok(c.desc.length <= L.CONFIG.copy.max_desc);
  assert.ok(c.topics.length >= L.CONFIG.copy.topics_min && c.topics.length <= L.CONFIG.copy.topics_max);
  assert.equal(new Set(c.topics).size, c.topics.length);
});

test('文案：ASR 同音错字不落到标题和描述', () => {
  const v = {
    file: 'g1.mp4', brand: '麦当劳', category: '汉堡炸鸡',
    lines: ['听我一句劝这个真的别错过', '我吃到第一烤就知道', '必须豚', '外皮咔嚓脆', '鸡腿肉',
      '还特别嫩', '香辣过瘾', '现在买一送衣', '寿库存有限看到就先豚上'],
  };
  const c = L.buildCopy(v, { used_title_suffix: [] });
  const text = `${c.title}\n${c.desc}`;
  assert.ok(!/豚|买一送衣|第一烤|寿库存/.test(text), text);
  assert.ok(text.includes('第一口') || text.includes('买一送一'));
});

test('文案：片尾寒暄与低俗 ASR 不进描述', () => {
  const v = {
    file: 'g2.mp4', brand: '瑞幸咖啡', category: '咖啡',
    lines: ['这杯我真的盼了好久', '黄油坚果香直接拉满', '完全不苦又的满子', '完全不苦不色',
      '超丝滑', '早吧下午茶', '都超合适', '好久不见', '感谢观看'],
  };
  const c = L.buildCopy(v, { used_title_suffix: [] });
  const text = `${c.title}\n${c.desc}`;
  assert.ok(!/感谢观看|好久不见|又的满子|早吧/.test(text), text);
  assert.ok(text.includes('早八'));
  assert.ok(!/不苦不涩.*不苦不涩/.test(c.desc));
});

test('文案：严重乱码句整句丢弃，标题用 meta 商品名兜底', () => {
  const v = {
    file: 'g3.mp4', brand: null, category: null, product: '海鲜大咖蛙蛙煲',
    lines: ['海鲜大叉娃娃宝来来啦', '满满一锅海鹿鲜约朋友', '超适合朋友', '现在还有团购优惠',
      '聚餐离似', '三支甲', '三支甲', '聚餐离优惠'],
  };
  const c = L.buildCopy(v, { used_title_suffix: [] });
  const text = `${c.title}\n${c.desc}`;
  assert.ok(!/娃娃宝|海鹿|离似|三支甲/.test(text), text);
  assert.ok(c.topics.some(t => t.includes('海鲜大咖蛙蛙煲')), JSON.stringify(c.topics));
});

test('文案：低俗错字「粉紫便便」不会出现', () => {
  const v = {
    file: 'g4.mp4', brand: '瑞幸咖啡', category: '咖啡', product: '莓果酸奶饮',
    lines: ['莓果酸奶饮杯底果粒给的很明显', '粉紫便便', '看着就很清爽', '西一口', '喜欢酸甜口感的可以试试这杯'],
  };
  const c = L.buildCopy(v, { used_title_suffix: [] });
  const text = `${c.title}\n${c.desc}`;
  assert.ok(!/便便/.test(text), text);
  assert.ok(text.includes('粉紫渐变'));
  assert.ok(text.includes('吸一口'));
});

test('文案：重复片段去重，话题去掉括号空格', () => {
  const v = {
    file: 'g5.mp4', brand: null, category: null, product: '炸物三合一（鸡柳+薯条+年糕）',
    lines: ['爷爷不泡茶的荔枝冰', '荔枝冰酿', '现在还有买一赠一福利', '赶紧囤起来呀'],
  };
  const c = L.buildCopy(v, { used_title_suffix: [] });
  assert.ok(!c.desc.includes('荔枝冰，荔枝冰酿'), c.desc);
  assert.ok(c.topics.every(t => !/[（）()\s+]/.test(t)), JSON.stringify(c.topics));

  // 同一句里重复的片段也要合并
  const one = L.buildCopy({ file: 'g6.mp4', brand: '爷爷不泡茶', category: '茶饮', lines: ['爷爷不泡茶的荔枝冰，荔枝冰酿'] }, { used_title_suffix: [] });
  assert.ok(!one.desc.includes('荔枝冰，荔枝冰酿'), one.desc);
  assert.ok(!one.title.includes('荔枝冰，荔枝冰酿'), one.title);
});

test('文案：断句碎片与半截标题会被丢弃', () => {
  const v = {
    file: 'g7.mp4', brand: null, category: null,
    lines: ['我发现', '了超好吃的东西', '的快乐谁能拒绝啊', '外酥里嫩', '咬一口直接爆汁',
      '每一口都香到骨', '子里根本停不下来'],
  };
  const c = L.buildCopy(v, { used_title_suffix: [] });
  const text = `${c.title}\n${c.desc}`;
  assert.ok(!/，了|，的/.test(text), text);
  assert.ok(!text.includes('的快乐谁能拒绝'), text);
  assert.equal(L.copyClean(c), true);

  const bad = { title: '量真的有点狠现在戳链，你顶得住吗？', desc: '...，手慢真的无。' };
  assert.equal(L.copyClean(bad), false);
});

test('文案：跨句断词与重复字修正', () => {
  const v = {
    file: 'g8.mp4', brand: null, category: null,
    lines: ['等了好久的那杯终于', '回来了就是它小黄油', '上面是清爽冰', '咖啡分层看得', '见奶香裹着咖啡香一口很顺',
      '早八，下午茶都超合合适'],
  };
  const c = L.buildCopy(v, { used_title_suffix: [] });
  const text = `${c.title}\n${c.desc}`;
  assert.ok(!/看得，见|合合适/.test(text), text);
  assert.ok(text.includes('看得见'), text);
  assert.ok(!c.title.startsWith('回来了'), c.title);
});

test('文案：语气碎片不当标题，商品名兜底', () => {
  const v = {
    file: 'g9.mp4', brand: null, category: null, product: '炸物三合一（鸡柳+薯条+年糕）',
    lines: ['拿捏了谁能拒绝这', '别划走', '年糕三合一脆的软的全都有'],
  };
  const c = L.buildCopy(v, { used_title_suffix: [] });
  assert.ok(!c.title.startsWith('拿捏了'), c.title);
  assert.ok(c.title.length >= 5 && c.title.length <= L.CONFIG.copy.max_title, c.title);
});

test('文案：低俗词、控制字符、换行与纯标点标题一律不通过', () => {
  const desc = '外皮酥脆。';
  assert.equal(L.copyClean({ title: '我操这个真香，你顶得住吗？', desc }), false);
  assert.equal(L.copyClean({ title: '尼玛这也太香了，谁懂这一口？', desc }), false);
  assert.equal(L.copyClean({ title: '香到拉屎的鸡腿，看饿了没？', desc }), false);
  assert.equal(L.copyClean({ title: '鸡腿香\n脆，你顶得住吗？', desc }), false);
  assert.equal(L.copyClean({ title: '！？！！，。？', desc }), false);
  assert.equal(L.copyClean({ title: '鸡腿香\u0000脆，看饿了没？', desc }), false);
  assert.equal(L.copyClean({ title: '外皮酥脆到掉渣，你顶得住吗？', desc }), true);
});

test('排期：压缩窗口放不下时宁可少发，也不重复同一分钟', () => {
  // 只剩 20 分钟却要 5 条：25 分钟间隔下最多只能放 1 条
  const tight = L.buildTimes('2026-11-10', 5, L.minutesOf('22:10'), L.minutesOf('22:30'));
  const mins = tight.map(L.minutesOf);
  assert.equal(new Set(mins).size, mins.length, tight.join(','));
  assert.ok(mins.every(m => m >= L.minutesOf('22:10') && m <= L.minutesOf('22:30')));
  assert.equal(mins.length, 1);

  // 120 分钟要 10 条：只能放 5 条，且相邻仍 ≥25 分钟
  const mid = L.buildTimes('2026-11-10', 10, L.minutesOf('10:00'), L.minutesOf('12:00')).map(L.minutesOf);
  assert.equal(mid.length, 5);
  for (let i = 1; i < mid.length; i++) assert.ok(mid[i] - mid[i - 1] >= 25);
});

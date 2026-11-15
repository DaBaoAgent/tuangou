const test = require('node:test');
const assert = require('node:assert/strict');
const { parseProductCard, pickBestProduct, decideProduct, productTerms, promoTitle } = require('./product_pick');

const CARD = (name, store, price, rate, earn = 0) =>
  `${name}\n${store}\n等100店通用\n￥${price}\n赚￥ ${earn} 佣金率${rate}%`;

test('parseProductCard：拆出商品名/门店/价格/佣金', () => {
  const c = parseProductCard(CARD('【爆款】王牌10选1', '瑞幸咖啡(测试店)', '11.5', '3'));
  assert.equal(c.title, '【爆款】王牌10选1');
  assert.equal(c.store, '瑞幸咖啡(测试店)');
  assert.equal(c.price, 11.5);
  assert.equal(c.commission_rate, 3);
  assert.equal(parseProductCard(''), null);
});

test('pickBestProduct：品牌对不上的不选，返回 null', () => {
  const cards = [
    { i: 0, text: CARD('火锅6人餐', '锅圈食汇(店)', '89', '2') },
    { i: 1, text: CARD('进店顾客瑞幸咖啡', '茚私人影院', '9', '0') },
  ];
  assert.equal(pickBestProduct(cards, '瑞幸咖啡'), null);
});

test('pickBestProduct：排除影院等非餐饮，优先价格带内的爆款', () => {
  const cards = [
    { i: 0, text: CARD('进店顾客瑞幸咖啡', '茚私人影院', '9', '0') },
    { i: 1, text: CARD('【粉丝群专属】瑞门10选1', '瑞幸咖啡(店)', '20', '0') },
    { i: 2, text: CARD('【爆款必囤】王牌10选1含生椰', '瑞幸咖啡(店)', '11.5', '3', 0.35) },
    { i: 3, text: CARD('【双11】20选1十次卡', '瑞幸咖啡(店)', '115', '3') },
  ];
  const best = pickBestProduct(cards, '瑞幸咖啡');
  assert.equal(best.i, 2);
  assert.equal(best.price, 11.5);
  assert.ok(best.why.includes('store'));
});

test('pickBestProduct：0 佣金的爆款优先于高佣金普通款（目标看出单/等级，不看佣金）', () => {
  const cards = [
    { i: 0, text: CARD('【粉丝群专属】瑞门10选1', '瑞幸咖啡(店)', '20', '5') },
    { i: 1, text: CARD('【爆款必囤】瑞门10选1', '瑞幸咖啡(店)', '11.5', '0') },
  ];
  const best = pickBestProduct(cards, '瑞幸咖啡');
  assert.equal(best.i, 1);
  assert.equal(best.commission_rate, 0);
});

test('pickBestProduct：商品名命中时加分，且不选次卡', () => {
  const cards = [
    { i: 0, text: CARD('【超值】十次卡', '品牌A(店)', '100', '5') },
    { i: 1, text: CARD('【招牌】鸡腿汉堡套餐', '品牌A(店)', '25', '3') },
  ];
  const best = pickBestProduct(cards, '品牌A', { product: '鸡腿汉堡' });
  assert.equal(best.i, 1);
});

test('硬性规则：商品名命中优先于更火的爆款/更低价格', () => {
  const cards = [
    { i: 0, text: CARD('【爆款必囤】生椰拿铁10选1', '瑞幸咖啡(店)', '9.9', '3') },
    { i: 1, text: CARD('【新品】莓果酸奶饮', '瑞幸咖啡(店)', '15.9', '1') },
  ];
  const d = decideProduct(cards, '瑞幸咖啡', { product: '莓果酸奶饮' });
  assert.equal(d.ok, true);
  assert.equal(d.best.i, 1);
  assert.equal(d.best.matched_term, '莓果酸奶饮');
  assert.ok(d.best.why.includes('productMatch'));
});

test('硬性规则：文案商品在列表里没有对应团购时，不挂商品（不挂错）', () => {
  const cards = [
    { i: 0, text: CARD('【爆款必囤】生椰拿铁10选1', '瑞幸咖啡(店)', '9.9', '3') },
    { i: 1, text: CARD('【粉丝群专属】瑞门10选1', '瑞幸咖啡(店)', '20', '0') },
  ];
  assert.equal(pickBestProduct(cards, '瑞幸咖啡', { product: '莓果酸奶饮' }), null);
  const d = decideProduct(cards, '瑞幸咖啡', { product: '莓果酸奶饮' });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'product-mismatch');
  assert.deepEqual(d.terms, ['莓果酸奶饮']);
  assert.equal(d.rejected.length, 2);
});

test('硬性规则：商品名等于品牌名或为泛词时视为未指定，退回品牌级挑选', () => {
  const cards = [
    { i: 0, text: CARD('【爆款】生椰拿铁10选1', '袁记云饺(店)', '9.9', '3') },
  ];
  assert.equal(pickBestProduct(cards, '袁记云饺', { product: '袁记云饺' }).i, 0);
  assert.equal(pickBestProduct(cards, '袁记云饺', { product: '套餐' }).i, 0);
  assert.deepEqual(productTerms('袁记云饺', '袁记云饺'), []);
  assert.deepEqual(productTerms('套餐', '袁记云饺'), []);
  // 「品牌+泛词/规格」同样算没指定具体商品，不能因此触发 product-mismatch 把整条商品拦掉
  assert.deepEqual(productTerms('袁记云饺套餐', '袁记云饺'), []);
  assert.deepEqual(productTerms('瑞幸咖啡双杯', '瑞幸咖啡'), []);
  assert.deepEqual(decideProduct(cards, '袁记云饺', { product: '袁记云饺' }).terms, []);
});

test('硬性规则：卡片营销括号/规格与商品名规格都能归一化命中', () => {
  const cards = [
    { i: 0, text: CARD('【爆款】生椰拿铁10选1', '袁记云饺(店)', '9.9', '3') },
    { i: 1, text: CARD('【专属特惠】熟食·冬菇马蹄云饺（2选1）', '袁记云饺(店)', '12.8', '3') },
  ];
  const d = decideProduct(cards, '袁记云饺', { product: '【招牌】冬菇马蹄云饺' });
  assert.equal(d.ok, true);
  assert.equal(d.best.i, 1);
  // 商品名带品牌前缀时也能对上
  const d2 = decideProduct(cards, '袁记云饺', { product: '袁记云饺冬菇马蹄云饺' });
  assert.equal(d2.ok, true);
  assert.equal(d2.best.i, 1);
});

test('promoTitle：去掉营销括号和泛品类前缀，保留商品名+规格', () => {
  assert.equal(
    promoTitle({ title: '【专属特惠】熟食·冬菇马蹄云饺2选1' }, '袁记云饺'),
    '冬菇马蹄云饺2选1'
  );
  assert.equal(promoTitle({ title: '【粉丝群专属】瑞门10选1' }, '瑞幸咖啡'), '瑞门10选1');
});

test('promoTitle：去掉价格、超长截到 10 字、空标题退回品牌名', () => {
  assert.equal(promoTitle({ title: '【爆款】王牌10选1 ￥11.5' }, '瑞幸咖啡'), '王牌10选1');
  const long = promoTitle({ title: '冬菇马蹄鲜肉饺拼玉米鲜肉饺到手15颗' }, '袁记云饺');
  assert.ok(long.length <= 10);
  assert.equal(promoTitle({ title: '' }, '袁记云饺'), '袁记云饺');
  assert.equal(promoTitle({ title: '【限时】' }, '袁记云饺'), '袁记云饺');
});

// 2026-11-15（宝哥要求）：品牌有固定主推单品时（好想来 → 99 买 100 代金券），
// 文案没指定商品也必须命中主推词，命中不了宁可不挂商品。
test('品牌主推词：好想来未指定商品时只认代金券，不挂单支茶饮', () => {
  const cards = [
    { i: 0, text: CARD('【暖冬赏味季】好想来超值月光白茶525ml*3', '好想来品牌零食(桃源镇一店)', '6.6', '0') },
    { i: 1, text: CARD('【限时】好想来 99买100元代金券 全场通用', '好想来品牌零食(桃源镇一店)', '99', '0') },
  ];
  const d = decideProduct(cards, '好想来', { product: '零食', hintTerms: ['代金券', '99买100', '100元代金券'] });
  assert.equal(d.ok, true);
  assert.equal(d.best.i, 1);
  assert.match(d.best.matched_term, /代金券|99买100/);
});

test('品牌主推词：没有代金券卡片时返回 brand-hint-miss，不退回随便挑', () => {
  const cards = [
    { i: 0, text: CARD('【暖冬赏味季】好想来超值月光白茶525ml*3', '好想来品牌零食(桃源镇一店)', '6.6', '0') },
  ];
  const d = decideProduct(cards, '好想来', { product: '零食', hintTerms: ['代金券', '99买100'] });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'brand-hint-miss');
});
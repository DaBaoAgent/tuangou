const test = require('node:test');
const assert = require('node:assert/strict');
const { parseProductCard, pickBestProduct, promoTitle } = require('./product_pick');

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

// 团购商品挑选：从抖音发布页「请选择团购商品」列表里挑一个最可能带来成交的商品。
// 只做确定性规则，不猜：品牌对不上的一律不选。

const DEFAULT_EXCLUDE = ['私人影院', '影院', '影城', '足浴', '按摩', '洗浴', 'KTV', '酒吧'];
const GOOD_WORDS = ['爆款', '必囤', '畅销', '超值', '特惠', '秒杀', '买一送一', '买一赠一', '套餐', '新品', '招牌', '人气', '团购'];
const CARD_RE = /次卡|月卡|季卡|年卡|充值|储值/;

function parseProductCard(text) {
  const lines = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (!lines.length) return null;
  const joined = lines.join(' ');
  const priceM = joined.match(/￥\s*([\d.]+)\s*(?:\/\s*(\d+)\s*次)?/);
  const rateM = joined.match(/佣金率\s*([\d.]+)\s*%/);
  const earnM = joined.match(/赚￥\s*([\d.]+)/);
  return {
    title: lines[0],
    store: lines[1] && !/^￥/.test(lines[1]) ? lines[1] : '',
    price: priceM ? Number(priceM[1]) : null,
    times: priceM && priceM[2] ? Number(priceM[2]) : null,
    commission_rate: rateM ? Number(rateM[1]) : null,
    commission: earnM ? Number(earnM[1]) : null,
    raw: joined,
  };
}

// cards: [{i, text}]；返回 {i, ...card, score, why} 或 null
function pickBestProduct(cards, brand, opts = {}) {
  const exclude = opts.exclude || DEFAULT_EXCLUDE;
  const name = String(brand || '').trim();
  if (!name) return null;
  let best = null;
  for (const c of cards || []) {
    const card = parseProductCard(c.text);
    if (!card) continue;
    if (exclude.some(w => card.raw.includes(w))) continue;
    const storeHit = card.store.includes(name);
    const titleHit = card.title.includes(name);
    if (!storeHit && !titleHit) continue;

    let score = 10; // 品牌匹配起步
    const why = [storeHit ? 'store' : 'title'];
    if (storeHit) score += 2;
    // 2026-11-10 目标转向「播放量 / 团购等级 / 出单量」：佣金率不再参与排序。
    // 团购带货力等级看成交额与核销数，所以优先能被大量用户下单的「强促销 + 低门槛」单品。
    for (const w of GOOD_WORDS) if (card.title.includes(w)) { score += 1.5; why.push(w); }
    if (CARD_RE.test(card.raw)) { score -= 3; why.push('card'); }
    if (card.price != null) {
      if (card.price >= 5 && card.price <= 60) { score += 2; why.push('priceBand'); }
      else if (card.price > 200) { score -= 2; why.push('expensive'); }
    }
    if (opts.product && card.title.includes(String(opts.product))) { score += 2; why.push('productMatch'); }

    if (!best || score > best.score) {
      best = { i: c.i, ...card, score: Math.round(score * 10) / 10, why: why.join('+') };
    }
  }
  return best;
}

const PROMO_MAX = 10;
// 商品卡常见「【专属特惠】熟食·冬菇马蹄云饺2选1」：括号里多为营销词，但也可能是规格；
// 单独成段的「生鲜/熟食」这类泛品类词对搜索没帮助，超长时优先丢掉
const GENERIC_SEG = /^(生鲜|熟食|冷冻|速食|预包装|成品|半成品|餐饮|美食|进店顾客)$/;

// 推广标题（2026-11-10 新规）：平台限 10 字，要求尽量是「商品名称+规格」。
// 去掉营销括号、价格和泛品类前缀后优先整体保留；仍超长就取最长的一段再截断。
// 取不到有效内容时退回品牌名，保证抽屉里的输入框不会空着。
function promoTitle(card, brand) {
  const raw = typeof card === 'string' ? card : (card && card.title) || '';
  const cleaned = String(raw)
    .replace(/[【\[〔][^】\]〕]*[】\]〕]/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/￥\s*\d+(?:\.\d+)?/g, '')
    .replace(/\d+(?:\.\d+)?\s*元/g, '')
    .replace(/[，,。；;！!？?、/／|]/g, '·')
    .replace(/\s+/g, '')
    .replace(/^[·]+|[·]+$/g, '');
  const segs = cleaned.split(/[·]+/).filter(Boolean);
  let out = segs.join('·');
  if (out.length > PROMO_MAX) {
    const kept = segs.filter(s => !GENERIC_SEG.test(s));
    if (kept.length) {
      const joined = kept.join('·');
      out = joined.length <= PROMO_MAX
        ? joined
        : kept.slice().sort((a, b) => b.length - a.length)[0];
    }
  }
  if (out.length > PROMO_MAX) out = out.slice(0, PROMO_MAX);
  if (out.length < 2) out = String(brand || '').slice(0, PROMO_MAX);
  return out;
}

module.exports = { parseProductCard, pickBestProduct, promoTitle, DEFAULT_EXCLUDE, GOOD_WORDS };

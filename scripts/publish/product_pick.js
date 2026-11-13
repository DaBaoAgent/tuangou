// 团购商品挑选：从抖音发布页「请选择团购商品」列表里挑一个最可能带来成交的商品。
// 只做确定性规则，不猜：品牌对不上的一律不选。

const DEFAULT_EXCLUDE = ['私人影院', '影院', '影城', '足浴', '按摩', '洗浴', 'KTV', '酒吧'];
const GOOD_WORDS = ['爆款', '必囤', '畅销', '超值', '特惠', '秒杀', '买一送一', '买一赠一', '套餐', '新品', '招牌', '人气', '团购'];
const CARD_RE = /次卡|月卡|季卡|年卡|充值|储值/;
// 泛词不进「商品名匹配」词表：命中它们等于没指定商品，会退化成随便挂一款
const GENERIC_PRODUCT_TERMS = new Set([
  '套餐', '单人', '双人', '多人', '单人餐', '双人餐', '代金券', '优惠券', '团购', '特惠', '爆款',
  '新品', '招牌', '单品', '饮品', '饮料', '小吃', '甜品', '主食', '组合', '超值', '必囤', '秒杀',
  '买一送一', '买一赠一', '进店顾客', '全国通用', '通用', '美食', '餐饮', '现制', '零售', '套餐组合',
]);

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

// 归一化：丢营销括号、价格、标点和空格，只留可比较的字面量。
// 卡片里的「【爆款】莓果酸奶饮（大杯）」和 meta 里的「莓果酸奶饮」归一后能对上。
function normalizeText(s) {
  return String(s || '')
    .replace(/[【「〔\[（(][^】」〕\]）)]*[】」〕\]）)]/g, '')
    .replace(/￥\s*\d+(?:\.\d+)?/g, '')
    .replace(/\d+(?:\.\d+)?\s*元/g, '')
    .replace(/[\s·・、，,。；;：:！!？?/\\|+＋\-—_~`'"“”‘’*#@&%$^]+/g, '')
    .toLowerCase();
}

// 从「视频商品名」派生匹配词。
// 规则（2026-11-11 宝哥定，硬性）：视频文案里写了什么商品，就只能挂那个商品的团购。
// 商品名缺省、或商品名本身等于品牌名时算「文案没指定商品」，返回空词表走品牌级规则。
function productTerms(product, brand) {
  const raw = String(product || '').trim();
  if (!raw) return [];
  const brandN = normalizeText(brand);
  const productN = normalizeText(raw);
  if (!productN) return [];
  // 只有「商品名就是品牌名」或「商品名是品牌名的一部分」才算没指定商品；
  // 商品名以品牌开头还带具体单品（瑞幸咖啡莓果酸奶饮）要在下面剥掉品牌前缀，不能直接放空。
  if (brandN && (productN === brandN || brandN.includes(productN))) return [];
  // 「品牌+套餐/双杯」这类也只有泛词或规格，等于没指定具体商品
  const brandRest = brandN && productN.startsWith(brandN) ? productN.slice(brandN.length) : '';
  if (brandRest && (GENERIC_PRODUCT_TERMS.has(brandRest)
    || /^(双杯|单杯|中杯|大杯|小杯|套餐|2件套|三件套|份)$/u.test(brandRest))) return [];
  const out = new Set();
  if (productN.length >= 2 && !GENERIC_PRODUCT_TERMS.has(productN)) out.add(productN);
  // 商品名里带品牌前缀（瑞幸咖啡莓果酸奶饮）时补一份去掉品牌的部分
  if (brandRest && brandRest.length >= 3 && !GENERIC_PRODUCT_TERMS.has(brandRest)) out.add(brandRest);
  const segs = String(raw)
    .replace(/[【\[〔（(][^】\]〕）)]*[】\]〕）)]/g, '·')
    .split(/[·・、，,\/|+＋；;]+/);
  for (const seg of segs) {
    const n = normalizeText(seg);
    if (n.length >= 3 && !GENERIC_PRODUCT_TERMS.has(n)) out.add(n);
    const stripped = n.replace(/(\d+选1|双杯|单杯|中杯|大杯|小杯|套餐|2件套|三件套|份)$/u, '');
    if (stripped.length >= 3 && stripped !== n && !GENERIC_PRODUCT_TERMS.has(stripped)) out.add(stripped);
  }
  return [...out];
}

// 硬规则入口：先按商品名筛，再在筛过的候选里按品牌/爆款/价格带排序。
// 返回 { ok, reason, best, terms, rejected, candidates }：
// - terms 为空 → 文案没指定商品，按品牌级规则挑（兼容老行为）
// - terms 非空但一条都没命中 → ok:false, reason:'product-mismatch'，调用方必须退回别挂商品
function decideProduct(cards, brand, opts = {}) {
  const name = String(brand || '').trim();
  if (!name) return { ok: false, reason: 'no-brand', best: null, terms: [], rejected: [], candidates: 0 };
  const exclude = opts.exclude || DEFAULT_EXCLUDE;
  const terms = productTerms(opts.product, name);
  const candidates = Array.isArray(cards) ? cards.length : 0;
  const rejected = [];
  let best = null;
  for (const c of cards || []) {
    const card = parseProductCard(c.text);
    if (!card) continue;
    if (exclude.some(w => card.raw.includes(w))) continue;
    const storeHit = card.store.includes(name);
    const titleHit = card.title.includes(name);
    if (!storeHit && !titleHit) continue;

    const titleN = normalizeText(card.title);
    let matchedTerm = null;
    if (terms.length) {
      for (const t of terms) {
        if (!titleN.includes(t)) continue;
        if (!matchedTerm || t.length > matchedTerm.length) matchedTerm = t;
      }
      if (!matchedTerm) {
        rejected.push({ i: c.i, title: card.title });
        continue;
      }
    }

    let score = 10; // 品牌匹配起步
    const why = [storeHit ? 'store' : 'title'];
    if (storeHit) score += 2;
    // 2026-11-10 目标转向「播放量 / 团购等级 / 出单量」：佣金率不再参与排序。
    // 团购带货力等级看成交额与核销数，所以优先能被大量用户下单的「强促销 + 低门槛」单品。
    // 2026-11-11 硬性规则：商品名命中者优先，命中词越长越优先（「莓果酸奶饮」>「莓果」）。
    if (matchedTerm) {
      score += 4 + Math.min(matchedTerm.length, 6) * 0.5;
      why.push('productMatch:' + matchedTerm);
    }
    for (const w of GOOD_WORDS) if (card.title.includes(w)) { score += 1.5; why.push(w); }
    if (CARD_RE.test(card.raw)) { score -= 3; why.push('card'); }
    if (card.price != null) {
      if (card.price >= 5 && card.price <= 60) { score += 2; why.push('priceBand'); }
      else if (card.price > 200) { score -= 2; why.push('expensive'); }
    }
    if (opts.product && card.title.includes(String(opts.product))) { score += 2; why.push('productExact'); }

    const entry = { i: c.i, ...card, matched_term: matchedTerm, score: Math.round(score * 10) / 10, why: why.join('+') };
    if (!best || entry.score > best.score) best = entry;
  }
  if (!best) {
    return {
      ok: false,
      reason: terms.length ? 'product-mismatch' : 'no-matching-product',
      best: null, terms, rejected, candidates,
    };
  }
  return { ok: true, reason: null, best, terms, rejected, candidates };
}

// cards: [{i, text}]；返回 {i, ...card, score, why} 或 null
function pickBestProduct(cards, brand, opts = {}) {
  const d = decideProduct(cards, brand, opts);
  return d.best;
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

module.exports = {
  parseProductCard, pickBestProduct, decideProduct, productTerms, normalizeText, promoTitle,
  DEFAULT_EXCLUDE, GOOD_WORDS, GENERIC_PRODUCT_TERMS,
};

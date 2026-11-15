const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./lib');

const STATE = () => ({ used_title_suffix: [] });
const INFO = (file, extra = {}) => ({ file, brand: '', lines: [], ...extra });

// 2026-11-15（宝哥要求）：未认证品牌的成片，标题/描述里品牌名不许丢，
// 只有话题不挂品牌。此前缺 meta 的成片因为 brand 被置空，出过「这一口，谁懂这一口？」。
test('标题：未认证品牌（brand_topic=false）仍带品牌名', () => {
  const copy = L.buildCopy(INFO('好想来-零食-02.mp4', {
    brand: '好想来', brand_topic: false, product: '零食',
  }), STATE());
  assert.match(copy.title, /好想来/);
  assert.ok(!copy.title.includes('这一口，谁懂这一口'));
});

test('标题：缺 meta 时按文件名兜底识别品牌', () => {
  const copy = L.buildCopy(INFO('好想来-零食-02.mp4', { brand: null, product: '零食' }), STATE());
  assert.match(copy.title, /好想来/);
});

test('标题：主体与后缀不重复（不出现「这一口，谁懂这一口？」）', () => {
  for (const file of ['A-1.mp4', 'B-2.mp4', 'C-3.mp4', 'D-4.mp4', 'E-5.mp4']) {
    const copy = L.buildCopy(INFO(file, { brand: '', product: '' }), STATE());
    const [head, tail] = copy.title.replace(/[？?]$/, '').split('，');
    assert.ok(head && tail, `标题结构异常：${copy.title}`);
    assert.ok(!head.includes(tail) && !tail.includes(head), `标题前后重复：${copy.title}`);
  }
});

test('话题：未认证品牌不挂品牌话题，但仍要有团购', () => {
  const copy = L.buildCopy(INFO('好想来-零食-02.mp4', {
    brand: '好想来', brand_topic: false, product: '零食',
  }), STATE());
  assert.ok(!copy.topics.some(t => t.includes('好想来')));
  assert.ok(copy.topics.includes('#团购'));
});

const test = require('node:test');
const assert = require('node:assert');
const { parseKpi, parseTab } = require('./revenue');

// 2026-11-10 真实页面文本（点开眼睛开关之后）
const KPI_TEXT = '我的变现 更新时间：2026.11.09 变现设置 查看详情 昨日收入 ¥ 0.69 较前日 +0.69 '
  + '近7日收入 ¥ 3.18 较前7日 0.00 近30日收入 ¥ 8.01 较前日 0.00 '
  + '收入总 ¥ 394.63 较前日 0.00 可提现 ¥ 37.80 去提现 较前日 0.00 收入趋势 变现广场';

// 宝哥当前账号的「选品带货」分类（全零，累计是历史电商佣金）
const TAB_PICK = '收入概览 已更新至11.09，每天12点前更新昨日收益 查看收益规则 '
  + '昨日 11.09 ¥ 0.00 较前日 0.00 近7日 11.03~11.09 ¥ 0.00 较前7日 0.00 '
  + '近30日 10.11~11.09 ¥ 0.00 较前30日 0.00 全部累计 截止2026.11.09 ¥ 128.84 暂无数据';

const TAB_AD = '收入概览 已更新至11.09，每天24点前更新昨日收益 查看收益规则 '
  + '昨日 11.09 ¥ 0.04 较前日 +0.04 近7日 11.03~11.09 ¥ 0.09 较前7日 -0.02 '
  + '近30日 10.11~11.09 ¥ 1.22 较前30日 -1.45 全部累计 截止2026.11.09 ¥ 196.38 '
  + '收入明细 时间 收入类型 金额 2026-11-09 广告分成收入 0.04';

test('parseKpi：读出总览五项金额', () => {
  assert.deepEqual(parseKpi(KPI_TEXT), {
    yesterday: 0.69, last7: 3.18, last30: 8.01, total: 394.63, withdrawable: 37.8,
  });
});

test('parseKpi：金额被遮住（没有 ¥）时返回 null，不瞎猜', () => {
  const masked = '昨日收入 较前日 +0.69 近7日收入 较前7日 0.00 收入总 较前日 0.00 可提现 较前日 0.00';
  assert.deepEqual(parseKpi(masked), {
    yesterday: null, last7: null, last30: null, total: null, withdrawable: null,
  });
});

test('parseTab：区分四个统计口径，累计金额单独取', () => {
  assert.deepEqual(parseTab(TAB_PICK), { yesterday: 0, last7: 0, last30: 0, total: 128.84 });
  assert.deepEqual(parseTab(TAB_AD), { yesterday: 0.04, last7: 0.09, last30: 1.22, total: 196.38 });
});

test('parseTab：千分位金额能解析', () => {
  const t = '昨日 11.09 ¥ 1,234.5 近7日 11.03~11.09 ¥ 2,000 近30日 10.11~11.09 ¥ 3,000 '
    + '全部累计 截止2026.11.09 ¥ 10,000';
  assert.deepEqual(parseTab(t), { yesterday: 1234.5, last7: 2000, last30: 3000, total: 10000 });
});

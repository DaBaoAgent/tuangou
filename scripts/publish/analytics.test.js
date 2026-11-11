const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./analytics');
const { readXlsxRows } = require('./xlsx');

test('数字/百分比/时长解析：万、千、%、mm:ss 与占位符', () => {
  assert.equal(A.num('1.2万'), 12000);
  assert.equal(A.num('3,456'), 3456);
  assert.equal(A.num('—'), null);
  assert.equal(A.num(''), null);
  assert.equal(A.pct('12.34%'), 0.1234);
  assert.equal(A.pct('0.5'), 0.5);
  assert.equal(A.pct('—'), null);
  assert.equal(A.seconds('00:15'), 15);
  assert.equal(A.seconds('01:02'), 62);
});

test('发布时间：中文日期与无年份日期都能出小时', () => {
  const a = A.parsePublished('2026年11月10日 18:25');
  assert.equal(a.hour, 18);
  assert.match(a.at, /^2026-11-10T18:25/);
  const b = A.parsePublished('11-09 07:05');
  assert.equal(b.hour, 7);
  assert.equal(A.parsePublished(''), null);
});

test('normalizeWorks：按表头取列，跳过空标题与表头行', () => {
  const rows = [
    ['作品名称', '发布时间', '播放量', '完播率', '2s跳出率', '点赞量'],
    ['标题A', '2026-11-10 18:25', '12', '3.5%', '66.67%', '0'],
    ['', '2026-11-10 18:25', '99', '9%', '9%', '0'],
    ['作品名称', '2026-11-10 18:25', '99', '9%', '9%', '0'],
    ['标题B', '2026-11-09 07:05', '1.2万', '—', '40%', '30'],
  ];
  const works = A.normalizeWorks(rows);
  assert.equal(works.length, 2);
  assert.equal(works[0].title, '标题A');
  assert.equal(works[0].plays, 12);
  assert.ok(Math.abs(works[0].finish_rate - 0.035) < 1e-9);
  assert.ok(Math.abs(works[0].bounce_2s - 0.6667) < 1e-6);
  assert.equal(works[1].plays, 12000);
  assert.equal(works[1].finish_rate, null);
  assert.equal(works[1].hour, 7);
  assert.notEqual(works[0].key, works[1].key);
});

test('aggregate：品牌按计划标题 join，时段按桶聚合', () => {
  const rows = [
    ['作品名称', '发布时间', '播放量', '完播率'],
    ['A1', '2026-11-10 18:25', '100', '10%'],
    ['A2', '2026-11-10 07:05', '30', '5%'],
    ['B1', '2026-11-10 08:00', '200', '20%'],
  ];
  const works = A.normalizeWorks(rows);
  const planIndex = new Map([
    ['A1', { brand: '品牌A', category: '炸鸡' }],
    ['A2', { brand: '品牌A', category: '炸鸡' }],
    ['B1', { brand: '品牌B', category: '茶饮' }],
  ]);
  const buckets = [{ from: 6, to: 9 }, { from: 9, to: 12 }, { from: 12, to: 15 }, { from: 15, to: 19 }];
  const data = A.aggregate(works, planIndex, { buckets });
  assert.equal(data.count, 3);
  assert.equal(data.brands['品牌A'].n, 2);
  assert.equal(data.brands['品牌A'].plays_avg, 65);
  assert.equal(data.brands['品牌B'].plays_avg, 200);
  assert.equal(data.categories['炸鸡'].n, 2);
  assert.equal(data.overall.plays_total, 330);
  // 06-09 桶里有 A2(07:05)/B1(08:00)，18 点那条进 15-19 桶
  assert.equal(data.hours['06-09'].n, 2);
  assert.equal(data.hours['15-19'].n, 1);
});

test('defaultBuckets：默认 06:00-19:00 覆盖到最后一分钟', () => {
  const b = A.defaultBuckets();
  assert.equal(b[0].from, 6);
  assert.equal(b[b.length - 1].to, 19);
  for (let h = 6; h < 19; h++) assert.ok(A.bucketOf(h, b), `hour ${h} 没有归桶`);
  assert.equal(A.bucketOf(null, b), null);
});

test('synthesized xlsx：自己拼一个最小工作簿，验证零依赖解压与读表', () => {
  const zlib = require('zlib');
  const files = {
    'xl/sharedStrings.xml': '<?xml version="1.0"?><sst><si><t>作品名称</t></si><si><t>播放量</t></si><si><t>标题X</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
      + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c></row>'
      + '</sheetData></worksheet>',
  };
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const buf = Buffer.concat([...parts, cdBuf, eocd]);
  const rows = readXlsxRows(buf);
  assert.deepEqual(rows[0], ['作品名称', '播放量']);
  assert.deepEqual(rows[1], ['标题X', '42']);
});

test('statsPaths：配了 stats_dir 用它，没配则跟 work_dir 走（沙箱隔离）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-analytics-'));
  const cfg = { paths: { work_dir: path.join(root, 'runtime'), stats_dir: path.join(root, 'runtime/stats') } };
  const paths = A.statsPaths(root, cfg);
  assert.equal(paths.works, path.join(root, 'runtime/stats/works.json').replace(/\\/g, '/'));
  const paths2 = A.statsPaths(root, { paths: { work_dir: path.join(root, 'sandbox/runtime') } });
  assert.ok(paths2.dir.includes('sandbox/runtime/stats'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('loadOrders：null/空/坏 JSON 返回 null，数组与对象两种格式都能读', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-orders-'));
  const paths = { orders: path.join(root, 'orders.json') };
  for (const bad of ['null', '', '{oops', '[]']) {
    fs.writeFileSync(paths.orders, bad);
    const got = A.loadOrders(paths);
    assert.ok(got === null || Object.keys(got.brands).length === 0, `${bad} 不应抛错`);
  }
  fs.writeFileSync(paths.orders, JSON.stringify([{ brand: '袁记云饺', orders: 3, gmv: 45.5, commission: 1.4 }]));
  const arr = A.loadOrders(paths);
  assert.equal(arr.brands['袁记云饺'].orders, 3);
  assert.equal(arr.brands['袁记云饺'].gmv, 45.5);
  fs.writeFileSync(paths.orders, JSON.stringify({ updated_at: 'x', brands: { 瑞幸咖啡: { 订单: 2, 佣金: 0.6 } } }));
  const obj = A.loadOrders(paths);
  assert.equal(obj.updated_at, 'x');
  assert.equal(obj.brands['瑞幸咖啡'].orders, 2);
  assert.equal(obj.brands['瑞幸咖啡'].commission, 0.6);
  fs.rmSync(root, { recursive: true, force: true });
});

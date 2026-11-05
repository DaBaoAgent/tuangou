// run_due 沙箱端到端测试：复制脚本到临时目录，发布器用桩替代，绝不碰真实素材和发布状态。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = __dirname;
const sandboxes = [];

function slash(p) { return p.replace(/\\/g, '/'); }

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tuangou-run-'));
  sandboxes.push(dir);
  for (const f of ['lib.js', 'run_due.js', 'subtitle_gate.js']) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  // 通知桩：真的被调用时留下 notified.txt，用来断言 dry-run 没发通知
  fs.writeFileSync(path.join(dir, 'notify.ps1'), [
    'param([string]$Title,[string]$Message)',
    "Add-Content -Path (Join-Path $PSScriptRoot 'notified.txt') -Value \"$Title|$Message\" -Encoding utf8",
  ].join('\n'));
  const cfg = JSON.parse(fs.readFileSync(path.join(SRC, 'config.json'), 'utf8'));
  cfg.paths = {
    video_dir: slash(path.join(dir, '成片')),
    published_dir: slash(path.join(dir, '成片/已发')),
    work_dir: slash(path.join(dir, 'runtime')),
    auto_edit_work: slash(path.join(dir, 'work')),
    brand_index: slash(path.join(dir, 'work/brand_index.json')),
    profile_dir: slash(path.join(dir, 'profile')),
  };
  cfg.schedule.window = { start: '00:00', end: '23:59' };
  // 这些用例专注品牌/发布状态，字幕闸门用「全部视为存量片」避免依赖 OCR
  cfg.publish.subtitle_enforce_since = '2099-01-01T00:00:00+08:00';
  cfg.notify = { wechat: false };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  fs.mkdirSync(path.join(dir, '成片'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'runtime/plans'), { recursive: true });
  return { dir, cfg };
}

function writeStub(sb) {
  fs.writeFileSync(path.join(sb.dir, 'publish_one.js'), [
    "const fs = require('fs');",
    "const path = require('path');",
    "const mode = process.env.STUB_PUBLISH_MODE || 'dry';",
    'module.exports = {',
    '  publishOne: async () => {',
    "    fs.appendFileSync(path.join(__dirname, 'stub_calls.txt'), mode + '\\n');",
    "    if (mode === 'dry') return { ok: true, dryRun: true };",
    "    if (mode === 'ok') return { ok: true, workId: '1', loc: { ok: true, selected: '临榆炸鸡腿(测试店)' } };",
    "    if (mode === 'captcha-clicked') return { ok: false, reason: 'captcha', clickedPublish: true };",
    "    if (mode === 'unknown-noflag') return { ok: false, reason: 'publish-result-unknown' };",
    "    return { ok: false, reason: 'captcha' };",
    '  },',
    '};',
  ].join('\n'));
}

function addVideo(sb, name = '成片A.mp4') {
  const vp = path.join(sb.dir, '成片', name);
  fs.writeFileSync(vp, 'x');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(vp, old, old);
  const work = path.join(sb.dir, 'work/clip1');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'meta.json'), JSON.stringify({
    output: slash(vp),
    brand: { brand: '临榆炸鸡腿', brand_id: 'linyu_zhaji', confidence: 0.99, needs_review: false },
    lines: [{ text: '外皮酥脆到掉渣' }, { text: '咬一口直接爆汁' }],
  }));
  return name;
}

// 品牌不确定（无品牌 / 待复核 / 置信度低）时，run_due 必须跳过，绝不猜品牌发布
function addUnconfirmedVideo(sb, name = '成片B.mp4') {
  const vp = path.join(sb.dir, '成片', name);
  fs.writeFileSync(vp, 'x');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(vp, old, old);
  const work = path.join(sb.dir, 'work/clip2');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'meta.json'), JSON.stringify({
    output: slash(vp),
    brand: { brand: '麦当劳', brand_id: 'mcdonalds', confidence: 0.855, needs_review: false },
    lines: [{ text: '外皮酥脆到掉渣' }, { text: '咬一口直接爆汁' }],
  }));
  return name;
}

function writePlan(sb, items) {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const at = Math.max(0, nowMin - 5);
  const hhmm = `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;
  const plan = {
    date: todayStr(), day_index: 1, target_count: items.length, status: 'active',
    created_at: now.toISOString(),
    items: items.map((it, i) => ({
      id: `${todayStr()}-${String(i + 1).padStart(2, '0')}`,
      at: it.at || hhmm,
      status: it.status || 'pending',
      ...it,
    })),
  };
  const p = path.join(sb.dir, 'runtime/plans', `${todayStr()}.json`);
  fs.writeFileSync(p, JSON.stringify(plan, null, 2));
  return { path: p, plan };
}

function readPlan(sb) {
  return JSON.parse(fs.readFileSync(path.join(sb.dir, 'runtime/plans', `${todayStr()}.json`), 'utf8'));
}

function stateFile(sb) { return path.join(sb.dir, 'runtime/state.json'); }
function notifiedFile(sb) { return path.join(sb.dir, 'notified.txt'); }

function runDue(sb, { dryRun = false, mode = 'dry' } = {}) {
  const args = ['run_due.js'];
  if (dryRun) args.push('--dry-run');
  return execFileSync(process.execPath, args, {
    cwd: sb.dir,
    env: { ...process.env, STUB_PUBLISH_MODE: mode },
    encoding: 'utf8',
    timeout: 60000,
  });
}

test.after(() => {
  for (const d of sandboxes) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

test('run_due --dry-run：无库存时不写状态、不发通知、不拉起剪辑', () => {
  const sb = sandbox();
  writeStub(sb);
  const { path: planPath } = writePlan(sb, [{}]);
  const before = fs.readFileSync(planPath, 'utf8');
  const out = runDue(sb, { dryRun: true });
  assert.match(out, /DRY_RUN no video/);
  assert.equal(fs.existsSync(stateFile(sb)), false);
  assert.equal(fs.readFileSync(planPath, 'utf8'), before);
  assert.equal(fs.existsSync(notifiedFile(sb)), false);
});

test('run_due --dry-run：有库存时也不写状态、不发通知、不改计划', () => {
  const sb = sandbox();
  writeStub(sb);
  addVideo(sb);
  const { path: planPath } = writePlan(sb, [{}]);
  const before = fs.readFileSync(planPath, 'utf8');
  const out = runDue(sb, { dryRun: true, mode: 'dry' });
  assert.match(out, /DRY_RUN/);
  assert.equal(fs.existsSync(stateFile(sb)), false);
  assert.equal(fs.readFileSync(planPath, 'utf8'), before);
  assert.equal(fs.existsSync(notifiedFile(sb)), false);
  assert.equal(fs.existsSync(path.join(sb.dir, '成片/_unverified_成片A.mp4')), false);
});

test('run_due --dry-run：发布器返回失败也不写暂停状态', () => {
  const sb = sandbox();
  writeStub(sb);
  addVideo(sb);
  const { path: planPath } = writePlan(sb, [{}]);
  const before = fs.readFileSync(planPath, 'utf8');
  runDue(sb, { dryRun: true, mode: 'captcha' });
  assert.equal(fs.existsSync(stateFile(sb)), false);
  assert.equal(fs.readFileSync(planPath, 'utf8'), before);
  assert.equal(fs.existsSync(notifiedFile(sb)), false);
});

test('点击发布后遇到验证码：按待核实处理，移出队列并暂停，绝不重发', () => {
  const sb = sandbox();
  writeStub(sb);
  addVideo(sb);
  writePlan(sb, [{}]);
  runDue(sb, { mode: 'captcha-clicked' });

  const state = JSON.parse(fs.readFileSync(stateFile(sb), 'utf8'));
  assert.equal(state.paused, true);
  assert.match(state.paused_reason, /验证码/);

  const item = readPlan(sb).items[0];
  assert.equal(item.status, 'pending_verify');
  assert.equal(item.reason, 'captcha');
  assert.ok(item.marked_unverified_to.includes('_unverified_成片A.mp4'));

  assert.equal(fs.existsSync(path.join(sb.dir, '成片/成片A.mp4')), false);
  assert.equal(fs.existsSync(path.join(sb.dir, '成片/_unverified_成片A.mp4')), true);
  assert.match(fs.readFileSync(notifiedFile(sb), 'utf8'), /待核实/);
});

test('点击发布后结果未知（即使没带 flag）：也按待核实处理，绝不进入重试', () => {
  const sb = sandbox();
  writeStub(sb);
  addVideo(sb);
  writePlan(sb, [{}]);
  runDue(sb, { mode: 'unknown-noflag' });

  const item = readPlan(sb).items[0];
  assert.equal(item.status, 'pending_verify');
  assert.equal(item.reason, 'publish-result-unknown');
  assert.equal(item.retries, undefined);
  assert.equal(fs.existsSync(path.join(sb.dir, '成片/成片A.mp4')), false);
  assert.equal(fs.existsSync(path.join(sb.dir, '成片/_unverified_成片A.mp4')), true);

  // 再跑一轮：发布器不应被再次调用（stub_calls.txt 仍只有 1 行）
  runDue(sb, { mode: 'unknown-noflag' });
  const calls = fs.readFileSync(path.join(sb.dir, 'stub_calls.txt'), 'utf8').trim().split('\n');
  assert.equal(calls.length, 1);
  assert.equal(readPlan(sb).items[0].status, 'pending_verify');
});

test('还没点发布就遇到验证码：保留队列，只暂停', () => {
  const sb = sandbox();
  writeStub(sb);
  addVideo(sb);
  writePlan(sb, [{}]);
  runDue(sb, { mode: 'captcha' });

  const state = JSON.parse(fs.readFileSync(stateFile(sb), 'utf8'));
  assert.equal(state.paused, true);
  const item = readPlan(sb).items[0];
  assert.equal(item.status, 'pending');
  assert.equal(item.reason, 'captcha');
  assert.equal(fs.existsSync(path.join(sb.dir, '成片/成片A.mp4')), true);
  assert.equal(fs.existsSync(path.join(sb.dir, '成片/_unverified_成片A.mp4')), false);
});

test('品牌置信度不足：自动移入品牌待确认并通知，绝不发布', () => {
  const sb = sandbox();
  writeStub(sb);
  addUnconfirmedVideo(sb);
  writePlan(sb, [{}]);
  runDue(sb, { mode: 'dry' });

  // 发布器绝不能被调用
  assert.equal(fs.existsSync(path.join(sb.dir, 'stub_calls.txt')), false);
  assert.equal(readPlan(sb).items[0].status, 'pending');
  const notified = fs.readFileSync(notifiedFile(sb), 'utf8');
  assert.match(notified, /品牌待确认/);
  assert.match(notified, /1 条品牌未确认/);
  // 成片已移出自动队列，meta.output 同步到新目录
  assert.equal(fs.existsSync(path.join(sb.dir, '成片/成片B.mp4')), false);
  assert.equal(fs.existsSync(path.join(sb.dir, '成片/品牌待确认/成片B.mp4')), true);
  const meta = JSON.parse(fs.readFileSync(path.join(sb.dir, 'work/clip2/meta.json'), 'utf8'));
  assert.ok(meta.output.includes('品牌待确认'));
});

test('品牌不确定的成片移入品牌待确认，继续发下一条品牌确定的', () => {
  const sb = sandbox();
  writeStub(sb);
  addUnconfirmedVideo(sb);
  addVideo(sb);
  writePlan(sb, [{}]);
  runDue(sb, { mode: 'ok' });

  const item = readPlan(sb).items[0];
  assert.equal(item.status, 'published');
  assert.equal(item.video, '成片A.mp4');
  assert.equal(item.brand, '临榆炸鸡腿');
  assert.equal(item.location.ok, true);

  const notified = fs.readFileSync(notifiedFile(sb), 'utf8');
  assert.match(notified, /已发布/);
  assert.match(notified, /品牌待确认/);

  // 不确定品牌的那条已移出库存，等人工确认
  assert.equal(fs.existsSync(path.join(sb.dir, '成片/成片B.mp4')), false);
  assert.equal(fs.existsSync(path.join(sb.dir, '成片/品牌待确认/成片B.mp4')), true);
});

test('pickVideo 排除 state.excluded_videos 与计划里待核实/审核不通过的成片', () => {
  const sb = sandbox();
  addVideo(sb);
  fs.writeFileSync(stateFile(sb), JSON.stringify({
    paused: false, paused_reason: null, history: [], used_title_suffix: [], excluded_videos: ['成片A.mp4'],
  }));
  const run = () => execFileSync(process.execPath,
    ['-e', "const L=require('./lib'); console.log(JSON.stringify(L.pickVideo().map(v=>v.file)))"],
    { cwd: sb.dir, encoding: 'utf8' });

  assert.deepEqual(JSON.parse(run().trim()), []);

  // 改名失败场景：成片还在目录里，但计划已标 pending_verify，也不能再次被选中
  fs.writeFileSync(stateFile(sb), JSON.stringify({
    paused: false, paused_reason: null, history: [], used_title_suffix: [], excluded_videos: [],
  }));
  writePlan(sb, [{ video: '成片A.mp4', status: 'pending_verify' }]);
  assert.deepEqual(JSON.parse(run().trim()), []);

  writePlan(sb, [{ video: '成片A.mp4', status: 'rejected' }]);
  assert.deepEqual(JSON.parse(run().trim()), []);

  // 正常计划仍能选中
  writePlan(sb, [{ video: '成片A.mp4', status: 'published' }]);
  assert.deepEqual(JSON.parse(run().trim()), ['成片A.mp4']);
});

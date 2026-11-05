// 字幕闸门测试：沙箱复制 lib/subtitle_gate/config，绝不碰真实成片和 OCR。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = __dirname;
const sandboxes = [];

function slash(p) { return p.replace(/\\/g, '/'); }

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tuangou-sub-'));
  sandboxes.push(dir);
  for (const f of ['lib.js', 'subtitle_gate.js']) {
    fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(SRC, 'config.json'), 'utf8'));
  cfg.paths = {
    video_dir: slash(path.join(dir, '成片')),
    published_dir: slash(path.join(dir, '成片/已发')),
    work_dir: slash(path.join(dir, 'runtime')),
    auto_edit_work: slash(path.join(dir, 'work')),
    brand_index: slash(path.join(dir, 'work/brand_index.json')),
    profile_dir: slash(path.join(dir, 'profile')),
  };
  cfg.notify = { wechat: false };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  fs.mkdirSync(path.join(dir, '成片'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'runtime'), { recursive: true });
  const SG = require(path.join(dir, 'subtitle_gate.js'));
  return { dir, SG };
}

function addClip(sb, name, meta, ageMs) {
  const vp = path.join(sb.dir, '成片', name);
  fs.writeFileSync(vp, 'x');
  const ts = new Date(Date.now() - ageMs);
  fs.utimesSync(vp, ts, ts);
  const work = path.join(sb.dir, 'work', meta.dir);
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'meta.json'), JSON.stringify({
    output: slash(vp),
    brand: { brand: '临榆炸鸡腿', confidence: 0.99, needs_review: false },
    ...meta.fields,
  }, null, 2));
  return vp;
}

const AUTO = {
  lines: [{ text: '外皮酥脆到掉渣', start: 1, end: 2 }],
  verify: { ok: true, frames: ['a.jpg'] },
  subtitle_skipped: false,
};
const EXTERNAL = { lines: [{ text: '外皮酥脆到掉渣', start: 1, end: 2 }], verify: {}, subtitle_skipped: false };

test('存量片直接放行，不调用 OCR', () => {
  const sb = sandbox();
  addClip(sb, '旧片.mp4', { dir: 'old', fields: AUTO }, 86400000);
  let calls = 0;
  const r = sb.SG.auditInventory({ enforceSinceMs: Date.now() - 60000, auditFn: () => { calls++; return { ok: true, status: 'ok' }; } });
  assert.equal(calls, 0);
  assert.equal(r.skipped, 1);
  assert.equal(sb.SG.confirmed({ clipKey: 'old' }), true);
});

test('新自动剪辑片复核通过才允许发布', () => {
  const sb = sandbox();
  addClip(sb, '新片.mp4', { dir: 'auto1', fields: AUTO }, 180000);
  let calls = 0;
  const r = sb.SG.auditInventory({
    enforceSinceMs: Date.now() - 600000,
    auditFn: () => { calls++; return { ok: true, status: 'ok', checked: 1 }; },
  });
  assert.equal(calls, 1);
  assert.equal(r.audited, 1);
  assert.equal(r.failed.length, 0);
  assert.equal(sb.SG.confirmed({ clipKey: 'auto1' }), true);
});

test('复核失败移入字幕待修复并更新 meta.output', () => {
  const sb = sandbox();
  const vp = addClip(sb, '坏片.mp4', { dir: 'bad1', fields: AUTO }, 180000);
  const r = sb.SG.auditInventory({
    enforceSinceMs: Date.now() - 600000,
    auditFn: () => ({ ok: false, status: 'fail', checked: 1, bad: [{ expect: '外皮酥脆', got: '外皮酥' }] }),
  });
  assert.equal(r.failed.length, 1);
  assert.equal(fs.existsSync(vp), false);
  assert.equal(fs.existsSync(path.join(sb.dir, '成片/字幕待修复/坏片.mp4')), true);
  const meta = JSON.parse(fs.readFileSync(path.join(sb.dir, 'work/bad1/meta.json'), 'utf8'));
  assert.equal(meta.output.replace(/\\/g, '/').endsWith('字幕待修复/坏片.mp4'), true);
  assert.equal(sb.SG.confirmed({ clipKey: 'bad1' }), false);
});

test('没有校对依据的手工新片暂缓发布但不移动', () => {
  const sb = sandbox();
  const vp = addClip(sb, '手工片.mp4', { dir: 'ext1', fields: EXTERNAL }, 180000);
  const r = sb.SG.auditInventory({ enforceSinceMs: Date.now() - 600000, auditFn: () => { throw new Error('should not audit'); } });
  assert.equal(r.manual.length, 1);
  assert.equal(fs.existsSync(vp), true);
  assert.equal(sb.SG.confirmed({ clipKey: 'ext1' }), false);
});

test('OCR 服务不可用的成片不进缓存，恢复后自动重审', () => {
  const sb = sandbox();
  addClip(sb, '宕机片.mp4', { dir: 'down1', fields: AUTO }, 180000);
  let calls = 0;
  const auditFn = () => {
    calls++;
    return calls === 1
      ? { ok: false, status: 'unavailable', error: 'service down' }
      : { ok: true, status: 'ok', checked: 1 };
  };
  const args = { enforceSinceMs: Date.now() - 600000, auditFn };
  let r = sb.SG.auditInventory(args);
  assert.equal(calls, 1);
  assert.equal(r.unavailable.length, 1);
  assert.equal(sb.SG.confirmed({ clipKey: 'down1' }), false);

  r = sb.SG.auditInventory(args);
  assert.equal(calls, 2);
  assert.equal(r.unavailable.length, 0);
  assert.equal(sb.SG.confirmed({ clipKey: 'down1' }), true);
});

test('未变更的成片复用缓存，不重复 OCR', () => {
  const sb = sandbox();
  addClip(sb, '缓存片.mp4', { dir: 'cache1', fields: AUTO }, 180000);
  let calls = 0;
  const auditFn = () => { calls++; return { ok: true, status: 'ok', checked: 1 }; };
  sb.SG.auditInventory({ enforceSinceMs: Date.now() - 600000, auditFn });
  sb.SG.auditInventory({ enforceSinceMs: Date.now() - 600000, auditFn });
  assert.equal(calls, 1);
});

test.after(() => {
  for (const d of sandboxes) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('./lib');

const OLD = new Date(Date.now() - 10 * 60 * 1000);

function setup(clips) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-'));
  const videoDir = path.join(root, '已剪成片');
  const reviewDir = path.join(videoDir, '品牌待确认');
  const workRoot = path.join(root, 'work');
  const brandIndexPath = path.join(root, 'brand_index.json');
  fs.mkdirSync(videoDir, { recursive: true });
  fs.mkdirSync(workRoot, { recursive: true });
  const index = {};
  for (const c of clips) {
    const video = path.join(videoDir, c.file);
    fs.writeFileSync(video, 'x');
    fs.utimesSync(video, OLD, OLD);
    const stem = c.file.replace(/\.[^.]+$/, '');
    const wd = path.join(workRoot, stem);
    fs.mkdirSync(wd, { recursive: true });
    fs.writeFileSync(path.join(wd, 'meta.json'), JSON.stringify({
      output: video,
      brand: c.brand, // { brand, confidence, needs_review } or null
    }));
    index[stem] = {
      brand: c.brand && c.brand.brand,
      confidence: c.brand && c.brand.confidence,
      needs_review: c.brand && c.brand.needs_review,
      output: video,
    };
  }
  fs.writeFileSync(brandIndexPath, JSON.stringify(index));
  return { root, videoDir, reviewDir, workRoot, brandIndexPath };
}

test('品牌待确认：无品牌/待复核/置信度不足自动移入品牌待确认目录', () => {
  const env = setup([
    { file: 'ok.mp4', brand: { brand: '沪上阿姨', confidence: 1.0, needs_review: false } },
    { file: 'none.mp4', brand: null },
    { file: 'review.mp4', brand: { brand: '茶百道', confidence: 0.99, needs_review: true } },
    { file: 'low.mp4', brand: { brand: '茉莉奶白', confidence: 0.8, needs_review: false } },
  ]);
  const r = L.quarantineUnconfirmed(env);

  assert.deepEqual(r.kept, ['ok.mp4']);
  assert.deepEqual(r.moved.map(x => x.file).sort(), ['low.mp4', 'none.mp4', 'review.mp4']);
  assert.ok(fs.existsSync(path.join(env.videoDir, 'ok.mp4')));
  for (const f of ['none.mp4', 'review.mp4', 'low.mp4']) {
    assert.ok(!fs.existsSync(path.join(env.videoDir, f)), f);
    assert.ok(fs.existsSync(path.join(env.reviewDir, f)), f);
  }

  // meta.output 和 brand_index.output 都要跟着新路径走，归位时才对得上
  const meta = JSON.parse(fs.readFileSync(path.join(env.workRoot, 'low', 'meta.json'), 'utf8'));
  assert.equal(meta.output, path.join(env.reviewDir, 'low.mp4'));
  const idx = JSON.parse(fs.readFileSync(env.brandIndexPath, 'utf8'));
  assert.equal(idx.low.output, path.join(env.reviewDir, 'low.mp4'));

  // 已移走的文件不再重复处理
  const again = L.quarantineUnconfirmed(env);
  assert.equal(again.moved.length, 0);
  assert.deepEqual(again.kept, ['ok.mp4']);
});

test('品牌待确认：dry-run 只报告不移动', () => {
  const env = setup([{ file: 'none.mp4', brand: null }]);
  const r = L.quarantineUnconfirmed({ ...env, dryRun: true });
  assert.equal(r.moved.length, 1);
  assert.equal(r.moved[0].to, null);
  assert.ok(fs.existsSync(path.join(env.videoDir, 'none.mp4')));
  assert.ok(!fs.existsSync(env.reviewDir));
});

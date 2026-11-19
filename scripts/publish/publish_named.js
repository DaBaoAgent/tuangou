#!/usr/bin/env node
// 指定成片插队发布：宝哥点名「先发某某」时用。和 run_due 的区别只有一点——成片由人指定，不走评分。
// 仍然照全套闸门走：字幕放行（subtitle_approved 三指纹）、品牌可信、同品牌冷却/每日上限、文案质量。
// 用法：
//   node scripts/publish/publish_named.js "比格披萨-双人自助餐-03.mp4"            # 真发
//   node scripts/publish/publish_named.js "比格披萨-双人自助餐-03.mp4" --dry-run  # 只做页面预检
//   node scripts/publish/publish_named.js "xxx.mp4" --force                       # 跳过品牌冷却（慎用，宝哥明示才给）
// 记账：占用当天最早的一个 pending 档位（改 status=published、写 published_at/位置/商品/moved_to），
// 发成功同时归档到 已发成片、写 state.history；点过发布但结果不明则转 pending_verify 并改名待核实。
const fs = require('fs');
const path = require('path');
const L = require('./lib');
const SG = require('./subtitle_gate');
const QS = require('./queue_score');

function log(msg) {
  const dir = path.join(L.CONFIG.paths.work_dir, 'logs');
  L.ensureDir(dir);
  fs.appendFileSync(path.join(dir, `${L.todayStr()}.log`), `[${new Date().toISOString()}] [named] ${msg}\n`);
  console.log(msg);
}

function moveToPublished(src) {
  const destDir = L.ensureDir(L.CONFIG.paths.published_dir);
  let dest = path.join(destDir, path.basename(src));
  if (fs.existsSync(dest)) {
    const ext = path.extname(src);
    dest = path.join(destDir, `${path.basename(src, ext)}_${Date.now()}${ext}`);
  }
  fs.renameSync(src, dest);
  return dest;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const fileArg = args.find((a) => a.toLowerCase().endsWith('.mp4'));
  if (!fileArg) {
    console.error('用法：node scripts/publish/publish_named.js "<成片名>.mp4" [--dry-run] [--force]');
    process.exit(2);
  }
  const base = path.basename(fileArg);
  const state = L.loadState();
  if (state.paused && !dryRun) {
    console.error(`发布已暂停（${state.paused_reason || 'unknown'}），先人工恢复再发`);
    process.exit(3);
  }
  const videos = L.inspectVideos();
  const video = videos.find((v) => v.file === base);
  if (!video) {
    console.error(`队列里找不到 ${base}（可能已发布或不在 已剪成片）`);
    process.exit(2);
  }

  // 闸门 1：字幕必须已放行（外线成片走 subtitle_approved 三指纹）
  if (!SG.confirmed(video)) {
    console.error(`字幕未确认，拒发：${base}`);
    process.exit(4);
  }
  // 闸门 2：品牌必须确认
  if (!L.brandConfirmed(video)) {
    console.error(`品牌未确认，拒发：${base}（brand=${video.brand} conf=${video.brand_confidence}）`);
    process.exit(4);
  }
  // 闸门 3：同品牌冷却 + 每日上限
  if (!force) {
    const usage = L.brandUsage(L.todayStr());
    const rhythm = QS.filterBrandRhythm([video], usage, {
      cooldownMinutes: L.CONFIG.schedule.brand_cooldown_minutes,
      dailyCap: L.CONFIG.schedule.brand_daily_cap,
      now: Date.now(),
    });
    if (rhythm.blocked.length) {
      const b = rhythm.blocked[0];
      console.error(`品牌节奏不允：${b.brand} ${b.reason}${b.next_at ? `，最早 ${b.next_at}` : ''}`);
      process.exit(5);
    }
  }
  // 闸门 4：文案质量
  const copy = L.buildCopy({ ...video, brand_topic: video.brand_verified }, state);
  if (!L.copyClean(copy)) {
    console.error(`文案质量不达标，拒发：${copy.title}`);
    process.exit(6);
  }
  console.log('VIDEO', video.file, '| BRAND', video.brand, '| TITLE', copy.title);
  if (dryRun) {
    const { publishOne } = require('./publish_one');
    const r = await publishOne({ ...video, locationBrand: video.brand }, copy, { headless: true, dryRun: true });
    console.log('DRY_RUN', JSON.stringify(r));
    return;
  }

  const date = L.todayStr();
  const plan = L.ensurePlan(date, { save: true });
  const item = plan.items.find((i) => i.status === 'pending') || null;

  const { publishOne } = require('./publish_one');
  let result;
  try {
    result = await publishOne({ ...video, locationBrand: video.brand }, copy, { headless: true, dryRun: false });
  } catch (e) {
    result = { ok: false, reason: 'error', error: e.message };
  }

  if (result.ok) {
    const slot = item || { id: `${date}-named`, at: null };
    Object.assign(slot, {
      status: 'published',
      video: video.file,
      brand: video.brand,
      brand_uncertain: false,
      brand_topic_skipped: !video.brand_verified,
      copy: { title: copy.title, desc: copy.desc, topics: copy.topics, product: copy.product || null },
      category: copy.category || null,
      published_at: new Date().toISOString(),
      work_id: result.workId || null,
      location: result.loc || null,
      product: result.product || null,
      reason: 'named',
    });
    if (!item) plan.items.push(slot);
    let movedTo = null;
    try { movedTo = moveToPublished(video.path); } catch (e) { log(`归档失败：${e.message}`); }
    slot.moved_to = movedTo;
    state.history.push({
      date, file: video.file, at: slot.published_at,
      work_id: result.workId || null, title: copy.title, brand: video.brand || null,
    });
    state.used_title_suffix = [...(state.used_title_suffix || []), copy.title.split('，').pop()].slice(-20);
    L.saveState(state);
    L.savePlan(date, plan);
    log(`PUBLISH_OK ${video.file} work_id=${result.workId} product=${result.product && result.product.ok ? result.product.selected : 'none'}`);
    console.log('RESULT', JSON.stringify({ ok: true, workId: result.workId, movedTo, item: slot.id }));
    return;
  }

  if (result.clickedPublish || result.reason === 'publish-result-unknown') {
    if (item) {
      item.status = 'pending_verify';
      item.reason = result.reason || 'publish-result-unknown';
      L.savePlan(date, plan);
    }
    state.excluded_videos = [...new Set([...(state.excluded_videos || []), video.file])];
    L.saveState(state);
    console.log('RESULT', JSON.stringify({ ok: false, reason: 'publish-result-unknown', note: '点过发布，已移出自动队列，需人工核实' }));
    return;
  }

  if (result.reason === 'auth' || result.reason === 'captcha') {
    state.paused = true;
    state.paused_reason = result.reason === 'auth' ? '登录失效，需要重新扫码' : '遇到验证码/安全校验';
    L.saveState(state);
  }
  console.log('RESULT', JSON.stringify({ ok: false, reason: result.reason, error: result.error || null }));
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

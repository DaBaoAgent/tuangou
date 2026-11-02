#!/usr/bin/env node
// 定时入口：每 5 分钟由 Windows 计划任务调用，最多发布 1 条到期作品。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const L = require('./lib');

const LOCK = path.join(L.CONFIG.paths.work_dir, 'run.lock');

function log(line) {
  const dir = path.join(L.CONFIG.paths.work_dir, 'logs');
  L.ensureDir(dir);
  const p = path.join(dir, `${L.todayStr()}.log`);
  fs.appendFileSync(p, `[${new Date().toISOString()}] ${line}\n`);
  console.log(line);
}

function notify(title, msg) {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'notify.ps1'), '-Title', title, '-Message', msg], { timeout: 15000 });
  } catch (e) { log(`notify failed: ${e.message}`); }
}

function wechat(text) {
  const r = L.pushWeChat(text);
  if (!r.ok) log(`wechat push failed: ${r.error}`);
}

function acquireLock() {
  if (fs.existsSync(LOCK)) {
    const st = fs.statSync(LOCK);
    if (Date.now() - st.mtimeMs < 30 * 60 * 1000) return false;
    fs.unlinkSync(LOCK);
  }
  fs.writeFileSync(LOCK, String(process.pid));
  return true;
}
function releaseLock() { try { fs.unlinkSync(LOCK); } catch {} }

function moveToPublished(file) {
  const destDir = L.ensureDir(L.CONFIG.paths.published_dir);
  let dest = path.join(destDir, path.basename(file));
  if (fs.existsSync(dest)) {
    const ext = path.extname(file);
    dest = path.join(destDir, `${path.basename(file, ext)}_${Date.now()}${ext}`);
  }
  fs.renameSync(file, dest);
  return dest;
}

// 点击发布后结果未知：移出自动队列（加 _ 前缀），避免下一条计划重复发同一个成片
function markUnverified(file) {
  try {
    const dest = path.join(path.dirname(file), `_unverified_${path.basename(file)}`);
    fs.renameSync(file, dest);
    return dest;
  } catch { return null; }
}

// 改名失败时把成片写进 state 排除表；pickVideo 会读取，防止它留在队列里被再次发布
function excludeVideo(state, file) {
  const dest = markUnverified(file);
  if (!dest) {
    const base = path.basename(file);
    state.excluded_videos = [...new Set([...(state.excluded_videos || []), base])];
    L.saveState(state);
    log(`WARN cannot rename ${base}, added to excluded_videos`);
  }
  return dest;
}

function spawnPrepare() {
  try {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [path.join(__dirname, 'prepare.js')], { detached: true, stdio: 'ignore', cwd: L.ROOT });
    child.unref();
    log('spawned prepare');
  } catch (e) { log('spawn prepare failed: ' + e.message); }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const state = L.loadState();
  if (state.paused) { log(`PAUSED: ${state.paused_reason}`); return; }
  if (!acquireLock()) { log('lock busy, skip'); return; }
  try {
    const date = L.todayStr();
    // dry-run 不落盘计划，避免只做检查也产生副作用
    const plan = L.ensurePlan(date, { save: !dryRun });
    if (plan.status !== 'active') { log(`plan ${date} status=${plan.status}`); return; }

    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const endMin = L.minutesOf(L.CONFIG.schedule.window.end);

    for (const item of plan.items) {
      // 旧版本把缺库存的条目永久标成 blocked，这里恢复成可重试
      if (item.status === 'blocked' && item.reason === 'no available video') item.status = 'pending';
      if (item.status !== 'pending') continue;
      if (L.minutesOf(item.at) < nowMin - 180) item.status = 'skipped';
    }

    const due = plan.items
      .filter(i => i.status === 'pending' && L.minutesOf(i.at) <= nowMin)
      .sort((a, b) => L.minutesOf(a.at) - L.minutesOf(b.at));
    if (!due.length) {
      if (!dryRun) L.savePlan(date, plan);
      return;
    }
    if (nowMin > endMin + 30) {
      for (const i of due) i.status = 'skipped';
      if (!dryRun) L.savePlan(date, plan);
      log('past window, skipped due items');
      return;
    }

    const item = due[0];
    const videos = L.pickVideo();
    if (!videos.length) {
      if (dryRun) { log('DRY_RUN no video in inventory'); return; }
      item.status = 'pending';
      item.reason = 'no available video';
      L.savePlan(date, plan);
      // 补货请求每小时最多一次，避免每 5 分钟重复通知
      const lastReq = item.prepare_requested_at ? Date.parse(item.prepare_requested_at) : 0;
      if (Date.now() - lastReq > 60 * 60 * 1000) {
        item.prepare_requested_at = new Date().toISOString();
        log('no video in inventory, triggering prepare');
        spawnPrepare();
        notify('团购发布等素材', '已剪成片库存为空，正在自动剪辑补货');
        wechat('⚠️ 团购发布等素材\n已剪成片库存为空，正在自动剪辑补货');
        L.savePlan(date, plan);
      }
      return;
    }
    // 品牌必须确认：无品牌、needs_review、或置信度低于阈值一律跳过，绝不猜品牌发布。
    // 宝哥 2026-11-02：品牌不确定要联网核验，仍不确定就停下来跳过。
    // 文案明显是 ASR 乱码的成片跳过，避免把「特大粪」之类发出去。
    const minConf = L.CONFIG.publish.brand_min_confidence ?? 0.9;
    const rank = v => (v.brand && v.brand_verified && !v.brand_needs_review) ? 0
      : v.brand_needs_review ? 3 : 1;
    // 先按品牌可信度分拣：不确定的全部跳过并记录，再从上一条开始找能发的
    const sorted = [...videos].sort((a, b) => rank(a) - rank(b));
    const brandConfident = v => !!v.brand && !v.brand_needs_review &&
      (v.brand_verified || v.brand_confidence >= minConf);
    const skippedBrandFiles = sorted.filter(v => !brandConfident(v)).map(v => v.file);
    const skippedBrand = skippedBrandFiles.length;
    for (const v of sorted) if (!brandConfident(v)) {
      log(`skip ${v.file}: brand unconfirmed (${v.brand || 'none'} conf=${v.brand_confidence})`);
    }
    let picked = null;
    let skippedCopy = 0;
    for (const v of sorted.filter(brandConfident)) {
      // 未认证品牌不挂品牌话题，但门店仍按识别出的品牌添加（宝哥 2026-11-02 要求）
      const brandUncertain = !v.brand_verified;
      const publishVideo = brandUncertain ? { ...v, brand: null, locationBrand: v.brand } : v;
      const copy = L.buildCopy(publishVideo, state);
      if (!L.copyClean(copy)) { skippedCopy++; log(`skip ${v.file}: copy quality low | ${copy.title}`); continue; }
      picked = { video: v, publishVideo, copy, brandUncertain };
      break;
    }
    if (!picked) {
      if (dryRun) { log('DRY_RUN no publishable video in inventory'); return; }
      item.status = 'pending';
      item.reason = skippedBrand ? 'brand unconfirmed' : 'copy quality low';
      const notifiedAt = skippedBrand ? item.brand_notified_at : item.quality_notified_at;
      const lastQ = notifiedAt ? Date.parse(notifiedAt) : 0;
      if (Date.now() - lastQ > 60 * 60 * 1000) {
        if (skippedBrand) {
          const names = skippedBrandFiles.slice(0, 3).join('、') + (skippedBrandFiles.length > 3 ? ' 等' : '');
          item.brand_notified_at = new Date().toISOString();
          log('brand unconfirmed, publish skipped');
          notify('团购发布等待品牌确认', `${skippedBrand} 条成片品牌不确定，已跳过：${names}`);
          wechat(`⚠️ 团购发布等待品牌确认\n已跳过 ${skippedBrand} 条品牌不确定的成片：${names}\n（无品牌/待复核/置信度不足，未发布、未猜品牌）\n请人工审核确认品牌后告诉我再发；下次会先发能确定品牌的`);
        } else {
          item.quality_notified_at = new Date().toISOString();
          log('no clean copy in inventory, publish skipped');
          notify('团购发布等待文案', '成片口播识别质量不足，已跳过本轮');
          wechat('⚠️ 团购发布等待文案\n库存成片口播识别质量不足，已跳过本轮；请人工检查');
        }
      }
      L.savePlan(date, plan);
      return;
    }
    const { video, publishVideo, copy, brandUncertain } = picked;
    item.video = video.file;
    // 这里 brandUncertain 只表示「未认证、不挂品牌话题」；品牌是否可信已在上面的闸门确认
    item.brand = video.brand;
    item.brand_uncertain = false;
    item.brand_topic_skipped = brandUncertain;
    item.copy = { title: copy.title, desc: copy.desc, topics: copy.topics };
    if (!dryRun) L.savePlan(date, plan);
    log(`publishing ${video.file} | ${copy.title}`);

    const { publishOne } = require('./publish_one');
    let result;
    try {
      result = await publishOne(publishVideo, copy, { headless: true, dryRun });
    } catch (e) {
      result = { ok: false, reason: 'error', error: e.message };
    }

    // 干跑只走页面预检，绝不写发布状态、不归档、不发通知、不拉起剪辑
    if (dryRun || result.dryRun) {
      log(`DRY_RUN ${video.file} | ${copy.title} | ${JSON.stringify(result)}`);
      return;
    }

    if (result.ok) {
      item.status = 'published';
      item.published_at = new Date().toISOString();
      item.work_id = result.workId || null;
      item.location = result.loc || null;
      // 发布已成功，归档失败不能导致重发：只记日志，作品仍计入历史
      try { item.moved_to = moveToPublished(video.path); }
      catch (e) { item.moved_to = null; log(`archive failed: ${e.message}`); }
      state.history.push({
        date, file: video.file, at: item.published_at,
        work_id: result.workId || null, title: copy.title,
      });
      state.used_title_suffix = [...(state.used_title_suffix || []), copy.title.split('，').pop()].slice(-20);
      L.saveState(state);
      L.savePlan(date, plan);
      log(`PUBLISH_OK ${video.file} work_id=${result.workId}`);
      const skipNames = skippedBrandFiles.slice(0, 3).join('、') + (skippedBrandFiles.length > 3 ? ' 等' : '');
      const skipLine = skippedBrand ? `\n⏭️ 跳过 ${skippedBrand} 条品牌不确定的成片待人工审核：${skipNames}` : '';
      notify('团购发布成功', `${video.file} 已发布${skippedBrand ? `；跳过 ${skippedBrand} 条品牌待确认` : ''}`);
      const storeLine = result.loc && result.loc.ok ? `\n门店：${result.loc.selected}` : '\n⚠️ 未挂上门店';
      wechat(`✅ 抖音已发布\n${copy.title}\n成片：${video.file}${storeLine}${result.workId ? `\n作品ID：${result.workId}` : ''}${skipLine}`);
    } else if (result.clickedPublish || result.reason === 'publish-result-unknown') {
      // reason 本身就说明发布点击已发生；即使上层忘了带 clickedPublish 也不能重试
      // 已经点过「发布」：不管是验证码、登录失效还是结果未知，都可能已经发出去，
      // 一律按「结果待核实」处理并移出队列，绝不自动重试（否则会重复发布）
      item.status = 'pending_verify';
      item.reason = result.reason || 'publish-result-unknown';
      item.marked_unverified_to = excludeVideo(state, video.path);
      L.savePlan(date, plan);
      log(`PUBLISH_UNKNOWN ${video.file} 点击发布后未确认（${item.reason}），已移出自动队列`);
      notify('团购发布结果待核实', `${video.file} 点击发布后未收到确认，请人工核实`);
      wechat(`⚠️ 抖音发布结果待核实\n成片：${video.file}\n已点击发布但页面未确认（${item.reason}），未自动重试；请到内容管理人工核实`);
      if (result.reason === 'auth' || result.reason === 'captcha') {
        state.paused = true;
        state.paused_reason = result.reason === 'auth' ? '登录失效，需要重新扫码' : '遇到验证码/安全校验';
        L.saveState(state);
        log(`PAUSE ${state.paused_reason}`);
        notify('团购发布已暂停', state.paused_reason);
        wechat(`⛔ 抖音发布已暂停\n${state.paused_reason}\n请在电脑上重新扫码登录后恢复`);
      }
    } else if (result.reason === 'auth' || result.reason === 'captcha') {
      // 还没点发布就遇到验证码/登录失效：成片可以留队，恢复后原样再发
      state.paused = true;
      state.paused_reason = result.reason === 'auth' ? '登录失效，需要重新扫码' : '遇到验证码/安全校验';
      L.saveState(state);
      item.status = 'pending';
      item.reason = result.reason;
      L.savePlan(date, plan);
      log(`PAUSE ${state.paused_reason}`);
      notify('团购发布已暂停', state.paused_reason);
      wechat(`⛔ 抖音发布已暂停\n${state.paused_reason}\n请在电脑上重新扫码登录后恢复`);
    } else if (result.reason === 'verify-failed') {
      // 已发布但审核不通过：不重发，移出队列交人工处理
      item.status = 'rejected';
      item.reason = 'verify-failed';
      item.status_detail = result.status || null;
      item.marked_unverified_to = excludeVideo(state, video.path);
      L.savePlan(date, plan);
      log(`PUBLISH_REJECTED ${video.file} status=${result.status}`);
      notify('团购作品审核不通过', `${video.file} 已发布但审核不通过，已移出队列`);
      wechat(`❌ 抖音作品审核不通过\n成片：${video.file}\n已移出自动队列，请人工检查`);
    } else {
      item.retries = (item.retries || 0) + 1;
      item.reason = result.reason || result.error || 'unknown';
      item.status = item.retries >= L.CONFIG.publish.max_retries ? 'failed' : 'pending';
      L.savePlan(date, plan);
      log(`PUBLISH_FAIL ${video.file} ${item.reason}`);
      if (item.status === 'failed') {
        wechat(`❌ 抖音发布失败\n成片：${video.file}\n原因：${item.reason}\n已重试 ${item.retries} 次，可在电脑上查看截图`);
      }
    }
  } finally {
    releaseLock();
  }
}

main().catch(e => { log('FATAL ' + e.stack); process.exit(1); });

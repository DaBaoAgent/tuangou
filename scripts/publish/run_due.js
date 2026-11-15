#!/usr/bin/env node
// 定时入口：每 5 分钟由 Windows 计划任务调用，最多发布 1 条到期作品。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const L = require('./lib');
const SG = require('./subtitle_gate');
const A = require('./analytics');
const QS = require('./queue_score');

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


// 字幕待人工确认 / OCR 不可用每小时最多提醒一次，避免每轮计划刷屏
function noticeOnce(key, title, msg, hours = 1) {
  const p = path.join(L.CONFIG.paths.work_dir, 'subtitle_notice.json');
  const d = L.readJson(p, {});
  const last = d[key] ? Date.parse(d[key]) : 0;
  if (Date.now() - last < hours * 60 * 60 * 1000) return false;
  d[key] = new Date().toISOString();
  L.writeJson(p, d);
  notify(title, msg);
  return true;
}

// A2/A7（2026-11-08）：锁里写 pid，先看 pid 是否存活；持锁方每 60 秒刷 mtime 当心跳。
// 只有「进程真没了」或「心跳真过期」才允许接管，避免上一轮还在跑就被判过期、同一成片发两次。
const LOCK_TTL_MS = Math.max(60, Number(L.CONFIG.publish.lock_ttl_sec ?? 1800)) * 1000;
let heartbeatTimer = null;
function acquireLock() {
  if (fs.existsSync(LOCK)) {
    let owner = 0;
    try { owner = Number(String(fs.readFileSync(LOCK, 'utf8')).trim()) || 0; } catch {}
    const alive = owner > 0 && L.isPidAlive(owner);
    let fresh = false;
    try { fresh = Date.now() - fs.statSync(LOCK).mtimeMs < LOCK_TTL_MS; } catch {}
    if (alive || fresh) {
      log(`lock busy, skip (pid=${owner || '?'} alive=${alive} fresh=${fresh})`);
      return false;
    }
    log(`stale run lock (pid=${owner || '?'} dead), taking over`);
    try { fs.unlinkSync(LOCK); } catch {}
  }
  fs.writeFileSync(LOCK, String(process.pid));
  heartbeatTimer = setInterval(() => { try { const now = new Date(); fs.utimesSync(LOCK, now, now); } catch {} }, 60000);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
  return true;
}
function releaseLock() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  try { fs.unlinkSync(LOCK); } catch {}
}

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

// B4（2026-11-08）：改名逻辑收进 lib，prepare 与 run_due 共用一份
function renameAll(dryRun) { L.renameAll(dryRun, log); }

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const state = L.loadState();
  if (!acquireLock()) { log('lock busy, skip'); return; }
 renameAll(process.argv.includes('--dry-run'));
  try {
    // 品牌不能确认的成片直接移到「品牌待确认」，不留在自动发布队列（宝哥 2026-11-04 固化）
    // 暂停状态下也先执行，避免品牌未确认的成片一直堆在待发目录
    const q = L.quarantineUnconfirmed({ dryRun });
    if (q.moved.length) {
      for (const m of q.moved) log(`quarantine ${m.file}: ${m.reason}${m.to ? ` -> ${m.to}` : ' (dry-run)'}`);
      if (!dryRun) {
        const names = q.moved.slice(0, 5).map(m => m.file).join('、') + (q.moved.length > 5 ? ' 等' : '');
        notify('团购成片移入品牌待确认', `${q.moved.length} 条品牌未确认：${names}`);
      }
    }

    // 字幕闸门（宝哥 2026-11-04 固化）：新成片先 OCR 复核，失败移入「字幕待修复」，
    // 没有校对依据的手工新片暂缓发布。暂停状态下也继续扫描，避免坏字幕堆积。
    // B（2026-11-08 宝哥要求）：缺 meta 但文件名能定品牌的成片，记一条审计（不伪造 meta.json）
    if (!dryRun) {
      try {
        const legacy = L.auditLegacyNoMeta();
        if (legacy.length) log(`legacy_no_meta in queue: ${legacy.length}`);
      } catch (e) { log('audit legacy_no_meta failed: ' + e.message); }
    }

    const sub = SG.auditInventory({ dryRun });
    if (sub.audited || sub.moved.length || sub.manual.length || sub.unavailable.length) {
      log(`subtitle audit: checked=${sub.audited} cached=${sub.cached} moved=${sub.moved.length}`
        + ` manual=${sub.manual.length} unavailable=${sub.unavailable.length}`);
    }
    if (!dryRun) {
      if (sub.moved.length) {
        const names = sub.moved.slice(0, 5).map(m => m.file).join('、') + (sub.moved.length > 5 ? ' 等' : '');
        notify('团购成片字幕待修复', `${sub.moved.length} 条字幕复核失败：${names}`);
      }
      if (sub.manual.length) {
        const names = sub.manual.slice(0, 5).map(m => m.file).join('、') + (sub.manual.length > 5 ? ' 等' : '');
        noticeOnce('manual', '团购新成片待字幕确认',
          `⚠️ 团购新成片待字幕确认\n${sub.manual.length} 条缺少字幕校对稿，已暂缓自动发布：${names}`);
      }
      if (sub.unavailable.length) {
        noticeOnce('unavailable', '字幕审计服务不可用',
          `⚠️ 字幕审计服务不可用\n${sub.unavailable.length} 条新成片暂时无法复核字幕，已暂缓自动发布`);
      }
    }

    if (state.paused) { log(`PAUSED: ${state.paused_reason}`); return; }

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
    const allVideos = L.pickVideo();
    // 字幕未确认的新片不进发布队列；库存里还有别的可发片时继续发别的
    const videos = allVideos.filter(v => SG.confirmed(v));
    const subtitleBlocked = allVideos.filter(v => !SG.confirmed(v));
    if (!videos.length && subtitleBlocked.length) {
      if (dryRun) { log(`DRY_RUN no subtitle-confirmed video (${subtitleBlocked.length} blocked)`); return; }
      item.status = 'pending';
      item.reason = 'subtitle unverified';
      L.savePlan(date, plan);
      const names = subtitleBlocked.slice(0, 3).map(v => v.file).join('、') + (subtitleBlocked.length > 3 ? ' 等' : '');
      log(`subtitle unverified, publish skipped (${subtitleBlocked.length})`);
      noticeOnce('blocked', '团购发布等待字幕确认',
        `⚠️ 团购发布等待字幕确认\n${subtitleBlocked.length} 条成片字幕未确认，已跳过：${names}`);
      return;
    }
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
        L.savePlan(date, plan);
      }
      return;
    }
    // 品牌必须确认：无品牌、needs_review、或置信度低于阈值一律跳过，绝不猜品牌发布。
    // 宝哥 2026-11-02：品牌不确定要联网核验，仍不确定就停下来跳过。
    // 文案明显是 ASR 乱码的成片跳过，避免把「特大粪」之类发出去。
    const priorityBrands = L.CONFIG.publish.priority_brands || [];
    // 2026-11-10：用账号播放/出单数据给库存打分（品牌历史表现 + 品类质量 + 库存新鲜度），
    // 数据缺失时自动退化成「优先品牌 + 品牌可信度」的旧顺序，不影响发布
    const statsPaths = A.statsPaths(L.ROOT, L.CONFIG);
    const loaded = A.loadAnalytics(statsPaths);
    // 样本太少时打分噪声大于信号，直接退回旧顺序
    const analytics = loaded && loaded.count >= 10 ? loaded : null;
    const orders = A.loadOrders(statsPaths);
    const mtimeOf = v => { try { return fs.statSync(v.path).mtimeMs; } catch { return null; } };
    const sorted = QS.rankVideos(videos, {
      analytics, orders, priorityBrands, now: Date.now(), mtimeOf,
      weights: L.CONFIG.publish.queue_weights || {},
    });
    if (analytics) {
      log(`queue scored by analytics ${analytics.count} works | top=${sorted[0] ? `${sorted[0].file}(${sorted[0].queue_score})` : 'none'}`);
    }
    const brandConfident = L.brandConfirmed;
    const skippedBrandFiles = sorted.filter(v => !brandConfident(v)).map(v => v.file);
    const skippedBrand = skippedBrandFiles.length;
    for (const v of sorted) if (!brandConfident(v)) {
      log(`skip ${v.file}: brand unconfirmed (${v.brand || 'none'} conf=${v.brand_confidence})`);
    }
    // 2026-11-11（宝哥拍板）：同品牌冷却 + 每日上限，挡住「一天七条鸡柳大人」式连发
    const usage = L.brandUsage(date);
    const rhythm = QS.filterBrandRhythm(sorted.filter(brandConfident), usage, {
      cooldownMinutes: L.CONFIG.schedule.brand_cooldown_minutes,
      dailyCap: L.CONFIG.schedule.brand_daily_cap,
      now: Date.now(),
    });
    for (const b of rhythm.blocked) {
      log(`skip ${b.video.file}: brand rhythm ${b.reason} (${b.brand})${b.next_at ? ` next=${b.next_at}` : ''}`);
    }
    let picked = null;
    let skippedCopy = 0;
    for (const v of rhythm.kept) {
      // 未认证品牌不挂品牌话题，但门店仍按识别出的品牌添加（宝哥 2026-11-02 要求）；
      // 2026-11-15 宝哥补充：品牌名不许从标题/描述里丢掉，只挡话题（brand_topic=false）。
      const brandUncertain = !v.brand_verified;
      const publishVideo = brandUncertain
        ? { ...v, brand_topic: false, locationBrand: v.brand }
        : { ...v, locationBrand: v.brand };
      const copy = L.buildCopy(publishVideo, state);
      if (!L.copyClean(copy)) { skippedCopy++; log(`skip ${v.file}: copy quality low | ${copy.title}`); continue; }
      picked = { video: v, publishVideo, copy, brandUncertain };
      break;
    }
    if (!picked) {
      if (dryRun) { log('DRY_RUN no publishable video in inventory'); return; }
      const rhythmBlocked = !skippedBrand && rhythm.blocked.length > 0;
      item.status = 'pending';
      item.reason = rhythmBlocked ? 'brand rhythm' : skippedBrand ? 'brand unconfirmed' : 'copy quality low';
      const notifiedAt = skippedBrand ? item.brand_notified_at
        : rhythmBlocked ? item.rhythm_notified_at : item.quality_notified_at;
      const lastQ = notifiedAt ? Date.parse(notifiedAt) : 0;
      if (Date.now() - lastQ > 60 * 60 * 1000) {
        if (skippedBrand) {
          const names = skippedBrandFiles.slice(0, 3).join('、') + (skippedBrandFiles.length > 3 ? ' 等' : '');
          item.brand_notified_at = new Date().toISOString();
          log('brand unconfirmed, publish skipped');
          notify('团购发布等待品牌确认', `${skippedBrand} 条成片品牌不确定，已跳过：${names}`);
        } else if (rhythmBlocked) {
          const brands = [...new Set(rhythm.blocked.map(b => b.brand))].slice(0, 3).join('、');
          item.rhythm_notified_at = new Date().toISOString();
          log(`brand rhythm blocked all ${rhythm.blocked.length} videos`);
          notify('团购发布等待品牌冷却',
            `${rhythm.blocked.length} 条成片的品牌在冷却期或已达每日上限：${brands}`);
        } else {
          item.quality_notified_at = new Date().toISOString();
          log('no clean copy in inventory, publish skipped');
          notify('团购发布等待文案', '成片口播识别质量不足，已跳过本轮');
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
    item.copy = { title: copy.title, desc: copy.desc, topics: copy.topics, product: copy.product || null };
    item.category = copy.category || null;
    item.queue_score = video.queue_score ?? null;
    item.queue_why = video.queue_why || null;
    if (!dryRun) L.savePlan(date, plan);
    log(`publishing ${video.file} | ${copy.title} | score=${video.queue_score} (${video.queue_why || '-'})`);

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
      item.product = result.product || null;
      // 发布已成功，归档失败不能导致重发：只记日志，作品仍计入历史
      try { item.moved_to = moveToPublished(video.path); }
      catch (e) { item.moved_to = null; log(`archive failed: ${e.message}`); }
      state.history.push({
        date, file: video.file, at: item.published_at,
        work_id: result.workId || null, title: copy.title,
        // 2026-11-11：历史里补品牌，便于之后核对发布节奏/品牌分布
        brand: video.brand || null,
      });
      state.used_title_suffix = [...(state.used_title_suffix || []), copy.title.split('，').pop()].slice(-20);
      L.saveState(state);
      L.savePlan(date, plan);
      log(`PUBLISH_OK ${video.file} work_id=${result.workId} product=${result.product && result.product.ok ? result.product.selected : 'none'}`);
      const prodLine = result.product && result.product.ok
        ? `\n🛒 团购商品：${result.product.selected}${result.product.price != null ? `（￥${result.product.price}）` : ''}`
        : result.loc && result.loc.ok
          ? `\n📍 门店：${result.loc.selected}（未挂团购商品）`
          : '\n⚠️ 未挂团购商品，也未挂上门店';
      notify('团购发布成功', `${video.file} 已发布${skippedBrand ? `；跳过 ${skippedBrand} 条品牌待确认` : ''}${prodLine}`);
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
      if (result.reason === 'auth' || result.reason === 'captcha') {
        state.paused = true;
        state.paused_reason = result.reason === 'auth' ? '登录失效，需要重新扫码' : '遇到验证码/安全校验';
        L.saveState(state);
        log(`PAUSE ${state.paused_reason}`);
        notify('团购发布已暂停', state.paused_reason);
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
    } else if (result.reason === 'verify-failed') {
      // 已发布但审核不通过：不重发，移出队列交人工处理
      item.status = 'rejected';
      item.reason = 'verify-failed';
      item.status_detail = result.status || null;
      item.marked_unverified_to = excludeVideo(state, video.path);
      L.savePlan(date, plan);
      log(`PUBLISH_REJECTED ${video.file} status=${result.status}`);
      notify('团购作品审核不通过', `${video.file} 已发布但审核不通过，已移出队列`);
    } else {
      item.retries = (item.retries || 0) + 1;
      item.reason = result.reason || result.error || 'unknown';
      item.status = item.retries >= L.CONFIG.publish.max_retries ? 'failed' : 'pending';
      L.savePlan(date, plan);
      log(`PUBLISH_FAIL ${video.file} ${item.reason}`);
      if (item.status === 'failed') {
      }
    }
  } finally {
    releaseLock();
  }
}

main().catch(e => { log('FATAL ' + e.stack); process.exit(1); });

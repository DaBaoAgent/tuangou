#!/usr/bin/env node
'use strict';
// 成片统一改名：品牌名-商品名-序列.mp4
// 品牌优先级：改名覆盖表 > 文件名「品牌：」标注 > 剪辑识别品牌 > 口播/字幕匹配品牌库
// 商品优先级：改名覆盖表 > 剪辑元数据商品 > 口播抽词 > 待确认
const fs = require('fs');
const path = require('path');

// 根目录按本文件位置推导（B1，2026-11-08）：换盘/换目录不用改这里
const ROOT = process.env.TUANGOU_ROOT || path.resolve(__dirname, '..', '..');
const DRY = process.argv.includes('--dry');
const QUIET = process.argv.includes('--quiet');
const log = function(){ if(!QUIET) console.log.apply(console, arguments); };

function readJson(p, d){ try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch(e){ return d; } }
function writeJson(p, v){
 if (DRY) return;
 const tmp = p + '.tmp-' + Date.now();
 fs.writeFileSync(tmp, JSON.stringify(v, null, 2), 'utf8');
 fs.renameSync(tmp, p);
}
function norm(s){ return String(s == null ? '' : s).replace(/[\s\u3000]/g,'').replace(/[【】\[\]（）()「」《》·.,，。:：_\-—|/\\]/g,'').toUpperCase(); }
function coreOf(n){ return n.replace(/\.[^.]+$/,'').replace(/_\d{8,}$/,''); }
function listFiles(dir){ try { return fs.readdirSync(dir).filter(function(f){ return /\.(mp4|mov|mkv)$/i.test(f); }); } catch(e){ return []; } }
function isStable(p, ms){ try { return Date.now() - fs.statSync(p).mtimeMs > (ms || 60000); } catch(e){ return false; } }
function escapeRe(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const CONFIG = readJson(path.join(ROOT,'scripts/publish/config.json'), {});
// config 里的路径是相对项目根的（B1），这里统一还原成绝对路径，不依赖 cwd
const P = {};
for (const k in (CONFIG.paths || {})) {
  const v = CONFIG.paths[k];
  P[k] = (typeof v === 'string' && v && !path.isAbsolute(v)) ? path.join(ROOT, v) : v;
}
const VIDEO_DIR = P.video_dir || path.join(ROOT,'素材库/已剪成片');
const REVIEW_DIR = P.brand_review_dir || path.join(VIDEO_DIR,'品牌待确认');
const INDEX_PATH = P.brand_index || path.join(ROOT,'runtime/auto-edit/brand_index.json');
const WORK_ROOT = P.auto_edit_work || path.join(ROOT,'runtime/auto-edit/work');
const BRANDS_PATH = path.join(ROOT,'scripts/auto-edit/brands.json');
const LOG_PATH = path.join(ROOT,'runtime/rename-log-auto.csv');
const OVERRIDE_PATH = path.join(ROOT,'runtime/rename-overrides.json');

const BRANDS = readJson(BRANDS_PATH, { brands: [] });
const BRAND_LIST = (BRANDS.brands || []).map(function(b){
 return { id: b.id, name: b.name, category: b.category || null, verified: !!b.verified,
 aliases: [b.name].concat(b.aliases || []).filter(function(a){ return a && String(a).length >= 2; }) };
});
const PRODUCT_HINTS = new Set(['双人餐','三人餐','单人餐','五件套','四件套','全家桶','套餐','小食','甜品','零食','自助','炸物三合一','三合一','螺蛳粉','炸鸡','鸡腿','汉堡','烤鱼','火锅','烤肉','奶茶','咖啡','果茶','柠檬茶','美式','拿铁','生椰','冰酿','气泡水','白糯米','羽衣甘蓝','甘蓝','栀子','白柚','柿子','莓果','黄油','代100','代50','代20','代10']);

function learnProducts(){
 const idx = readJson(INDEX_PATH, {});
 Object.keys(idx).forEach(function(k){
 const p = idx[k] && idx[k].product;
 if (p && String(p).length >= 2 && String(p).length <= 12) PRODUCT_HINTS.add(String(p));
 });
 listFiles(VIDEO_DIR).forEach(function(f){
 const m = /^[^-]+-(.+)-\d{2}\.mp4$/i.exec(f);
 if (m && m[1] !== '待确认') PRODUCT_HINTS.add(m[1]);
 });
}
function brandIdOf(name){
 const hit = BRAND_LIST.find(function(b){ return b.name === name; });
 if (hit && hit.id) return hit.id;
 return 'brand_' + Buffer.from(name,'utf8').toString('hex').slice(0,12);
}
function matchBrand(text){
 const t = norm(text);
 if (!t) return null;
 let best = null;
 BRAND_LIST.forEach(function(b){
 b.aliases.forEach(function(a){
 const na = norm(a);
 if (na.length >= 2 && t.indexOf(na) >= 0 && (!best || na.length > best.len)) best = { name: b.name, len: na.length, verified: b.verified };
 });
 });
 return best;
}
function labelOf(base){
 const m = /^(.{2,20}?)[：:]\s*/.exec(base);
 if (!m) return null;
 const lb = m[1].trim();
 if (/^\d/.test(lb) || /月\d+日|\d{4}-\d{2}-\d{2}/.test(lb)) return null;
 return lb;
}
function productFromText(text){
 const t = norm(text);
 if (!t) return null;
 const found = [];
 PRODUCT_HINTS.forEach(function(h){
 const nh = norm(h);
 if (nh.length >= 2 && t.indexOf(nh) >= 0) found.push(h);
 });
 if (!found.length) return null;
 if (t.indexOf(norm('白糯米')) >= 0 && t.indexOf(norm('甘蓝')) >= 0) return '羽衣甘蓝白糯米';
 found.sort(function(a,b){ return b.length - a.length; });
 const first = found[0];
 const second = found.slice(1).find(function(x){ return !norm(first).includes(norm(x)) && !norm(x).includes(norm(first)); });
 let name = first;
 if (second && norm(first).length + norm(second).length <= 10) name = first + second;
 return name.length > 14 ? first : name;
}
function buildMetaIndex(){
 const out = [];
 let dirs = [];
 try {
 const parent = path.dirname(WORK_ROOT);
 const cands = [];
 fs.readdirSync(parent).forEach(function(x){ cands.push(path.join(parent, x)); });
 fs.readdirSync(WORK_ROOT).forEach(function(x){ cands.push(path.join(WORK_ROOT, x)); });
 fs.readdirSync(parent).forEach(function(x){ const p1 = path.join(parent, x); try { fs.readdirSync(p1).forEach(function(y){ cands.push(path.join(p1, y)); }); } catch(e2){} });
 dirs = cands;
 } catch(e){ dirs = []; }
 dirs.forEach(function(d){
 const dirPath = path.isAbsolute(d) ? d : path.join(WORK_ROOT, d);
 let st = null;
 try { st = fs.statSync(dirPath); } catch(e){ return; }
 if (!st.isDirectory()) return;
 const mp = path.join(dirPath,'meta.json');
 const has = fs.existsSync(mp);
 const m = has ? (readJson(mp, {}) || {}) : {};
 out.push({ dir: path.basename(dirPath), dirPath: dirPath, m: m, metaPath: has ? mp : null });
 });
 return out;
}
function findHit(metas, base){
 const core = coreOf(base);
 const exact = metas.find(function(x){ return x.m && x.m.output && path.basename(x.m.output) === base; });
 if (exact) return exact;
 const soft = metas.find(function(x){ return x.m && x.m.output && coreOf(path.basename(x.m.output)) === core; });
 if (soft) return soft;
 const byDir = metas.find(function(x){ return x.dir.length >= 12 && base.indexOf(x.dir) >= 0; });
 return byDir || null;
}
function asrTextOf(hit){
 const asr = readJson(path.join(hit.dirPath,'asr.json'), null);
 if (!asr) return '';
 if (Array.isArray(asr)) return asr.map(function(x){ return (x && x.text) || ''; }).join('');
 return '';
}
function linesTextOf(meta){ return ((meta && meta.lines) || []).map(function(l){ return l && l.text; }).filter(Boolean).join(''); }

function nextOrd(brand, product, taken){
 const re = new RegExp('^' + escapeRe(brand + '-' + product + '-') + '(\\d{2})\\.mp4$', 'i');
 let max = 0;
 listFiles(VIDEO_DIR).forEach(function(f){
 const m = re.exec(f);
 if (m) max = Math.max(max, parseInt(m[1],10));
 });
 let n = max + 1;
 while (taken.has(brand + '-' + product + '-' + String(n).padStart(2,'0'))) n++;
 return n;
}
function appendLog(rows){
 if (!rows.length || DRY) return;
 const body = rows.map(function(r){ return [new Date().toISOString(), r.action, r.old, r.new, r.brand, r.product, r.source].join('|'); }).join('\n') + '\n';
 try {
 if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, 'time|action|old|new|brand|product|source\n' + body, 'utf8');
 else fs.appendFileSync(LOG_PATH, body, 'utf8');
 } catch(e){}
}

function main(){
 learnProducts();
 const metas = buildMetaIndex();
 const overrides = readJson(OVERRIDE_PATH, {}) || {};
 const index = readJson(INDEX_PATH, {});
 const taken = new Set();
 const rows = [];
 const unresolved = [];
 let renamed = 0, moved = 0, skipped = 0;

 const jobs = [];
 listFiles(REVIEW_DIR).forEach(function(f){ jobs.push({ dir: REVIEW_DIR, base: f, fromReview: true }); });
 listFiles(VIDEO_DIR).forEach(function(f){ jobs.push({ dir: VIDEO_DIR, base: f, fromReview: false }); });

 for (const job of jobs){
 const base = job.base;
 if (/^_/.test(base) || /^审核样片/.test(base)) { skipped++; continue; }
 const src = path.join(job.dir, base);
 if (!isStable(src, 60000)) { skipped++; continue; }
 const stem = base.replace(/\.[^.]+$/,'');
 if (!job.fromReview && /^.+?-.+?-\d{2}$/.test(stem) && index[stem]) { skipped++; continue; }

 const hit = findHit(metas, base);
 const ov = overrides[base] || overrides[stem] || null;
 const label = labelOf(base);
 const metaBrand = hit && hit.m && hit.m.brand && hit.m.brand.brand ? hit.m.brand : null;
 const allText = (hit ? asrTextOf(hit) : '') + ' ' + (hit ? linesTextOf(hit.m) : '') + ' ' + stem + ' ' + (label || '');

 let brand = null, source = null, confidence = 0;
 if (ov && ov.brand) { brand = ov.brand; source = 'override'; confidence = 0.99; }
 else if (label) {
 const known = BRAND_LIST.find(function(b){ return norm(b.name) === norm(label) || b.aliases.some(function(a){ return norm(a) === norm(label); }); });
 brand = known ? known.name : label;
 source = 'user_label'; confidence = 0.99;
 } else if (metaBrand) {
 brand = metaBrand.brand; source = metaBrand.source || 'meta'; confidence = Number(metaBrand.confidence) || 0.9;
 } else {
 const mh = matchBrand(allText);
 if (mh) { brand = mh.name; source = 'text_match'; confidence = mh.verified ? 0.95 : 0.9; }
 }
 if (!brand) { unresolved.push(base); continue; }

 let product = (ov && ov.product) || (metaBrand && metaBrand.product) || productFromText(allText) || '待确认';
 product = String(product).replace(/[\\/:*?<>|]/g,'').slice(0,20);

    const ord = nextOrd(brand, product, taken);
    const newStem = brand + '-' + product + '-' + String(ord).padStart(2,'0');
    taken.add(newStem);
    const newBase = newStem + path.extname(base).toLowerCase();
    const dst = path.join(VIDEO_DIR, newBase);

    if (stem === newStem && !job.fromReview){
      if (!index[newStem]){
        index[newStem] = { clip: newBase, clip_path: src, output: src, brand: brand, brand_id: brandIdOf(brand), store: null,
          product: product === '待确认' ? null : product, confidence: confidence, source: source, needs_review: false,
          evidence: [], candidates: [], updated_at: new Date().toISOString() };
      }
      skipped++; continue;
    }

    log((job.fromReview ? '[移出待确认] ' : '[改名] ') + base + '  ->  ' + newBase);
    if (DRY) { if (job.fromReview) moved++; else renamed++; continue; }
    try {
      if (fs.existsSync(dst)) { rows.push({ action:'conflict_skip', old: base, new: newBase, brand: brand, product: product, source: source }); continue; }
      fs.renameSync(src, dst);
    } catch(e){
      rows.push({ action:'error:' + e.message, old: base, new: newBase, brand: brand, product: product, source: source });
      continue;
    }
    if (hit && hit.metaPath){
      hit.m.output = dst;
      const trustUser = (source === 'user_label' || source === 'override');
      if (trustUser){
        hit.m.brand = Object.assign({}, hit.m.brand, {
          brand: brand, brand_id: brandIdOf(brand), product: product === '待确认' ? null : product,
          confidence: 0.99, source: 'user_label', needs_review: false,
          note: '宝哥手工标注：' + base
        });
      }
      writeJson(hit.metaPath, hit.m);
    }
    const oldRec = index[stem] || {};
    const trust = (source === 'user_label' || source === 'override');
    const rec = Object.assign({}, oldRec, {
      clip: newBase, clip_path: oldRec.clip_path || src, output: dst,
      brand: brand, brand_id: brandIdOf(brand), product: product === '待确认' ? null : product,
      confidence: Math.max(Number(oldRec.confidence) || 0, confidence),
      source: trust ? 'user_label' : (oldRec.source || source),
      needs_review: trust ? false : !!oldRec.needs_review,
      renamed_from: base, updated_at: new Date().toISOString()
    });
    if (!Array.isArray(rec.evidence)) rec.evidence = [];
    if (trust) rec.evidence.push({ t: null, text: 'manual: 宝哥标注「' + base + '」', score: 0.99, manual: true });
    if (index[stem] && stem !== newStem) delete index[stem];
    index[newStem] = rec;
    rows.push({ action: job.fromReview ? 'moved' : 'renamed', old: base, new: newBase, brand: brand, product: product, source: source });
    if (job.fromReview) moved++; else renamed++;
  }

  writeJson(INDEX_PATH, index);
  appendLog(rows);
  writeJson(path.join(ROOT,'runtime/unresolved-brands.json'), {
    updated_at: new Date().toISOString(),
    note: '这些成片没能自动认定品牌：需要联网核对，或在文件名前加「品牌：」，或在 runtime/rename-overrides.json 里指定后再跑一次。',
    files: unresolved
  });
  log('renamed=' + renamed + ' moved=' + moved + ' skipped=' + skipped + ' unresolved=' + unresolved.length);
}
main();
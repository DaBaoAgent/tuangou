// 零依赖 xlsx 读取：只支持抖音「作品列表导出」这种单表、共享字符串的朴素工作簿。
// 需要读单元格格式（日期/百分比）时由上层解析字符串，不在这里做。
const fs = require('fs');
const zlib = require('zlib');

function unzip(buf) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    try {
      files.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw));
    } catch { /* 损坏条目跳过 */ }
  }
  return files;
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function colIndex(ref) {
  const letters = String(ref || '').replace(/\d+/g, '').toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readSharedStrings(xml) {
  const out = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) {
    // 富文本会拆成多个 <t>，按顺序拼回去
    const parts = [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x => decodeXml(x[1]));
    out.push(parts.join(''));
  }
  return out;
}

function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1] || '';
      const inner = cm[2] || '';
      const ref = (attrs.match(/\br="([A-Z]+)\d+"/) || [])[1];
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1];
      let val = '';
      if (type === 'inlineStr') {
        val = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x => decodeXml(x[1])).join('');
      } else {
        const v = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        const raw = v ? v[1] : '';
        val = type === 's' ? (shared[Number(raw)] ?? '') : decodeXml(raw);
      }
      const idx = ref ? colIndex(ref) : cells.length;
      cells[idx] = val;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

// 返回二维字符串数组；第一个工作表即导出表
function readXlsxRows(input) {
  const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  const files = unzip(buf);
  const sharedXml = files.get('xl/sharedStrings.xml');
  const shared = sharedXml ? readSharedStrings(sharedXml.toString('utf8')) : [];
  const sheetName = [...files.keys()]
    .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort()[0];
  if (!sheetName) throw new Error('no worksheet');
  return parseSheet(files.get(sheetName).toString('utf8'), shared);
}

module.exports = { unzip, readSharedStrings, parseSheet, readXlsxRows, colIndex, decodeXml };

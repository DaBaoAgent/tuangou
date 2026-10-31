// Phase 0 local-only rendering experiment. No platform access or product claims.
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const sharp = require('sharp');
async function main() {
  const output = path.resolve(__dirname, '../runtime/phase0');
  await fs.mkdir(output, { recursive: true });
  const executablePath = process.env.PHASE0_BROWSER_PATH || undefined;
  const browser = await chromium.launch({ headless: true, executablePath, timeout: 15000 });
  try {
    const page = await browser.newPage({ viewport: { width: 1242, height: 1660 }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
      *{box-sizing:border-box} body{margin:0;background:#fff2c9;color:#222;font-family:"Microsoft YaHei",sans-serif}
      main{height:1660px;padding:90px;display:flex;flex-direction:column;justify-content:center;gap:50px}
      h1{font-size:112px;line-height:1.25;margin:0;color:#ba2727} p{font-size:58px;line-height:1.5;margin:0}
      small{font-size:32px;color:#555}
      </style><main><h1>中文排版<br>渲染测试</h1><p>这是本地技术验证样图<br>并非真实商品或发布内容</p><small>1242 × 1660 · Phase 0</small></main></html>`);
    await page.evaluate(() => document.fonts.ready);
    const raw = await page.screenshot({ type: 'png' });
    const file = path.join(output, 'render-poc.png');
    await sharp(raw).toColourspace('srgb').png().toFile(file);
    const metadata = await sharp(file).metadata();
    if (metadata.width !== 1242 || metadata.height !== 1660 || metadata.format !== 'png') throw new Error('Unexpected image dimensions or format');
    console.log(JSON.stringify({ file, width: metadata.width, height: metadata.height, format: metadata.format, space: metadata.space }, null, 2));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

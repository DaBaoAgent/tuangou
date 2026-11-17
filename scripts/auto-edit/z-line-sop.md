# Z 线团购批量剪辑 SOP（2026-11-17 固化）

`Z:\暂时不用素材\团购` 是宝哥本地剪辑工作区。这条线的成片**只归位到 Z 盘，不进项目发布队列**
（AGENTS 规则 6/10）。本文件是把 2026-11-17 那批 40 条（9 品牌 × 4 + 紫燕百味鸡 4）跑通后的
固定流程，配套脚本：`batch_manifest.py` / `render_batch.ps1` / `archive_sources.py` / `ocr_sub_lines.py` / `audit_subs.py`。

## 目录与配置

| 用途 | 路径 |
|---|---|
| 源素材 | `Z:\暂时不用素材\团购\未剪素材`（`田` 子目录除外，规则 8） |
| 成片 | `Z:\暂时不用素材\团购\已剪成片`（`品牌-商品-序号.mp4`） |
| 源素材归档 | `Z:\暂时不用素材\团购\未剪素材\已剪素材` |
| 批次配置 | `runtime/auto-edit/config-z-new.json`（`hook.enabled=false`、`subtitle.cover_ink_center=0.46`、`legacy_sub.mode=cover`、字号 112 / 描边 3.2、`naming.keep_source_name=true`） |
| 批次清单 | `runtime/auto-edit/batches/<批次>.json`（品牌/商品/源 stem 映射） |
| 校对稿 | `runtime/auto-edit/corrections-z/<源素材完整 stem>.json` |
| 品牌覆盖 | `runtime/auto-edit/brand_overrides/<源素材完整 stem>.json` |
| OCR/ASR 草稿 | `runtime/auto-edit/ocr-draft-z/<stem>.json` |
| 工作目录 | `runtime/auto-edit/work-z-batch/<stem>/` |

统一用带 numpy/PIL/faster-whisper 的解释器：
`C:\Users\Administrator\AppData\Local\Programs\Python\Python311\python.exe`（默认 python 缺 numpy，直接跑 `fx.py` 会崩）。
ffmpeg：`D:\@kaifa\tools\ffmpeg\bin\ffmpeg.exe`；OCR 服务：`http://127.0.0.1:18224/api/ocr`（100 成功 / 101 空 / 901 文件缺失）。

## 一次批次的七步

**Step 0 素材闸门（不可省）。** 逐条算 SHA256 与 `scripts/publish/source_blacklist.json` 的 14 条「田」原片哈希比对，
并检查文件名不含 `^\d+月\d+日_`；`田` 子目录整目录跳过。

**Step 1 出清单。** 新建 `runtime/auto-edit/batches/<日期>.json`：

```json
{"batch": "z-20261117", "items": [
  {"brand": "柳大厨", "product": "螺蛳粉火锅", "stems": ["柳大厨", "柳大厨(1)", "柳大厨(2)", "柳大厨 (3)"]}
]}
```

```powershell
py scripts/auto-edit/batch_manifest.py --groups runtime/auto-edit/batches/z-20261117.json `
  --source-dir "Z:\暂时不用素材\团购\未剪素材" --stage "Z:\暂时不用素材\团购\已剪成片" `
  --out-list tmp/render_list.json --out-items tmp/audit_items_z.json
```

`stems` 的顺序就是序号：base=01、(1)=02、(2)=03、(3)=04。**stem 必须一字不差照抄源文件名**，
包括空格——本批就有一条叫 `柳大厨 (3)`（括号前带空格），写错就找不到源、校对稿也对不上。

**Step 2 出草稿。** 有烧录字幕的走逐帧 OCR，没有的走 ASR 断句，都落到 `ocr-draft-z`：

```powershell
py scripts/auto-edit/ocr_sub_lines.py --config runtime/auto-edit/config-z-new.json --all
# 只想补某几条：--stems "柳大厨(2),紫燕百味鸡冒烤鸭套餐饭带货视频脚本 (3)"（逗号分隔，可带空格）
```

草稿里的 `band` / `lines` / `asr_text` 就是校对稿的原料。无字幕带的素材 `status=no_band`，`lines` 已按 ASR 断句。

**Step 3 写校对稿 + 品牌覆盖。** 每条两份，文件名都是源素材完整 stem：

- `corrections-z/<stem>.json`：`{"lines":[{text,start,end}...], "note": "..."}`，可选 `"cover"`。
- `brand_overrides/<stem>.json`：`{"brand","product","note"}`，优先级最高，重剪不丢（规则 1）。

三条 cover 决策（每次都要逐条判，不能凭检测结果直接遮）：

| 检测结果 | 处理 |
|---|---|
| 检出真实烧录字幕带 | 默认 cover（配置已 `legacy_sub.mode=cover`），校对稿只写 lines |
| 检出的是杯身/包装/门头招牌字 | 校对稿写 `"cover": false`，只叠自己的字幕（本批：绝味(1)、渝八两 base、渝八两(3)） |
| 检出带把包装字一起圈进来 | 校对稿写显式 `"cover": [{"y0":1462,"y1":1558,"t0":0,"t1":15.07}]` 只遮真字幕（本批：绝味 base 检出 1246–1792） |

品牌归一按规则 7：画面/字幕里的品牌名和文件名品牌不一致时一律按文件名重打。本批实例：
夸父炸串原字幕「巷口/港口炸物社」、芝小官原字幕「韩宫宴/韩宫宫/韩宫夏/韩宫恩/韩宫愿」、田小跳 ASR「甜小跳」。
错字按音义改（鸡刹骨→鸡叉骨、祖然→孜然、吊渣→掉渣、螺丝粉→螺蛳粉、冒鸡鸭→冒烤鸭、里背肉→里脊肉、
六参套/六修套→六件套、核销误识成「核酸」…），**一行不删**（规则 7）。

**Step 4 渲染（串行两路，一律 `--no-move`）。**

```powershell
Start-Process pwsh -ArgumentList "-NoProfile","-File","scripts/auto-edit/render_batch.ps1","-List","tmp/render_list.json","-Mod","0","-Of","2" -WindowStyle Hidden
Start-Process pwsh -ArgumentList "-NoProfile","-File","scripts/auto-edit/render_batch.ps1","-List","tmp/render_list.json","-Mod","1","-Of","2" -WindowStyle Hidden
```

- `-Of 2` 是本机实测的稳定并发；8 路并发会争 CPU/GPU，单条从约 60s 涨到 85s~20min。
- 渲染阶段不移动源素材；源素材等审计过了再统一归档，「源没了片没出」的中间态不会出现。
- 单条手动重渲：
  `py scripts/auto-edit/auto_edit.py --config runtime/auto-edit/config-z-new.json --clip "<stem>" --name "<成片名>" --no-move`
- `--clip` 有「精确 stem 命中优先」行为：`--clip 柳大厨` 只匹配无括号那条；补跑带括号的要用完整 stem 或 `--stems`。
- `naming.keep_source_name=true` 时不传 `--name` 就会保留源素材名（8:53 那批 81度 就是这样落的），批量务必传 `--name`。

**Step 5 审计（两套坐标各跑一遍）。**

```powershell
# 第一次：新版样式字幕带（y1360 起）
py scripts/auto-edit/audit_subs.py --stage "Z:\暂时不用素材\团购\已剪成片" `
  --items tmp/audit_items_z.json --corrections runtime/auto-edit/corrections-z --report tmp/audit_z.txt

# 第二次：字幕落位偏高的条目（y≈1150–1300，源素材字幕带本来就高，柳大厨 1263-1347、夸父(3) 1293-1383 等）
py scripts/auto-edit/audit_subs.py --stage "Z:\暂时不用素材\团购\已剪成片" `
  --items tmp/audit_items_z_retry.json --corrections runtime/auto-edit/corrections-z --report tmp/audit_z_retry.txt `
  --band-y 1080 --band-h 330 --scan-y 1130 --scan-h 280 --tight-y 1120 --tight-h 170
```

第一次报告里 `bad=N`（逐行全失败）几乎都是字幕不在 y1360 带，不是字幕错了——先按失败清单切第二次坐标重审，
别急着改稿重渲。`SCAN` 命中是背景招牌/logo（STARBUCKS、门头字、包装字），不算失败。
两次都 `bad=0`、返回码 0 才算过。

**Step 6 归档源素材。**

```powershell
py scripts/auto-edit/archive_sources.py --list tmp/render_list.json `
  --source-dir "Z:\暂时不用素材\团购\未剪素材" --stage "Z:\暂时不用素材\团购\已剪成片"
py scripts/auto-edit/archive_sources.py ... --apply   # 确认后真移动
```

只动清单里的 `<stem>.mp4`，不碰 MOV、其它批次、`田`；成片缺失/为空/归档目标重名一律跳过报告。

**Step 7 交付。** 出 `runtime/auto-edit/reports/z-batch-<日期>.md`（成片 ↔ 源素材 ↔ 大小对照表 + 字幕处理决策 + 审计结论），
在对话里报：条数、规格、字数带决策、审计结果、归档结果。**不往 `素材库\已剪成片` 复制**，这条线不入发布队列。

## 验收清单

- [ ] 源素材 40/40 都在 `已剪素材`，`未剪素材` 顶层清零
- [ ] 成片数 = 清单条数，命名全为 `品牌-商品-序号.mp4`
- [ ] 每条 `runtime/auto-edit/work-z-batch/<stem>/meta.json` 的 `verify.ok` 为 true（1080×1920 / 30fps / 时长一致）
- [ ] 审计两次坐标均 `bad=0`、返回码 0
- [ ] 抽查 cover 类抽帧：原字幕已糊、新字幕压在模糊条中间、包装/招牌字没被误糊
- [ ] 交付清单表与目录实际文件一一对应

## 2026-11-17 批次记录

- 40 条（10 品牌 × 4），全部 15.07s / 1080×1920 / 30fps，合计 552 MB。
- 两路串行渲染约 55 分钟；单条 40–90s。
- 审计：23 条按 y1360 带一次过，17 条切 `--band-y 1080` 复检全过，合计 40/40。
- 三个 `cover:false`（绝味(1)/渝八两 base/渝八两(3)）、一条显式 cover（绝味 base 1462–1558）。
- 源素材 40 条已归档，`未剪素材` 顶层清零。

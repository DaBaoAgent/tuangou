# Z 线团购批量剪辑 SOP（2026-11-17 固化）

`Z:\暂时不用素材\团购` 是宝哥本地剪辑工作区。这条线的成片**只归位到 Z 盘，不进项目发布队列**
（AGENTS 规则 6/10）。本文件是把 2026-11-17 那批 40 条（9 品牌 × 4 + 紫燕百味鸡 4）跑通后的
固定流程，配套脚本：`batch_manifest.py` / `render_batch.ps1` / `archive_sources.py` / `ocr_sub_lines.py` / `audit_subs.py`；
2026-11-18 补「缺陷修复支线」：`repair_cut.py` / `stage_config.py` / `recheck_asr.py`。

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
并检查文件名不含 `^\d+月\d+日_`；`田` 子目录整目录跳过。已固化为脚本（三重查重：黑名单 / 已归档源片 / 已成片）：

```powershell
py scripts/auto-edit/source_gate.py                                   # 查顶层全部
py scripts/auto-edit/source_gate.py --starts-with 犇腾牛排 --starts-with Texas  # 只查这批
```

返回码 1 表示有命中（按原因列出：文件名正则 / 黑名单哈希 / 已归档源片 / 已成片），命中条目移 `素材库\隔离\` 再判，不删。

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

**校对稿怎么写（2026-11-20 固化，别再用「按 ASR 词切行」或「按草稿窗口拼句」）**：这两种切法都会把词切两半（「蚝友黑牛烤」｜「肉」）并把 ASR 幻觉留在字幕里。现做法是**逐条手写口播句**（一条片子 5–10 句，照人念的句子写，不照 ASR 分词），再用 `asr.json` 的**词级时间戳按字符累计**做对齐：把整条口播按句子切成字符序列，按字符索引比例落到词时间上，找不到就顺序兜底；最后对时间轴做一次连续化（首行 0s、行间首尾相接、末行钉 `dur`、最小 0.4s、防重叠）再过 Step 3.8 闸门。替换表按批次单独维护（同音/近音误读、品牌归一、噪声黑名单如「感谢观看」「YoYoTelevisionSeriesExclusive」整行丢弃），不要复用别的批次的表。

品牌归一按规则 13：**以片内口播 + 烧录字幕为准**，文件名与片内不一致就改片子这侧的命名（2026-11-20 实例：文件名 `coco` 的四条全片念「沪上阿姨波波家族」→ 出片 `沪上阿姨-波波奶茶-01..04`；文件名「耗友黑牛」实为「蚝友黑牛」）。只有片内证据不足时才退回文件名。本批对照实例：
夸父炸串原字幕「巷口/港口炸物社」、芝小官原字幕「韩宫宴/韩宫宫/韩宫夏/韩宫恩/韩宫愿」、田小跳 ASR「甜小跳」。
错字按音义改（鸡刹骨→鸡叉骨、祖然→孜然、吊渣→掉渣、螺丝粉→螺蛳粉、冒鸡鸭→冒烤鸭、里背肉→里脊肉、
六参套/六修套→六件套、核销误识成「核酸」…），**一行不删**（规则 7）。

**Step 3.8 字幕时间轴闸门（`check_sub_gaps.py`，2026-11-19 固化）。** 渲染前先把校对稿过一遍，只查时间轴不渲染，秒级出结果：

```powershell
py scripts/auto-edit/check_sub_gaps.py --dir runtime/auto-edit/corrections-z `
  --stems-file tmp/render_list.json --fail      # 有 FAIL 退出码 1，别往下渲染
```

判的是三件事：相邻行 **空档** >0.15s（字幕消失再出现＝一跳）、相邻行 **重叠** >0.05s（两行叠字＝一跳）、**首行迟到** >0.1s。行时长 <0.4s 的只报 WARN。

**字幕「一跳一跳」是怎么修掉的（这条不要再退回手工）**

- `auto_edit.py#stabilize_lines`（渲染前必走，覆盖校对稿与纯 ASR 两条路径）：排序 → 短碎片并入上一行（合并后不超 `max_chars`，避免缩字）→ 首行拉回 0s → 中间行首尾相接（`end = next.start`，空档全填）→ 不足 `min_duration` 的行向下一行借时间（下一行仍保 ≥0.8×`min_duration`）→ 收尾再兜一遍防重叠。它只动时间、只合并不超字数的碎片，**不删行**（规则 7）。
- `auto_edit.py#normalize_cover_bars`：遮盖条同 y 带（±8px）合并、≤0.8s 断口合并；检出覆盖 ≥60% 时长就整条拉到 `0→dur`，否则首尾延伸到 0/dur；上下两层不合并（避免糊成一大块）。
- 回归：`py scripts/auto-edit/test_sub_timeline.py`，10 例（空档闭合、借时不叠字、碎片合并不超字、首尾贴边、遮盖条合并/分层/延伸）必须全 PASS。改这两个函数后先跑它。
- 口径：历史 138 份校对稿里有 368 处空档（最大 6.7s），是「一跳一跳」的成因；新批次一律 0 空档（2026-11-19 批 48/48 实测 FAIL=0 WARN=0）。

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

**Step 5 审计（坐标按配置实测，别照抄别人的带）。**

先抽一帧量字幕落位（一句命令搞定）：

```powershell
ffmpeg -y -ss 4 -i "Z:\暂时不用素材\团购\已剪成片\<成片名>" -frames:v 1 -vf "crop=1080:220:0:1180" tmp\probe.png
# 看一眼 probe.png，字幕落在 crop 的哪一段 → 反推绝对 y，再定 --band-y
```

```powershell
# 现行配置（subtitle.margin_v=552）字幕实测 y≈1240–1300，用这一套坐标一次过（2026-11-20 批 36/36 bad=0）
py scripts/auto-edit/audit_subs.py --stage "Z:\暂时不用素材\团购\已剪成片" `
  --items tmp/audit_items_z.json --corrections runtime/auto-edit/corrections-z --report tmp/audit_z.txt `
  --band-y 1080 --band-h 560 --scan-y 1080 --scan-h 560 --tight-y 1120 --tight-h 240

# 旧配置/源素材字幕本来就高的条目：y≈1150–1300（柳大厨 1263-1347、夸父(3) 1293-1383）
py scripts/auto-edit/audit_subs.py ... --band-y 1080 --band-h 330 --tight-y 1120 --tight-h 170
```

报告里 `bad=N`（逐行全失败）几乎都是字幕不在这个带上，不是字幕错了——先抽帧量落位、切坐标重审，别急着改稿重渲。
**读到的文本是水印（`GoooNIGHT好运满满`、`CacoMRON` 之类）也说明坐标切在字幕下缘**，同样先切坐标。
`SCAN` 命中是背景招牌/logo（STARBUCKS、门头字、包装字），不算失败。两次都 `bad=0`、返回码 0 才算过。

**Step 6 归档源素材。**

```powershell
py scripts/auto-edit/archive_sources.py --list tmp/render_list.json `
  --source-dir "Z:\暂时不用素材\团购\未剪素材" --stage "Z:\暂时不用素材\团购\已剪成片"
py scripts/auto-edit/archive_sources.py ... --apply   # 确认后真移动
```

只动清单里的 `<stem>.mp4`，不碰 MOV、其它批次、`田`；成片缺失/为空/归档目标重名一律跳过报告。

**Step 7 交付。** 出 `runtime/auto-edit/reports/z-batch-<日期>.md`（成片 ↔ 源素材 ↔ 大小对照表 + 字幕处理决策 + 审计结论），
在对话里报：条数、规格、字数带决策、审计结果、归档结果。**不往 `素材库\已剪成片` 复制**，这条线不入发布队列。

## 缺陷修复支线（2026-11-18 固化）

源片本身有毛病时**不许扣片等重生成、不许抛回宝哥**，按这条支线自己判、自己修（AGENTS 规则 12/13）。
配套脚本：`repair_cut.py`（切段）、`stage_config.py`（清理版配置）、`recheck_asr.py`（独立 ASR 复核）。

**Step 0.5 内容闸门（在 Step 2 出草稿后立刻做，别等到渲完）。**
逐条读 `ocr-draft-z/<stem>.json` 的 `lines`（烧录字幕）与 `asr_text`（口播），按三类判：

| 疑点 | 判法 | 处置 |
|---|---|---|
| 品牌/商品与文件名不符 | 以片内口播+烧录字幕为准；画面标识（杯身/包装/门头）为佐证 | 先抽帧 OCR 看画面，再联网核实（官网/门店列表/抖音门店号/探店实拍，至少两路一致）；按内容改品牌，写 `brand_overrides/<stem>.json`（品牌/商品/带日期依据），**不改源片、不改文件名** |
| 念出/烧出脚本备注（如「门店名字融入场景展示」） | 该句不属于口播内容 | 走 Step 3.5 把整段切掉再重剪（这不属于规则 7 的「删行」） |
| 配音与画面矛盾到语义不通、缺陷贯穿全片 | 无法局部切 | 才退回重生成，并在交付清单「退回」表写明理由 |

判完把结论落 `brands.json`（`verified` + 带日期的 `note`）与 `brand_overrides`，别只留在报告里；
查不到就按保守侧（未认证不挂品牌话题、商品对不上不挂商品），但**片子必须照剪**。

**Step 3.5 切缺陷段（`repair_cut.py`）。**

```powershell
# 先 dry-run 看切点/保留段/预计时长
py scripts/auto-edit/repair_cut.py --stem "海底捞15秒AI带货视频脚本（女生出镜）" `
  --cut "7.20-9.50" --source-dir "Z:\暂时不用素材\团购\未剪素材" `
  --out-dir tmp/clean_haidilao --config runtime/auto-edit/config-z-new.json
# 确认后加 --apply（默认每段两侧留 0.12s 余量，多段用逗号分隔）
```

- 用 `trim+setpts / atrim+asetpts + concat`，`libx264 crf16 preset slow` + `aac 192k`，**清理版与原件同 stem**（`--name` 时就靠 stem 对齐）。
- 产物旁写 `<stem>.repair.json`：切点、保留段、源/出时长、素材签名，复现和背锅都靠它。

**Step 3.6 清理版专用配置（`stage_config.py`）。** 清理版在原目录里和原件同名，直接跑会读回原件，必须派生配置：

```powershell
py scripts/auto-edit/stage_config.py --from runtime/auto-edit/config-z-new.json `
  --source-dir tmp/clean_haidilao --out runtime/auto-edit/config-z-clean.json
```

之后 OCR、校对稿、渲染**全部显式带 `-Config` / `--config runtime/auto-edit/config-z-clean.json`**。
`render_batch.ps1` 不传 `-Config` 就会回头渲原始缺陷片（2026-11-18 第一批救回时踩过，白渲 4 条）。

**Step 3.7 ASR 复核（`recheck_asr.py`，渲染前后各跑一次最好）。**

```powershell
py scripts/auto-edit/recheck_asr.py "tmp/clean_haidilao/xxx.mp4" --forbid "门店名字,融入场景"
```

不复用任何缓存（临时目录 + 重新抽音频），命中 `--forbid` 任一词就以退出码 1 结束。
**字幕行永远以 OCR 为准**：`asr.json` 只是参考，尤其清理版同 stem 时旧结果会串台（见下方缓存机制）。

**中间产物缓存机制（2026-11-18 修正，别再踩）。**
`work_dir/<stem>/` 里的 `asr.wav`、`asr.json` 是**按素材签名**判新鲜的：签名 = 大小 + mtime + 前 1MB sha1，
落在 `asr_src.txt`，签名不符就重抽 `asr.wav`、重写 `asr.json`（`auto_edit.py#video_sig/transcribe`、
`ocr_sub_lines.py` 同步）。修正前只判 mtime、`asr.wav` 甚至只在不存在时才抽，同名清理版会拿回旧音频 →
ASR 继续吐含缺陷句的旧文本。**换源、修片、重渲后一定要确认 `asr_src.txt` 的签名变了。**

**归档仍走 Step 6**：清理版对应的**原片**进 `已剪素材`（不是把清理版归档），成片名按内容品牌命名。

## 验收清单

- [ ] 源素材 40/40 都在 `已剪素材`，`未剪素材` 顶层清零
- [ ] 成片数 = 清单条数，命名全为 `品牌-商品-序号.mp4`
- [ ] 每条 `runtime/auto-edit/work-z-batch/<stem>/meta.json` 的 `verify.ok` 为 true（1080×1920 / 30fps / 时长一致）
- [ ] `check_sub_gaps.py` 对本批 FAIL=0（相邻行 0 空档、0 重叠、首行 0s 起）
- [ ] `test_sub_timeline.py` 10/10 PASS（改过字幕/遮盖代码才需要，但改了就必跑）
- [ ] 审计两次坐标均 `bad=0`、返回码 0
- [ ] 抽查 cover 类抽帧：原字幕已糊、新字幕压在模糊条中间、包装/招牌字没被误糊
- [ ] 走过修复支线的条目：`report.json` 有切点记录、`recheck_asr.py` 未命中禁用词、抽帧看拼缝连贯
- [ ] 品牌/商品结论都落在 `brand_overrides`（不是只在报告里）
- [ ] 交付清单表与目录实际文件一一对应

## 2026-11-17 批次记录

- 40 条（10 品牌 × 4），全部 15.07s / 1080×1920 / 30fps，合计 552 MB。
- 两路串行渲染约 55 分钟；单条 40–90s。
- 审计：23 条按 y1360 带一次过，17 条切 `--band-y 1080` 复检全过，合计 40/40。
- 三个 `cover:false`（绝味(1)/渝八两 base/渝八两(3)）、一条显式 cover（绝味 base 1462–1558）。
- 源素材 40 条已归档，`未剪素材` 顶层清零。

## 2026-11-18 批次记录（含救回批）

- 32 条源素材分三批到（24 + 8），48 小时内全部出片：第一批 24、第二波 8（犇腾牛排/Texas美式烤肉）、救回批 8（必胜客 4 + 海底捞 4），共 40 条成片在 `已剪成片`。
- 救回批是首次走「缺陷修复支线」：达美乐 4 条按片内证据改判必胜客；海底捞 4 条切掉念出的脚本备注后重剪（12.5–13.3s）。
- 审计坐标：本批 6 条走高位带（`--band-y 1080 --band-h 380 --scan-y 1090 --scan-h 320 --tight-y 1120 --tight-h 190`），其余默认 y1360；最终 40/40 `bad=0`。
- 踩坑：`ConvertTo-Json` 单元素数组塌成对象（配 `-AsArray`）；`batch_manifest.py` 无过滤参数要单独建 groups；两路渲染每路必须不同 `-Log`。
- 缓存修正：`asr.wav`/`asr.json` 改按素材签名判新鲜（`video_sig`），同名清理版不再串旧音频。

## 2026-11-19 批次记录（48 条 + 字幕连续性固化）

- 源片 40 条 + 中途追加 8 条（吉屋出猪 4 / 胖丫重庆老火锅 4）= 48 条；成片 48 条落 `已剪成片`（681.3 MB），源片全部归档。
- 本批首次启用 `check_sub_gaps.py` 闸门：48 份校对稿 FAIL=0 / WARN=0；`stabilize_lines` 对 48 份已是幂等（再跑一遍 0 变化）。
- 本轮改动：`stabilize_lines` 收尾新增防重叠合拢（借时/0.3s 保底会把上一行顶进下一行，两行同显也是一跳）。
- 教训：**别用 `--band-y 1360` 一刀切**——无烧录字幕带的条目走 `subtitle.margin_v=552`，字幕着墨中心 ≈y1316，落在带外；本批 9 条先被误判全行失败，换 `--band-y 1250 --band-h 460` 复检 13/13 `bad=0`。审前先抽一帧量一下字幕落位。
- cover 误判一例：茶瀑布(3) 检出 1197–1333 是杯身「真奶做放心喝」，写 `"cover": false`。
- 顽欢 4 条走修复支线切「来门店名」；其中 (3) 切后 10.24–13.54，重剪 11.54s，成片重渲并复检 `bad=0`。

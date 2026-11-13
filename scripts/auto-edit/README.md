# 自动剪辑模块（auto-edit）

把 `素材库/未剪素材/` 里的短视频批量做成可直接发布的带货成片：**一条素材 = 一条成片**。

流程：片头白线冲刺特效 + whoosh 音效 → 检测素材是否自带烧录字幕 →
**有字幕的整条跳过字幕环节**（不加黑条、不叠我们的字，保留原字幕）；没字幕的按口播识别
生成逐句字幕（思源黑体加粗 / 白字 / 细黑描边 / 一行一句 / 无标点）→ 原声为主、热门 BGM
垫底 → 1080×1920 / 30fps / HEVC 导出。

字幕样式基线来自 `素材库/已剪成片/已发/11月1日.mp4`：字幕居中单行、底边距约 552px、
字号约 112px，长句左右压缩到 1000px 内。

## 依赖

本机已就绪，换机需重装：

- ffmpeg 8.x（full build，含 libass、libx265、whisper 滤镜）
- Python 3.12：`faster-whisper`、`opencc-python-reimplemented`、`Pillow`、`fonttools`、`numpy`
- 品牌 OCR：本机 Dabao-OCR 常驻服务（`http://127.0.0.1:18224`，开机自启；脚本仅用标准库调用，无第三方依赖）
- 模型
  - `runtime/fw-models/local-turbo/`：faster-whisper large-v3-turbo（ct2，首选，带词级时间戳）
  - `runtime/asr-models/ggml-large-v3-turbo.bin`：faster-whisper 缺模型时的兜底
- 字体 `runtime/asr-models/NotoSansSC-Bold.otf`（思源黑体 / Noto Sans SC Bold，SIL OFL）

## 用法

```bash
# 列出待剪素材
python scripts/auto-edit/auto_edit.py --list

# 剪一条（不移动源素材，便于审核）
python scripts/auto-edit/auto_edit.py --clip 06E7424A --no-move --name 审核样片.mp4

# 剪全部并归档（源素材移入 未剪素材/已剪）
python scripts/auto-edit/auto_edit.py --all
```

成片默认命名 `M月D日_素材名前8位.mp4`，输出到 `素材库/已剪成片/`。
中间产物（srt/ass/校对稿/自检截图/meta.json/片头特效帧）在
`runtime/auto-edit/work/<素材名>/`。

百度同步盘批次使用 `config.baidu-*.json` 时，剪完的源素材按 2026-11-04 宝哥的要求
自动移入 `D:/BaiduSyncdisk/@同步/团购/未剪素材/已剪素材/`（`paths.done_source_dir`）；
不要再用旧目录 `未剪素材/已剪`。加 `--no-move` 可保留源素材待人工复核。

### 两条流水线，成片去处不同（2026-11-14 固化）

| 源素材 | 成片去哪 | 是否自动发布 |
|---|---|---|
| `D:/BaiduSyncdisk/@同步/团购/未剪素材` | 同盘 `已剪成片`（`品牌-商品-序号.mp4`） | 否，宝哥自己处理 |
| `素材库/未剪素材` | `素材库/已剪成片` | 是，`scripts/publish` 扫描队列 |

百度盘线的归位用 `scripts/auto-edit/settle_sync_baidu.py`（默认 dry-run，`--apply` 才动）：

```bash
python scripts/auto-edit/settle_sync_baidu.py --batch-dir runtime/auto-edit/out-baidu-20261113
python scripts/auto-edit/settle_sync_baidu.py --batch-dir ... --apply
```

它做三件事：把成片复制到百度盘 `已剪成片`（已存在的跳过）、把 `未剪素材` 顶层源素材移入
`已剪素材`、把 `meta.output` 与 `brand_index.json` 同步指向实际路径。脚本会拒绝以项目发布
队列为目标目录——百度盘线的成片**绝不复制进 `素材库/已剪成片`**，否则自动发布会误抓。


## 素材自带字幕

按 2fps 抽 360×640 帧，逐行统计「亮字核心 + 邻域暗描边」像素，连续成带的行算一层
字幕（`legacy_sub.min_score` 默认 0.3）；素材可能同时有两层（如上层白字只在中段出现、
下层黄字全程出现）。

检测到**任意一层**就判定这条素材「自带字幕」，默认整条跳过字幕环节：不画黑条、不叠加
我们的字幕，画面与声音保持原样（只加片头特效/BGM）。检测不到字幕的素材正常生成字幕。
可用 `legacy_sub.enabled: false` 关闭检测（全部按无字幕处理）。

原字幕有错字、叠字或缺句时，把 `config.json` 的 `legacy_sub.mode` 改为 `cover`：只对
检测到的字幕带做局部模糊（`cover_pad` / `cover_blur`），再用人工校对稿重打我们自己的
字幕。`cover` 模式必须配校对稿使用，否则会用 ASR 初稿覆盖原字幕，错字风险更高。

## 品牌识别

素材没有预置团购品牌与商品信息，成片必须知道对应哪个品牌门店。每条素材会依次尝试：

1. **人工覆盖**：`runtime/auto-edit/brand_overrides/<素材文件名去扩展名>.json`
   ```json
   {"brand": "临榆炸鸡腿", "store": "XX路店", "note": "宝哥确认"}
   ```
2. **画面 OCR**：按 `brand_ocr.sample_fps`（默认 1）抽帧、放大到 1080 宽，用
   Dabao-OCR（`max_side_len` 默认 2048）读招牌 / 包装 / 杯身文字，再与 `brands.json`
   的别名做规范化匹配（子串命中或相似度 ≥ `fuzzy_threshold`）。首轮没命中会用
   `retry_scale_width`（默认 1440）再扫一遍，抓杯身小字/logo。
   实在读不出的品牌，抽 1440 宽帧 + 2048 分辨率重扫，再把读到的文字/画面特征拿去
   网上比对，确认后补进 `brands.json` 或写人工覆盖，不靠猜。
3. **口播文本**：ASR / 校对稿里命中品牌别名。只有口播命中、画面没确认时仍标人工复核。

品牌目录 `scripts/auto-edit/brands.json`：新增品牌补 `id / name / aliases / category`，
别名至少 2 个字符；未确认的品牌先放 `suspected`，不要直接入目录。
**识别不到、画面与口播冲突、两个品牌置信接近时不猜**，结果标 `needs_review: true`，
并把画面里读到的短文本放进 `candidates` 供人工判断。只读到 3 字以内短别名的近似匹配
（例如画面只读到「MR」却命中「MR.X」）同样只算线索，标人工复核。

结果落在：

- `runtime/auto-edit/work/<素材名>/brand.json`：单条缓存（含证据帧时间与 OCR 文本）
- `runtime/auto-edit/brand_index.json`：素材 → 品牌/门店/商品/置信度汇总，供发布时选门店
- 成片 `meta.json` 的 `brand` 字段

`store` 目前只来自人工覆盖，目录里还没有门店表；发布环节接入门店数据后再补。

商品同样支持人工确认：`runtime/auto-edit/product_overrides/<素材文件名去扩展名>.json`

```json
{"product": "麦辣鸡腿堡", "note": "画面 McS + 口播香辣鸡腿肉，比对麦当劳 McSpicy"}
```

识别的商品写进 `brand.json` / `brand_index.json` 的 `product` 字段，并随成片
`meta.json` 一起落盘。品牌和商品都确认后，发布环节可以直接按品牌门店 + 商品出标题。

```bash
# 只识别品牌，不剪片（同时扫未剪素材和已剪素材）
python scripts/auto-edit/auto_edit.py --brand-scan
python scripts/auto-edit/auto_edit.py --brand-scan --clip 28783052
# 忽略缓存重扫
python scripts/auto-edit/auto_edit.py --brand-scan --force-brand
```

每条抽 15 帧左右，单条约 30～90 秒（首轮没命中会再扫一遍 1440；
`max_side_len` 2048 下 OCR 更慢但小字命中率明显更高）；
结果有缓存，重跑不重复识别。

## 片头白线冲刺特效

所有成片片头 0～0.6s 叠加白色放射冲刺线：以人物为中心向外扩散，中间留椭圆空区不挡人，
线条随外扩淡出；同时混入 0.9s 合成音效（扫频噪声 + 低频冲击）。

参数在 `config.json` 的 `opening_fx`：

- `duration` / `line_count` / `accent_lines`：时长、普通线数量、高亮长线数量
- `inner_rx` / `inner_ry` / `center_x_ratio` / `center_y_ratio`：中间空区与人物的相对位置
- `sfx_volume` / `sfx_duration` / `sfx_peak`：音效音量、时长、峰值
- `seed`：固定随机种子，每次生成一致；改配置会自动重建
  `runtime/auto-edit/work/<素材>/fx/` 缓存

生成逻辑在 `scripts/auto-edit/fx.py`，不依赖外部素材。

> 实测 `已发/11月1日.mp4` 相对其原素材的音频波形相关系数约 0.99（0～3 秒段 0.995 左右、
> 2～12 秒段 0.991），增益拟合后仍一致，残余仅为 AAC 编码误差；画面差异只在字幕带。
> 该样片本身并没有白线冲刺效果和音效，当前特效是按需求新建的。

## 开头 1.5 秒钩子（2026-11-11 宝哥拍板）

账号「2 秒跳出 62%」，光堆量救不了，先改开头结构。每条成片在开头 1.5 秒做两件事：

1. **推近运镜**：`hook.punch_in`（默认 1.08）从轻微推近缓慢回中，给首帧一点运动感。
   滤镜放在所有 overlay 之后、ASS 之前，自带字幕的模糊条跟着一起缩放，坐标不会错位。
2. **钩子卡**：画面顶部 24% 处压一行加粗大字（`hook.duration` 1.5 秒，淡入淡出）。
   样式：**黄字 `hook.fill`（FFD400）+ 很窄的黑描边 `hook.outline`=2、无阴影、
   字号 `hook.font_size`=142**，和底部白字字幕（112）区分开（2026-11-11 宝哥定）。
   文案**只从已有口播/字幕里选，不编造卖点**。取词来源按可靠性排：
   人工校对稿（`corrections/`）> 画面烧录字幕 OCR（跳过字幕的素材，`hook_from_legacy_ocr()`）>
   ASR 断句。**ASR 直接按字硬截已停用**——2026-11-11 批量试跑把「链接」识别成「练街」顶上过卡片。
   另外只认开头 `hook.max_start_seconds`（9 秒）内说到的词，尾段多是 CTA 或幻觉。规则细节：
   - 优先用 `build_lines()` 切好的自然字幕短句（跳过字幕的素材也会现切一份），
     字幕行里没有可用词时才退回按词边界拼的窗口；
   - 必须含 `hook.keywords` 里的卖点词（买一送一/招牌/爆汁/酥/脆/糯/上头/划算…）
     或带疑问语气（吗/吧/呢）；
   - 4～7 字优先，9 字以上扣分（太长多是从半句里截出来的）；
   - 必须发生在开头 `hook.duration + 1 秒` 之后，且不能和这期间的画面文字重复——
     第一版样片就踩过「顶部钩子 + 底部原字幕」同字的坑（`审核样片_钩子_喜见茶山.mp4` 首版）；
   - ASR 片尾 0.0x 秒的幻觉段（重复句）直接丢弃。
   取不到合适文案就只保留运镜，**宁可不加卡，也不上错字或半句话**。
   - `hook.enabled: false` 可整体关闭；`max_chars` / `font_size` / `margin_top_ratio` 可调。

实测覆盖率：现有 107 条素材里 42 条能选出合格钩子（约 39%），运镜 100% 生效。
样片：`素材库/已剪成片/审核样片_钩子_山中无老虎.mp4`（钩子「聚餐更划算」+ 底部原字幕
「海鲜大咖 娃娃煲来啦」），`审核样片_钩子_喜见茶山.mp4`（该条无合格钩子，只加运镜）。
`审核样片_*` 前缀会被发布队列忽略，不会自动发出去。

### 库存重剪（2026-11-11）
新开头结构上线前的成片还在库存里，用 `rerender_stock.js` 从归档源素材重渲：

```bash
node scripts/auto-edit/rerender_stock.js --dry-run   # 看成片→源素材对应关系
node scripts/auto-edit/rerender_stock.js --limit 2   # 先渲 2 条验收
node scripts/auto-edit/rerender_stock.js             # 全量到 素材库/已剪成片/重剪-YYYYMMDD/
```

- `auto_edit.py --source-dir 素材库/未剪素材/已剪` 直接从归档源取素材；`--no-move` 不搬源。
- 重剪会覆盖 workdir 的 `meta.json`，脚本先把旧版备份成 `meta.json.bak-时间戳`。
- 只有「成片 → workdir → 已剪源」能对上的才重剪；源是更早一版成片、原素材已不在的会列入
  manifest 的 `skipped`（2026-11-11 实测 74 条库存里 45 条可重剪、29 条缺原始素材）。
  缺源的这批不重剪，改用下面的「缺源成片只叠钩子卡」补开头。
- 渲染记录写到 `runtime/auto-edit/rerender-YYYYMMDD.json`，先落计划再逐条更新进度。

实现：`auto_edit.py#pick_hook()` 选词、`hook_from_legacy_ocr()` 读画面字幕、`build_ass()` 画卡、`render()` 运镜；
配置在 `config.json` 的 `hook` 段。钩子文案会写进 `meta.json` 的 `hook` 字段，便于复核。

### 缺源成片只叠钩子卡（2026-11-11）

`skipped` 里那 29 条的源是更早一版成片，再剪是第三代、画质会掉，所以**不重剪**，
只把开头钩子卡补上去（宝哥定：29 条只叠钩子卡）：

```bash
node scripts/auto-edit/hook_overlay_stock.js --dry-run   # 先看名单
node scripts/auto-edit/hook_overlay_stock.js --limit 2   # 先渲 2 条验收
node scripts/auto-edit/hook_overlay_stock.js             # 全量到 素材库/已剪成片/钩子-YYYYMMDD/
```

- 单条入口 `auto_edit.py --hook-only --clip <成片文件名> --out-dir <目录> [--name <输出名>]`。
- 行为：按 `meta.output` 的 basename 反查工作目录（`find_workdir_for_film()`），钩子仍走
  「校对稿 > 画面字幕 OCR」（`hook_for_existing()`，ASR 硬截照样不参与），**只叠 ASS 卡**：
  不推近、不重烧字幕、音轨能直拷就 `-c:a copy`；输出后照样抽帧自检（`verify_output()`）。
- 名单取最近一次 `runtime/auto-edit/rerender-*.json#skipped`，只处理**仍在库存顶层**的成片
  （已被品牌/字幕闸门挪走的不碰）；`.mov/.mkv` 输出统一改成同名 `.mp4`。
- 进度写 `runtime/auto-edit/hook-overlay-YYYYMMDD.json`；加卡的片换进库存顶层，旧版本按批次留档。
- 2026-11-11 实跑：27 条里 **8 条配上钩子、19 条无合格钩子跳过、0 失败**
  （华莱士厚霸堡、古茗、喜山奈 ×2、真茶屋、笨姐就是火辣 ×2、茉沏）。取不到就保持原样，
  宁可不加卡也不上错字。

## 人工校对字幕（仅无字幕素材）

只对「素材本身没有烧录字幕」的片段生效。ASR 对品牌名、口音、背景音容易有错字。
跑完一条后，在 `runtime/auto-edit/corrections/<素材文件名去扩展名>.json` 写：

```json
{
  "lines": [
    {"text": "宝子们今天必须", "start": 0.0, "end": 1.45},
    {"text": "给你们安利这个", "start": 1.45, "end": 3.0}
  ]
}
```

再次运行同一条素材会优先使用校对稿。默认 skip 模式下自带字幕的素材会整条跳过字幕，
校对稿不生效；改用 `legacy_sub.mode=cover` 后，校对稿才用于遮盖并重打。

## 成片字幕审计（发布前闸门）

批量重制或手工修字后，发版前用 `audit_subs.py` 做最后一道 OCR 复核。它按校对稿逐行
抽中点在字幕带 OCR，再按 1 秒间隔扫全片找漏网/重影；逐行检查不过会再切「紧字幕带」
重查一次，避免背景大字、招牌动画干扰。

```bash
python scripts/auto-edit/audit_subs.py \
  --stage runtime/auto-edit/out-named-repair \
  --items C:/tmp/items.json \
  --corrections runtime/auto-edit/corrections-named \
  --report C:/tmp/audit.txt
```

`items.json` 两种写法：`["成片名.mp4", ...]`（按成片名找校对稿），或
`[{"out": "成片名.mp4", "src": ["源素材.mp4"]}]`（按源素材名找校对稿，改名成片必须用
这种）。校对稿文件名 = 源素材完整 stem（保留空格和 ` (1)` 后缀）。

返回值：`0` = 逐行检查全过；`1` = 有字幕行没对上或文件/校对稿缺失；`2` = OCR 服务未就绪。

参数与坐标（默认值对应新版 1080×1920 成片）：

| 用途 | 参数 | 默认裁剪 |
| --- | --- | --- |
| 逐行检查 | `--band-y/--band-h/--band-scale` | `1360 / 400 / 3x` |
| 全片扫描 | `--scan-y/--scan-h/--scan-scale` | `1390 / 280 / 2x` |
| 失败重查 | `--tight-y/--tight-h/--tight-scale` | `1455 / 130 / 4x` |

- 新版成片字幕实际在 y≈1464–1557；老版（7 月前样式）在 y≈1274–1358，用
  `--band-y 1150 --scan-y 1200 --tight-y 1250`；720p 烧录素材原字幕带在 y≈920–1160。
- 报告里的 `SCAN` 命中（`scan_flags`）**不计为失败**，多半是背景招牌/logo（luckincoffee、
  茶百道、门店字），先切紧字幕带或看放大帧确认；只有 `LINE_FAIL` 才是真问题。
- 片头 0–0.6s 白线特效可能压住首行字幕导致 OCR 误读（如「姐妹们」读成「姐妹门」），
  以紧带重查或 0.4s 后采样为准；别直接改校对稿。
- 常见 OCR 混淆：扛/打、囤/国、们/门、蛳/狮。比例在 0.5～0.7 时先放大原图核对再判定。
- 校对稿改完必须重渲再重审；只改 JSON 不重渲，成片不会变。
- 替换成片前先备份到 `runtime/auto-edit/backup-已剪成片-<日期>/`，替换后逐文件 md5
  比对；`已发/` 是已发布归档，只读，不随批量修复改动。
- 老成片只有前几行字幕时，先确认是不是旧 ASR 把尾段时间截断了：核对原素材音频长度，
  必要时重跑 ASR 或补校对稿，再重渲。

本流程 2026-11-04 实测：项目库 39 条重制片经 `audit_subs.py` 前身脚本逐行复核通过，
`已发/coco都可：42` 因已发布保持只读；Baidu 批次 8 条按同一流程交付。

发布端已自动执行同一类复核：`scripts/publish/subtitle_gate.js` 调 `audit_clip.py`
（单条成片、参数同上的精简版）按 `meta.lines` 或 `subtitle_repair.corrections` 逐行 OCR，
不通过就移入 `素材库/已剪成片/字幕待修复`，没有校对稿的新片暂缓发布。日常修字只需
按 `legacy_sub.mode=cover` 重渲并更新 `meta.lines` / `subtitle_repair`，发布闸门会自动复检。

## 已知限制与风险

- 自带字幕的素材默认保留原 AI 字幕；需要修字时用 `legacy_sub.mode=cover` 遮盖原字幕带后按校对稿重打，改稿后必须重渲并复检。
- 无字幕素材的 ASR 只做初稿：品牌名、口音、背景音会听错，发布前必须人工过一遍字幕。
- BGM 来自本机曲库并按内容关键词自动匹配；如需替换，改 `config.json` 的 `bgm.rules`
  或在 `bgm.default` 指定。BGM 是否可商用取决于曲目授权，对外投放前确认版权。
- 所有 26 条素材都是约 23.5fps（1083/46）720×1280，导出时上采样到 30fps / 1080×1920，
  画面清晰度不能超过源素材。
- 内置 `QQ视频20261101142136.mp4` 是已发布的 11月1日.mp4 的原始素材，批量跑之前先确认是否要跳过。

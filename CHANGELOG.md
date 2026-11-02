# 变更记录

## 2026-11-01

- 新增自动发布模块 `scripts/publish/`：`lib.js`（排期/库存索引/文案）、`publish_one.js`（上传→标题简介话题→封面→位置门店→AI 声明→发布→内容管理核实）、`run_due.js`（每 5 分钟入口）、`prepare.js`（库存不足自动剪辑）、`notify.ps1`（Toast 通知）。首次无人值守发布 `11月1日_28783052.mp4` 成功，内容管理状态「审核中」，文件移入 `已剪成片/已发`。
- 注册 Windows 计划任务 `TuangouPublish`（每 5 分钟）与 `TuangouPrepare`（08:40 起每 30 分钟）；发布使用 Playwright 自带 Chromium 无头运行，不占用日常 Chrome。
- `prepare.js` 增加空闲清库存：发布窗口外，或距下一个待发作品 60 分钟以上且无发布进行中，只要 `素材库/未剪素材` 有素材就自动剪成成片，源素材移入 `已剪`。
- 排期固化：第 1 天 2 条，此后每天 +2 至 8 条，第 5 天起随机 8–12 条；时间窗 09:00–22:30、最小间隔 25 分钟。成片发布后移入 `已剪成片/已发`，剪辑源素材移入 `未剪素材/已剪`。
- 发布参数按宝哥确认固化：只加位置门店（不挂团购商品）、勾选「内容由AI生成」、保持「不同时发布」，详见 `docs/handover/DOUYIN_VIDEO_PUBLISH_WORKFLOW.md` 的「自动发布固化参数」。
- 后台运行 + 微信通知：`TuangouPublish` / `TuangouPrepare` 直接调用 `node.exe`，关掉 Claude Code 窗口后继续剪辑和发布；两个计划任务关闭「使用电池时禁止启动」「切换到电池时停止」。新增 `lib.js#pushWeChat()`，发布成功、发布暂停、库存为空、发布失败、自动剪辑完成/失败同时推 Windows Toast 与微信；开关在 `config.json` → `notify.wechat`。
- 新增品牌识别 `scripts/auto-edit/brand_ocr.py` + 品牌目录 `scripts/auto-edit/brands.json`：
  人工覆盖 > 画面 Dabao-OCR > 口播文本，识别不到 / 冲突 / 多品牌接近 / 仅短别名近似命中时标人工复核，不猜；
  结果写入 `runtime/auto-edit/brand_index.json` 与成片 `meta.json` 的 `brand` 字段，供发布选门店。
- 品牌 OCR 分辨率提到 `brand_ocr.max_side_len` 2048（默认），招牌小字识别明显提升：
  00791652 / 3E0A8657 / FA7F65F3 由「未识别」修正为麦当劳（画面 McS，口播香辣鸡腿肉 + 买一送一）；
  麦当劳已录入 `brands.json`。699A8A3B / 9D39C6D6 按宝哥确认「素材库咖啡只有瑞幸、没有库迪」
  以及口播/画面「莓果酸奶饮」写人工覆盖为瑞幸咖啡。
- 修正短别名弱匹配汇总：同一条素材只要有一帧完整读到别名（相似度 1.0），
  即使分数更高的模糊命中排在前，也不再标人工复核（B8E05EEA 读到完整「MR.X」即通过）；
  品牌识别缓存 VERSION 提到 4。
- 新增商品人工确认 `runtime/auto-edit/product_overrides/<素材名>.json`（`product` + `note`），
  商品写入 `brand.json` / `brand_index.json` 的 `product` 字段并随成片 `meta.json` 落盘；
  已知商品：麦辣鸡腿堡（3 条）、莓果酸奶饮（2 条）、海鲜大咖蛙蛙煲（2 条）。
- 取消「黑条遮挡 + 重打我们的字幕」方案：检测到素材自带烧录字幕时整条跳过字幕环节
  （不加黑条、不叠字幕，保留原字幕）；无字幕素材仍自动生成字幕。移除黑条绘制、
  字幕换行点对齐与 `legacy_bar` 覆盖逻辑。
- OCR 统一迁移到 Dabao-OCR 常驻服务（`127.0.0.1:18224`）；本机 RapidOCR 已卸载，
  `brand_ocr.py` 改为标准库 HTTP 调用、无第三方 OCR 依赖。
- 新增片头白线冲刺特效与 whoosh 音效（`scripts/auto-edit/fx.py`，本地确定性生成）：
  0～0.6s 人物四周向外扩散的白色放射线，叠加 0.9s 合成音效，音量可配。
- 实测 `已发/11月1日.mp4` 与原素材 `QQ视频20261101142136.mp4` 的音频波形相关系数约 0.99
  （0～3 秒段 0.995 左右、2～12 秒段 0.991），增益拟合后仍一致，残余仅为 AAC 编码误差；
  画面差异只落在字幕带。样片本身没有白线冲刺效果与音效，本次特效为按需求新建。
- 新增自动剪辑模块 `scripts/auto-edit/auto_edit.py`：ASR 断句 + 校对稿、烧录字幕自动遮挡、
  BGM 自动匹配、1080×1920/30fps/HEVC 导出与自检；试剪出首条审核样片。
  （烧录字幕遮挡方案已于同日取消，保留为历史记录。）
- 黑条改为「按字幕层各出一条贴边细黑条、不做纵向合并」，并收紧上下余量（样片中段遮挡
  高度由 357px 降到 63px + 93px 两条，画面中部保留 129px 可见区域）；`legacy_sub.min_score`
  调为 0.3，避免弱字幕层漏检。（该方案已于同日取消，保留为历史记录。）
- 文案闸门加固（`scripts/publish/lib.js`）：新增常见 ASR 同音错字纠正、片尾寒暄与低俗词过滤、
  断句碎片丢弃、跨句商品名合并与去重；标题必须含卖点词，否则用 `meta.json` 的商品名兜底；
  `copyClean()` 增加 GARBLE/SUSPECT 检查，断句或低俗内容明显的成片不自动发。
- 新增 `scripts/publish/publish.test.js`（`node --test`，零依赖）：覆盖排期 2/4/6/8、时间窗与 25 分钟间隔、
  同日可复现、文案过滤/黑名单/长度/话题、ASR 错字与断句修复，共 14 项。
- 2026-11-01 22:03 第二条无人值守发布成功（`11月1日_35241E73.mp4`，临榆炸鸡腿，状态「审核中」）；
  同日批量剪辑 24/24 完成，源素材已全部归档到 `未剪素材/已剪`，当前 21 个成片通过文案闸门。
- 修复点击发布后的重复发布风险：`publish_one.js` 在点击前就置 `clickedPublish`，captcha/auth 和
  `publish-result-unknown` 返回都附带它；`run_due.js` 先判 `clickedPublish`（`reason` 为
  `publish-result-unknown` 时同样视为已点击），一律 `pending_verify` + `_unverified_` 移出队列并通知
  人工核实，不再自动重试；`markUnverified` 改名失败时写入 `state.excluded_videos`，`pickVideo` 同时排除
  排除表与计划中 `pending_verify`/`rejected` 的成片。
- `run_due.js --dry-run` 全链路无副作用：`ensurePlan` 支持 `save:false`，计划保存、Toast、微信、
  `spawnPrepare` 全部加 `!dryRun` 保护，发布返回后统一提前退出。
- 文案闸门再加严：低俗词（我操/尼玛/拉屎等）、控制字符、换行、纯标点标题、非白名单字符一律不通过。
- `buildTimes` 压缩窗口放不下时间隔时宁可少发，不再产生多条相同 22:30；「不同时发布」必须读到明确选中
  状态才发布；`TuangouPrepare` 触发器改为 08:40 起每 30 分钟。
- 新增 `run_due.test.js` 沙箱端到端测试（7 项，含「结果未知未带 flag 也不重试」）；`publish.test.js` 增至 16 项。

## 2026-10-31

- 根据用户实测观察，固化抖音图文至少 2 张、禁止单图提交；保留原单图流程作为历史记录，详见 ADR-001。
- 建立柿柿可利买家实拍素材库目录和授权/质量登记模板。未将公开评价图片批量抓取或加入素材库；须先取得覆盖商业宣传用途的素材授权。
- 用户将后续带货内容方向调整为约 15 秒 AI 单人口播视频，由用户通过豆包生成后审看；记录于 ADR-002。

## 2026-10-31

- 初始化项目仓库、Phase 0 状态与能力记录，并添加本地图片渲染实验。

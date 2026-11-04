# 自动发布模块

无人值守把 `素材库/已剪成片` 的成片发布到抖音创作者中心，发布后归档到 `已剪成片/已发`。图文模块已暂停，本目录只服务视频。

## 文件

| 文件 | 作用 |
|---|---|
| `config.json` | 路径、排期窗口、文案上限、发布开关 |
| `lib.js` | 排期生成、库存索引、品牌/商品词识别、文案生成 |
| `publish_one.js` | 单条发布全流程（Playwright 无头 Chromium） |
| `run_due.js` | 定时入口，每 5 分钟发布最多 1 条到期作品 |
| `prepare.js` | 库存不足时 `--all` 补货；空闲时窗口外 `--all` 清完、窗口内一次剪一条；已有 auto_edit 进程时跳过 |
| `login.js` | 首次/失效后扫码登录，持久化 profile |
| `publish.test.js` | `node --test` 回归测试：排期、文案过滤、乱码黑名单、长度与话题 |
| `publish_settings.test.js` | 发布设置回归（本地 HTML + Chromium）：必须选中「不同时发布」，取消并复核今日头条/红果短剧同步项 |
| `run_due.test.js` | 沙箱端到端测试：dry-run 无副作用、点击发布后遇验证码不重发、排除表生效 |
| `notify.ps1` | Windows Toast 通知 |

## 运行状态

- 计划任务：`TuangouPublish`（每 5 分钟）、`TuangouPrepare`（每 30 分钟检查，全天运行）
- **后台独立运行**：两个计划任务直接调用 `node.exe`，不依赖 Claude Code 会话，关掉 Claude Code 窗口后继续剪辑和发布
- **电池策略**：已关闭「使用电池时禁止启动」和「切换到电池时停止」，笔记本拔电后计划任务照常运行
- 剪辑空闲判定：发布窗口外一次清完未剪素材；窗口内距下一个待发作品 60 分钟以上且没有发布进行中，每次剪一条；刚复制进来的素材要等 2 分钟稳定后再剪
- 运行时数据：`runtime/publish/state.json`、`runtime/publish/plans/YYYY-MM-DD.json`、`runtime/publish/logs/YYYY-MM-DD.log`
- 浏览器 profile：`runtime/browser-profile`；Chromium：`C:/Users/20200/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe`

## 重要消息推送

同时在 Windows Toast 和微信推送这些事件：

| 事件 | 文案前缀 |
|---|---|
| 发布成功 | `✅ 抖音已发布`（标题、成片名、作品 ID） |
| 验证码 / 安全校验 / 登录失效 | `⛔ 抖音发布已暂停` |
| 成片库存为空 | `⚠️ 团购发布等素材`（每小时最多一次） |
| 品牌不确定，跳过未发布 | `⚠️ 团购发布等待品牌确认`（每小时最多一次） |
| 重试耗尽的发布失败 | `❌ 抖音发布失败` |
| 点击发布后结果未确认 | `⚠️ 抖音发布结果待核实`（成片已移出自动队列，不重试） |
| 已发布但审核不通过 | `❌ 抖音作品审核不通过`（成片已移出自动队列） |
| 自动剪辑完成 | `🎬 自动剪辑完成`（本次新增数量、当前待发库存） |
| 自动剪辑失败 | `❌ 自动剪辑失败` |

- 实现：`lib.js` 的 `pushWeChat()` 调用 `C:/Users/20200/.claude/channels/weixin/push.mjs --text`，清代理环境变量、`NO_PROXY` 覆盖 `weixin.qq.com` / `ilinkai.weixin.qq.com`；失败只写日志，不影响发布
- 开关：`config.json` → `notify.wechat`（false 关闭）与 `notify.wechat_push_script`
- 微信返回 `ret=-2 prepare failed` 表示 `context-token.json` 里的会话 token 过期：给微信机器人发任意一条消息刷新后再重试

## 排期规则

- 第 1 天 2 条，此后每天 +2，到第 4 天 8 条；第 5 天起每天随机 8–12 条
- 时间窗 09:00–22:30，相邻作品最小间隔 25 分钟；同一天可复现（seeded random）
- 当天首次建计划时若随机时间已过，剩余时间压缩到「现在 +5 分钟 ~ 22:30」

## 发布流程

上传 → 标题/简介/话题 → 封面（竖 3:4，横封面由抖音自动生成）→ 位置门店（品牌确认后必须挂上）→ 自主声明「内容由AI生成」→ 预检 → 发布 → 内容管理按标题核实 → 移入 `已发`。

预检要求「同时发布」设为「不同时发布」：必须读到明确选中状态，且「同步到今日头条」「同步到红果短剧」均未被勾选，才放行；脚本会先主动取消这些同步项再复核，读不到状态或有同步项残留时会再确认一次，仍不满足就不发布。品牌已确认但门店没挂上时不发布，成片留队重试/通知，绝不裸发。点击「发布」之后，无论随后遇到验证码、登录失效还是页面未确认，一律按「结果待核实」处理：成片加 `_unverified_` 前缀移出自动队列、计划标 `pending_verify`、通知人工核实，绝不自动重试；改名失败时把成片写进 `state.excluded_videos`，同样不会再被选中。审核不通过同理移出队列。

文案质量闸门：片尾口播（点赞/订阅/打赏/栏目/感谢观看等）、纯英文行、口吃重复、从半句开始的碎片会被过滤；常见 ASR 同音错字（豚→囤、买一送衣→买一送一、粉紫便便→粉紫渐变等）自动纠正；标题至少包含一个卖点词，否则用 meta 里的商品名兜底。标题或描述命中乱码/低俗词（如「特大粪」「赤道称」「我操」「尼玛」「拉屎」等）、控制字符或换行，标题含非白名单字符或纯标点时，整条成片不自动发，换下一条，并每小时最多通知一次。

品牌闸门：无品牌、`needs_review=true`、或置信度低于 `publish.brand_min_confidence`（默认 0.9）的成片一律跳过未发布，并微信通知「等待品牌确认」；跳过后继续发下一条品牌能确定的，发布成功通知里会列出跳过的成片名。被跳过的成片留在库存，等宝哥人工审核确认品牌后再发。品牌确认后不论 `verified` 是否 true 都挂位置门店，未认证品牌只是不挂品牌话题。OCR 对仿品牌字不可靠（`11月1日_00791652.mp4` 被读成 McS/McSa，宝哥确认为肯德基），人工核验要联网多搜索到能确定为止，仍不能确定就放弃该条，绝不猜着发。

品牌待确认归档：人工核验后仍不能确定品牌的成片，移到 `素材库/已剪成片/品牌待确认/`（子目录不被 `listVideos` 扫描，等于移出自动队列），同目录写 `待确认清单.md` 记录画面商品、疑似品牌和不能确认的原因，等宝哥人工确认；确认后把成片移回 `已剪成片` 并更新该条 `meta.json` 的 `brand` 字段（`source: manual`）。2026-11-02 首批 7 条已由宝哥在文件名标注品牌并移回，已补写对应 meta 和 `brand_index.json`（`confidence: 0.95`、`needs_review: false`）重新入队；同批另有 3 条手动标注成片（`好想来4`、`好想来6`、`沪上阿姨`）补跑 ASR、写 meta 后入库。

## 暂停与恢复

- 验证码 / 安全校验 / 登录失效：`state.json` 写入 `paused: true` 并发通知
- 恢复：重新运行 `node scripts/publish/login.js` 扫码，确认后把 `paused` 改回 `false`、`paused_reason` 置 `null`

## 手动调试

```bash
node --test scripts/publish/publish.test.js   # 排期/文案回归测试
node --test scripts/publish/run_due.test.js   # 沙箱端到端：dry-run 无副作用、点击发布后遇验证码不重发、排除表
node scripts/publish/run_due.js --dry-run     # 不真正点击发布
node scripts/publish/publish_one.js --dry-run # 单条走查，留下截图
node scripts/publish/prepare.js --dry-run     # 只看库存判断
```

`run_due.test.js` 会把脚本复制到系统临时目录、用桩替换发布器，绝不读写真实素材与 `runtime/publish` 状态；跑完自动删除临时目录。

截图落在 `runtime/publish/shots/`。

自动队列只发有 `meta.json` 的成片；手动放进 `已剪成片` 的文件默认不进队列（`has_meta=false`），需要补写 meta（`output` 指向成片绝对路径、`brand` 用 `source: manual`）或单独运行 `publish_one.js`。

# 团购项目减负落地报告（2026-11-08）

项目：D:\@kaifa\tuangou　备份：D:\@kaifa\tuangou\backup_20261107\

## 0 结论

A1–A7 与 B1、B2、B4、B5、B6、B8、B11 全部落地；三项自检全绿（均 exit 0，46 项测试全过）；12 个改动文件备份齐；微信推送彻底下线（代码 / 配置 / 日志字样全部清除）。B3、B7、B9、B10 按要求只写改法、未落代码。

## 1 动手前的核对（已改完 / 改一半 / 完全没动）

- **已改完**：12 个文件（见第 5 节备份清单），逐条功能都在代码里验证过（不是看交接记录，是重新检索 + 读实现）。
- **改到一半**：无。上一轮出现过 5 个文件被误截成 0 字节，处理方式是**按备份还原后重做**（选「还原后重做」，不选「直接改完」），本轮已确认没有残留的半截状态。
- **完全没动**：B3、B7、B9、B10 —— 按指令不落代码，改法写在第 6 节。
- 另：scripts/publish/quarantine.test.js 没有对应备份，因为它在 git 里是未修改状态（不是本次改动文件），无需备份。

## 2 逐条落地（文件 : 行）

### A 档

| 项 | 位置 | 做了什么 |
|---|---|---|
| A1 | prepare.js:138-145 | available 改成与发布端同口径：L.pickVideo().filter(v => L.brandConfirmed(v) && SG.confirmed(v) && copyClean(...))，并把 subtitle_gate 引入 prepare（prepare.js:7） |
| A2 | subtitle_gate.js:31-34, 249-250 | 一轮最多审 subtitle_max_audits（默认 3）条、总耗时不超过 subtitle_round_budget_sec（默认 600 秒），超出的记 deferred 留到下一轮 |
| A2/A7 | run_due.js:39-65 | 锁文件写 process.pid，持锁方每 60 秒刷 mtime 当心跳；取锁时先看 pid 是否存活（lib.js:711-716 isPidAlive），只有「进程真没了」或「心跳真过期」才接管，否则 skip |
| A3 | subtitle_gate.js:164-180 | manual 超过 subtitle_manual_ttl_hours（默认 24）仍无校对稿 → 移入「字幕待修复」，记录 manual_moved_to 保证不再重复处理，通知不再每小时刷 |
| A4 | lib.js:673-698 chromiumPath()；publish_one.js:8-10 | 环境变量 TUANGOU_CHROMIUM → config.publish.chromium_path → 扫 ms-playwright/chromium-* 取最高版本 → 兜底留空走 playwright 自带；测试里那份抄写改成调用 require('./lib').chromiumPath()（publish_settings.test.js:10） |
| A5 | lib.js:700-709 resolvePython()；subtitle_gate.js:17-29；auto_edit.py:42 | Python 候选链：环境变量 → 传入候选 → PATH，且必须 -c 探测通过才算数；字幕闸门不再单点依赖 openviking 的 venv；Python 侧重依赖（numpy/opencv）改为按需导入，--list 不再因缺依赖起不来 |
| A6 | auto_edit.py:835-855 | --skip-existing 真正生效：同名成片已存在 + 上次 verify.ok + 素材 mtime 不比成片新 → 跳过不重渲并打日志 |
| A7 | prepare.js:53-68 | prepare 的锁同样写 pid + 先判存活，进程被强杀后不再静默跳过 4 小时 |

### B 档

| 项 | 位置 | 做了什么 |
|---|---|---|
| B1 | lib.js:6-20；auto_edit.py:38, 71-74 | ROOT 由文件位置推导（可用 TUANGOU_ROOT 覆盖），两份 config 里的相对路径在加载时统一按 ROOT 还原成绝对路径；配置里不再写死盘符 |
| B2 | lib.js:21-22；prepare.js:29-30 | 品牌库、素材目录都读 config（paths.brands_file / paths.source_dir），与 auto_edit.py 同源 |
| B4 | lib.js:718-727 renameAll()；prepare.js:127-128；run_due.js:108 | 改名逻辑收进 lib 一份，两边都调，不再各抄 11 行 |
| B5 | config.json publish.brand_min_confidence: 0.9；lib.js:219, 258；剪辑端 auto-edit/config.json 同步 0.9 | 剪辑端和发布端一个阈值，不再「剪完就被移到品牌待确认」 |
| B6 | publish_one.js:40-42；config.json upload_timeout_sec: 240、publish_result_timeout_sec: 240 | 上传与发布结果等待时间进配置，长视频不再 90/120 秒就判超时白传 |
| B8 | lib.js:183-186, 243-245, 305-308；subtitle_gate.js:67-70 | name → meta 建 Map，去掉循环里的 find；计划文件只解析最近 7 天 |
| B11 | lib.js、run_due.js、prepare.js、publish_one.js、config.json、README.md | pushWeChat() 实现与导出删除；**实际删掉 14 个调用点**（审计估 12，实测多出 2 处），另删两处本地 wechat() 包装函数、config 的 notify.wechat / notify.wechat_push_script 两个字段、README 里的说明。发布流程不再为它起任何 PowerShell 进程 |

## 3 A1 的数字：available 38 → 38（没降，原因已查清）

- 改前：prepare.js 的 available = L.pickVideo().length = **38**。
- 改后：叠加品牌 + 字幕闸门 + 文案质量过滤 = **38**。
- 逐条核对：38 条成片的字幕审计缓存状态是 35 条 legacy_ok + 3 条 ok，**没有一条是 manual/fail/unavailable**，所以闸门没有额外剔除。
- 审计里预测的「38 掉到 18」实测不成立：缓存里 23 条 manual 记录对应的片子没有 meta，本来就不在 pickVideo() 的队列里（队列只收「有 meta、未发、未排除」的片）。
- 也就是说 A1 修掉的是**口径不一致的隐患**（以后任何一条片子过不了闸门，available 会立刻少算），而不是当前的数字虚高。

**顺手发现一个更要紧的事实**：prepare --dry-run 显示 source=0，日志写 no source clips left —— 素材库/未剪素材 已经空了。库存 38 条发完就断货，卡点不在代码，在**没有新素材**。

## 4 自检（后台隐藏进程跑，输出重定向到文件后读回）

| 检查 | 命令 | 结果 |
|---|---|---|
| 单元测试 | node --test 5 个测试文件 | exit 0，tests 46 / pass 46 / fail 0 |
| 剪辑入口 | python scripts/auto-edit/auto_edit.py --list | exit 0（待剪素材 0 条） |
| 发布准备 | node scripts/publish/prepare.js --dry-run | exit 0，day=8 target=5 published=0 remaining=5 available=38 source=0 idle=true |

日志：runtime/logs/selftest.summary.txt、selftest.test.log、selftest.list.log、selftest.prepare.log

## 5 备份清单（改前原件，保持原相对路径，字节数）

```
scripts/publish/lib.js                    29459
scripts/publish/prepare.js                 6588
scripts/publish/run_due.js                18636
scripts/publish/publish_one.js            19156
scripts/publish/subtitle_gate.js           9260
scripts/publish/config.json                1671
scripts/publish/README.md                 11062
scripts/publish/publish.test.js           12476
scripts/publish/publish_settings.test.js   7909
scripts/publish/run_due.test.js           12614
scripts/publish/subtitle_gate.test.js      5689
scripts/auto-edit/auto_edit.py            36517
```

## 6 B3 / B7 / B9 / B10：只写改法，未落代码

- **B3 prepare.js 的 sourcesReady()**：现在要求全部素材都稳定 2 分钟，一条在同步就整批不剪，日志只说 skip this round。改法：改成逐条判断，跳过不稳定的、剪稳定的那些；至少把卡住的文件名和剩余等待秒数写进日志。
- **B7 publish_one.js 的 shots/**：每次发布存 3–4 张 PNG 从不清理（现 121 张 / 18MB）。改法：run_due 每轮顺手删 14 天前的截图，保留最近两周用于排查。
- **B9 auto_edit.py 的 run()**：子进程没有 timeout，ffmpeg / faster-whisper 卡住只靠 prepare 外层 45 分钟兜。改法：给 run() 加 timeout=，按阶段取值（探测 60s、渲染 900s、ASR 1800s），超时抛错并落日志。
- **B10 auto_edit.py 的 work 目录**：work/<stem>/ 与 fx 帧缓存只建不删（96 个目录 / 817MB / 5827 文件）。改法：成片发布成功后删该条 fx/ 帧；work/ 目录按 30 天清理。**磁盘清理本身已交给电脑管家按本人授权口径执行，本轮未动任何成片、素材、中间目录。**

## 7 未验证 / 风险

- 计划任务是否按新代码跑起来（本轮不改、也不查 Windows 计划任务；下一轮 5 分钟/30 分钟的定时执行才是真正的端到端验证）。
- A3 的 24 小时出口只在 run_due 调 auditInventory 时才真正搬文件，本轮 prepare --dry-run 不触发，字幕待修复 目前 0 个文件属正常。
- --skip-existing 只用单元测试与代码审查验证，没有真实重跑一整批素材（那样会占用素材目录）。
- 顶层还有 21 条成片没进可发队列，原因是它们没有 meta（手工/旧成片），不是品牌问题：品牌索引里这 21 条都有记录，只有 1 条标了 needs_review。要发它们得补 meta 或用 publish_one.js 单发，属业务口径，不在本轮代码范围。

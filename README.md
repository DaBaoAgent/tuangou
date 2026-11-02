# 抖音团购视频工作室

图文模块已暂停，当前只保留「自动剪辑视频 + 定时自动发布」。需求基线见 [开发规格](douyin-groupbuy-studio-development-spec-v1.0.md)，变更决策见 [ADR-001](docs/adr/ADR-001-multi-image-post.md) 和 [ADR-002](docs/adr/ADR-002-ai-video-workflow.md)，进度见 [当前状态](docs/handover/CURRENT_STATUS.md)，平台能力见 [能力矩阵](docs/CAPABILITY_MATRIX.md)，发布规则见 [视频发布流程](docs/handover/DOUYIN_VIDEO_PUBLISH_WORKFLOW.md)。

## 自动剪辑与发布

- 剪辑：`scripts/auto-edit/auto_edit.py --all`，成片写入 `素材库/已剪成片`，源素材移入 `素材库/未剪素材/已剪`。
- 发布：`scripts/publish/`，计划任务 `TuangouPublish` 每 5 分钟发布到期的 1 条，成片发布后移入 `素材库/已剪成片/已发`；`TuangouPrepare` 每 30 分钟检查一次，库存不足或空闲时把 `未剪素材` 的新素材剪成成片。
- 运行说明见 [`scripts/publish/README.md`](scripts/publish/README.md)。

## 本地渲染实验

需要 Node.js、Playwright、Sharp 和兼容的 Chromium。实验依赖需由运行环境提供，例如将 `NODE_PATH` 指向包含这两个包的目录；也可通过 `PHASE0_BROWSER_PATH` 指定浏览器可执行文件。运行 `node scripts/phase0-render.cjs`，结果写入被 Git 忽略的 `runtime/phase0/`。此实验只使用虚构的排版测试文字，不是商品或可发布素材；它不验证抖音上传、OCR 或字体商用许可。

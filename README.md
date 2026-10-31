# 抖音团购图文工作室

当前处于 Phase 0 技术验证，尚不是可发布的应用。需求基线见 [开发规格](douyin-groupbuy-studio-development-spec-v1.0.md)，进度见 [当前状态](docs/handover/CURRENT_STATUS.md)，平台能力见 [能力矩阵](docs/CAPABILITY_MATRIX.md)。

## 本地渲染实验

需要 Node.js、Playwright、Sharp 和兼容的 Chromium。实验依赖需由运行环境提供，例如将 `NODE_PATH` 指向包含这两个包的目录；也可通过 `PHASE0_BROWSER_PATH` 指定浏览器可执行文件。运行 `node scripts/phase0-render.cjs`，结果写入被 Git 忽略的 `runtime/phase0/`。此实验只使用虚构的排版测试文字，不是商品或可发布素材；它不验证抖音上传、OCR 或字体商用许可。

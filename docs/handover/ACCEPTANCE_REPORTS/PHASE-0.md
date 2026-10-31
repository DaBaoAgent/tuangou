# Phase 0 验收记录（进行中，未通过）

2026-10-31：初始化独立仓库，完成环境检查和本地渲染实验。运行环境使用 Node 24.22.1、Codex 随附 Playwright/Sharp 和系统 Chrome；依赖未作为项目生产依赖安装或完成许可审查。命令：PowerShell 设置 `NODE_PATH` 为本机 Codex runtime 的 `dependencies/node/node_modules`，设置 `PHASE0_BROWSER_PATH` 为系统 Chrome 路径，执行 `node scripts/phase0-render.cjs`。输出 PNG 元数据为 1242×1660、sRGB；目视检查样例中文未见缺字。图片是排版测试，不能用于发布；字体商用授权未核验。默认浏览器路径在受限环境中未找到匹配版本，指定 Chrome 后成功。

尚未完成：Node 22、持久化 profile、真实账号及商品/UI、上传约束、OCR 对比、AnyText2、开源依赖及素材许可、脱敏截图与 ADR。无平台发布或商品核验结果。Phase 0 门槛未满足，不进入真实自动发布开发。当前提交可通过 `git log -1` 查看，提交号不会自引用写入提交本身。

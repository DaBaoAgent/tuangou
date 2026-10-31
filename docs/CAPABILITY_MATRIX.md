# Phase 0 能力矩阵

状态仅使用 verified、unavailable、requires_manual、unknown；verified 须有真实证据。

| 能力 | 状态 | 证据 / 下一步 |
|---|---|---|
| 达人账号权限及会话 | requires_manual | 尚未登录；需要用户在可见浏览器中授权登录 |
| 图文发布入口及图片格式、大小、比例 | unknown | 需在真实账号 UI 实测 |
| 主商品搜索、选择与挂载 | unknown | 需真实 UI 核验，不能以搜索结果代替 |
| 智能推荐相关产品 | unknown | 需检查实际账号界面 |
| 发布成功及作品 URL 识别 | unknown | 首次 live test 必须由用户明确批准 |
| 首测商品可售、推广资格、套餐 | unknown | 必须在账号商品入口实时核验 |
| 抖音公开调研来源 | unknown | 待验证访问及可用范围 |
| 小红书公开视觉参考来源 | unknown | 待验证访问及使用范围 |
| Playwright 持久化 profile | unknown | 待本地最小 PoC |
| 中文渲染与 PNG 输出 | verified | 本机 Chrome + Playwright + Sharp 实验生成 1242×1660 sRGB PNG；样例文字目视无缺字。仅证明此样例，不代表全部字体或平台接受 |
| OCR 中文准确率和耗时 | unknown | 待安装并评测 RapidOCR / PaddleOCR |
| AnyText2 可选实验 | unknown | 待评估；不阻塞核心方案 |
| 素材、字体和生产依赖许可 | unknown | 逐项核验，未审素材不得进入生产 |

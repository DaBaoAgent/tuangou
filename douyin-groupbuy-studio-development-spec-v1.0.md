# 抖音团购图文自动化系统： tuangou

## 完整开发规格、技术选型、接口契约与阶段验收计划

> **文档版本：** v1.0\
> **编制日期：** 2026-10-31\
> **项目状态：** 需求基线已确认，可进入 Phase 0 技术验证\
> **首轮开发负责人：** Codex\
> **后续可接手 Agent：** 豆包、Claude
> Code、WorkBuddy，以及其他支持代码仓库与命令行工作的 Agent\
> **部署目标：** Windows 本地优先\
> **V1 核心目标：**
> 自动调研团购商品与达人内容，生成高质量单张抖音风格静态图文，完成商品相关性校验，并通过正常抖音发布界面发布和挂载团购商品。

------------------------------------------------------------------------

# 0. 给接手开发的 Agent：先读这里

本文件是项目的**唯一需求基线**。开发时不得凭感觉补充用户未确认的业务规则；不得把已经取消的方案重新引入。

## 0.1 不可变更的核心决策

1.  新建一个**完全独立项目**，独立 Git
    仓库、独立目录、独立数据库、独立运行环境。
2.  首轮由 **Codex 开发**；代码和文档必须做到 Agent
    无关，未来豆包、Claude Code、WorkBuddy 可以接手。
3.  **不接入 AutoJY、dengju，不复用其视频引擎或管线。**
4.  **不依赖 PostFlow
    的运行环境**。可以在许可证允许的前提下研究相关开源项目的实现方式，但必须独立封装、明确来源和许可证，不把它们作为
    V1 运行依赖。
5.  V1 只做**单张静态抖音图文**，暂不做视频生产。
6.  每个候选团购商品生成 **3 张不同创意方向的候选图**，系统评分后选择 1
    张发布；不是 3 张轮播。
7.  图片规格基线为 **3:4、1242 × 1660 px、PNG**。Phase 0
    必须验证当前抖音图文发布界面是否接受该尺寸、文件大小和格式；如平台要求不同，保留
    3:4 设计比例并按平台要求导出。
8.  视觉方向全面切换为**抖音审美**，不再采用小红书手帐风。
9.  两种主力视觉风格：
    -   **大标题视觉海报型**：可使用真实、授权的菜品/门店照片；标题和真实素材占比由
        AI 根据商品与素材质量决定。
    -   **纯文字 +
        卡通贴图型**：完全不放菜品照片；以高密度文字、人物/动物贴图和图形装饰构成画面。
10. 初始建设 **5--8 套精品模板**，建立 **30--50
    个**允许商业使用的开源贴纸素材。素材类别均衡覆盖动物、人物、手绘装饰，不固定
    IP，不做大型原创贴纸库。
11. 纯文字贴图型采用高信息密度：一个强标题、3--5
    组核心短句、少量辅助小字、卡通贴图和装饰；画面必须有清晰阅读层级。
12. 每个商品的 3
    张候选图必须在构图、文案角度或视觉组织上有实质差异，不能只换颜色。
13. 抖音达人账号；目标是推广允许该达人推广的其他品牌团购商品，也覆盖全国团购和本地团购。
14. 本地重点区域：**苏州、昆山**；同时保留全国团购选品能力。
15. 达人调研：AI
    自动发现值得研究的达人，综合评估播放表现、可获得的团购表现、内容质量、更新频率和视觉质量；按
    7/30/90 天多窗口分析。真实订单数据不可得时标记未知，严禁推算成事实。
16. 内容调研平台：抖音 +
    小红书。抖音用于研究团购商品和内容表现；小红书仅作为视觉/创意参考来源，最终作品必须重新创作。
17. 选品综合评分：商品热度、佣金、优惠力度、可核实销量/评价、内容创作潜力、视觉吸引力、推广权限、有效期、适用门店与地区。
18. 每日目标产能为 **10
    条以上**，但这只是系统设计目标，不是绕过平台限制的承诺。实际发布频率必须遵守平台规则、账号权限和质量门禁。
19. 内容生成完成且全部检查通过后，按用户已选策略**自动立即发布**。
20. 发布方式为正常浏览器 UI
    操作，使用独立、持久化的抖音浏览器配置文件。首次由用户扫码登录，后续复用正常会话。
21. 发布时先挂载与内容精准匹配的主团购商品；若发布界面提供"智能推荐相关产品"且当前账号可用，则勾选。该功能不可用时，只挂主商品并继续发布。
22. 发布前必须强制检查商品与内容相关性；未通过不得发布。
23. 发布失败最多自动重试 **2
    次**，但每次重试前必须核实是否已经发布，避免重复作品。
24. 检测到验证码、安全验证、登录失效或账号异常时，**暂停全部发布任务**；用户完成验证、系统确认会话恢复后，自动继续剩余队列。
25. 不开发反检测、指纹伪装、验证码绕过、隐藏自动化、规避平台风控或模拟真人以逃避检测的功能。自动化仅用于正常、可见、被允许的界面操作；遇到平台限制就暂停。
26. 运行环境：先在 Windows
    本地部署；开机自启、后台调度、可手动暂停/恢复/停止。
27. 数据复盘不是核心：用户有空时上传抖音后台截图，由系统
    OCR/视觉识别后整理分析；不得把每日上传截图作为工作流阻塞条件。
28. 大模型直接使用运行工作流的 Agent
    所配置的主模型。**不建设多模型路由，不引入模型选型复杂度**。代码只定义单一
    LLM Provider 接口，适配当前运行环境。
29. V1 图片生产采用确定性模板渲染为主：LLM 文案 + HTML/CSS/SVG 模板 +
    Playwright 高清渲染 + Sharp 图片处理 + OCR 验收。AnyText2
    作为可插拔标题增强实验能力，不得成为核心依赖或影响文字准确性。
30. 第一项端到端测试商品：全国团购「爷爷不泡茶」【柿柿可利】「柿柿椰椰 /
    柿柿有杏 2 选
    1」。**必须在实际账号/商品入口核实该商品当前存在、可推广、可挂载、套餐信息有效；不得把历史描述当成当前可售事实。**

## 0.2 开发纪律

-   先做 Phase 0 真实能力验证，再写大规模业务代码。
-   每个 Phase 必须有可运行产物、测试和验收报告。
-   不得用 Mock 成功冒充平台真实成功。
-   不得虚构抖音 API、商品榜单、达人订单数据、发布字段或"智能推荐"控件。
-   平台能力未知时，写入 `capability_matrix.md`，标注
    `verified / unavailable / requires_manual / unknown`。
-   任何真实发布必须经过用户授权的账号会话；开发测试默认使用 dry-run。
-   任何未通过事实核验、素材授权核验、质量门禁的内容不得发布。
-   所有任务可追踪、可恢复、可审计；禁止静默丢任务。
-   不以"增加模块数量"为进度；以端到端真实验收为进度。

------------------------------------------------------------------------

# 1. 项目目标与范围

## 1.1 产品定位

构建一套 Windows 本地运行的**抖音团购图文自动化生产系统**，覆盖：

1.  发现近期值得推广的团购商品和达人内容；
2.  分析商品、套餐、门店、地域、佣金和有效期；
3.  根据商品事实策划图文创意；
4.  每个商品生成 3 张不同方向的 3:4 静态候选图；
5.  通过程序化和视觉质量门禁选择 1 张；
6.  生成发布标题、正文和话题（结构由 AI 按内容决定）；
7.  核验图文与主团购商品的一致性；
8.  使用正常浏览器界面上传图文、挂载主商品并尝试启用智能推荐；
9.  记录发布结果、作品链接、商品、图片版本、文案、日志和截图；
10. 发生可恢复故障时有限重试；遇到账号安全验证时全队列暂停；
11. 用户有空上传后台截图时，识别并更新轻量数据记录。

## 1.2 V1 不做

-   不做视频生成、视频剪辑、BGM 选曲或视频上传。
-   不接入 AutoJY、dengju。
-   不把 PostFlow 作为运行依赖。
-   不开发固定品牌吉祥物/IP。
-   不做大型原创角色/贴纸生图系统。
-   不做复杂数据驾驶舱、每日强制复盘或自动预测订单。
-   不做多模型路由。
-   不做多账号矩阵（数据模型可预留 account_id，但 V1
    只验证一个达人账号）。
-   不做自动私信、评论、点赞、关注等与当前目标无关的账号行为。
-   不做绕过验证码、平台安全检查或反检测。
-   不在未经授权的情况下下载、复用商家/达人图片或受版权保护素材。

## 1.3 成功定义

V1 不是"能运行一段脚本"，而是以下闭环在真实账号授权条件下通过验收：

**选中一个真实可推广团购商品 → 读取并核实商品信息 → 生成 3 张合格候选图
→ 选择 1 张 → 生成发布文案 → 相关性检查通过 → 正常抖音界面挂载主商品 →
智能推荐可用则启用 → 成功发布 → 记录作品 URL 和全量审计数据。**

如果平台界面不提供某项功能，系统必须正确降级或暂停，不得伪造成功。

------------------------------------------------------------------------

# 2. 用户已确认的视觉规格

## 2.1 画布与输出

-   设计画布：1242 × 1660 px，3:4。
-   主输出：PNG。
-   色彩：sRGB。
-   文字边缘清晰，避免缩放后出现锯齿。
-   所有文字必须在最终 PNG 中完整可读。
-   图片安全边距建议：画布四周至少 4%--6%；具体根据模板和抖音 UI
    遮挡实测调整。
-   必须验证抖音发布入口的尺寸、大小、格式限制，不能把本文件中的目标规格当成平台官方限制。

## 2.2 风格 A：大标题视觉海报型

目标：第一眼识别主题，突出商品或核心利益点，具有明显的抖音信息流视觉冲击。

设计规则：

-   大标题为首要视觉锚点，字体可使用超粗黑体、粗体、描边、阴影、色块、倾斜或局部艺术字。
-   真实菜品/门店照片只允许使用来源和授权可核验的素材。
-   标题与真实素材面积由创意策划器根据商品卖点、图片质量、模板构图决定。
-   真实照片仅做商业级轻度精修：亮度、对比度、白平衡、锐度、裁剪、构图和自然光影。
-   不改变菜品真实颜色、形状、分量、配料，不增加不存在的食材。
-   不虚构门店客流、顾客用餐、排队、服务场景。
-   价格/优惠仅在有竞争力且已核实的情况下突出。
-   轻量化种草引导，不用生硬 CTA 堆满画面。

## 2.3 风格 B：纯文字 + 卡通贴图型

目标：不依赖菜品照片，通过高密度文字、人物/动物贴图和图形设计形成有吸引力的创意海报。

强制规则：

-   **完全不放菜品照片**，不允许用 AI 虚构菜品图片替代。
-   以文字为绝对主体。
-   结构建议：1 个主标题 + 3--5 组核心短句 + 少量辅助小字 + 角色贴图 +
    图形装饰。
-   卡通贴图同时承担情绪表达和信息引导，例如表达惊喜、开心、馋嘴，或指向标题/重点卖点。
-   贴图不能遮挡文字，不能占据主体视觉。
-   允许动物、Q 版人物、情侣/家庭类开源素材，按内容自动选择，不固定 IP。
-   允许箭头、爆炸框、价格标签、重点标记、速度线、对话气泡等抖音风图形。
-   高密度不等于拥挤：必须有主次、阅读顺序和足够字间距。
-   商品事实、价格、优惠和套餐内容仍须核实。

## 2.4 配色与字体

-   不固定单一配色。
-   AI 按商品品类、内容情绪、模板选择主色/辅助色/强调色。
-   海报型可采用高对比、鲜明、食欲感配色；纯文字贴图型可采用更丰富的潮流插画色彩。
-   不能机械重复同一配色。
-   建立字体资源目录，优先采用明确允许商业使用的字体。
-   标题、正文、重点词分别管理字体角色。
-   字体元数据包含名称、来源、许可证、是否允许商用、是否允许嵌入/再分发。
-   不得因为字体文件可免费下载就默认可商用。

## 2.5 初始模板

第一批 5--8 套模板，至少包含：

1.  大标题 + 菜品主视觉；
2.  大标题 + 多图形信息块；
3.  高对比价格/优惠海报；
4.  门店/品牌主题海报；
5.  纯文字 + 动物贴图；
6.  纯文字 + Q 版人物贴图；
7.  高密度信息型创意海报；
8.  备用实验模板（可选）。

每套模板必须有： - 模板 ID、版本、适用品类； - 风格类型 A/B； -
版面网格和安全边距； - 标题、正文、价格、贴纸、照片等区域定义； -
字体与颜色 Token； - 可变字段 schema； - 样例图； - 自动布局约束； -
模板回归测试截图。

## 2.6 开源贴纸素材

初始 30--50 个，类别均衡： - 动物； - Q 版人物； - 情绪表情/动作； -
箭头、星星、爆炸框、对话框等装饰。

素材准入： - 必须逐个确认素材本身的许可证；不能只看所在 GitHub
项目的代码许可证。 - 优先 CC0、公共领域、允许商业使用和修改的 CC BY
等许可。 - CC BY 必须保存署名要求。 - 排除禁止商业使用的 NC
许可；不适合修改的 ND 许可不纳入首批。 - 每个素材保存原始文件、PNG
运行文件、来源 URL、作者、许可证文本/摘要、下载时间、是否需要署名、校验
hash。 - 无法确认授权的素材不进入生产库。 - 首版不做原创贴纸生成。

------------------------------------------------------------------------

# 3. 总体技术架构

## 3.1 架构原则

采用**模块化单体（Modular Monolith）**，不要在 V1 过早拆微服务。

理由： - Windows 本地单机运行； - 任务量和并发规模初期可控； - 减少
Redis、消息队列集群、容器编排等维护负担； -
模块通过稳定接口隔离，未来可独立拆分； - Codex 和其他 Agent
容易理解、测试和接手。

核心分层：

1.  Presentation：本地 Web 控制台、CLI。
2.  Application：工作流用例、任务编排、状态机。
3.  Domain：商品、达人、内容、素材、模板、发布等业务模型。
4.  Infrastructure：SQLite、Playwright、图片渲染、OCR、LLM
    Provider、文件系统。
5.  Adapters：抖音 UI、公开内容来源、小红书视觉研究来源、可选 MCP。

## 3.2 推荐技术栈

  ----------------------------------------------------------------------------
  层                      技术                    说明
  ----------------------- ----------------------- ----------------------------
  Runtime                 Node.js 22 LTS          Windows 支持成熟

  Language                TypeScript strict       静态类型和跨 Agent 可维护性

  Package manager         pnpm workspace          依赖管理与 monorepo 工具

  Backend                 Fastify                 轻量 HTTP API

  Validation              Zod                     请求、配置、LLM 输出 schema
                                                  校验

  Database                SQLite                  本地优先，单机部署

  ORM/migrations          Drizzle ORM + SQL       类型安全、迁移可审计
                          migrations              

  Job queue               SQLite-backed durable   V1 不依赖 Redis
                          queue                   

  Browser automation      Playwright Chromium     正常可见 UI 操作，持久化
                                                  profile

  Renderer                HTML + CSS + SVG +      精确中文排版、模板复用
                          Playwright screenshot   

  Image processing        Sharp                   裁切、尺寸、色彩、PNG 导出

  OCR                     OCR adapter；Phase 0 对 不把 OCR 引擎锁死
                          RapidOCR / PaddleOCR    
                          做基准                  

  Frontend                React + Vite            本地控制台

  Logging                 Pino                    结构化日志

  Testing                 Vitest + Playwright     单测、集成、UI 回归
                          Test                    

  API docs                OpenAPI 3.1             供未来 Agent
                                                  和其他客户端接入

  Config                  dotenv + Zod            环境变量校验

  Installer/runtime       PowerShell scripts +    开机启动、安装、更新、备份
                          Windows Task Scheduler  
  ----------------------------------------------------------------------------

**禁止在 V1 无必要引入：**
Kubernetes、Redis、Kafka、微服务集群、复杂向量数据库、模型路由系统。

## 3.3 LLM 接入原则

用户要求直接使用当前运行工作流的 Agent
主模型，不做模型选型和多模型路由。

实现方式： - 定义唯一 `LLMProvider` 接口。 - 当前
Agent/运行环境提供一个可用的模型连接适配器。 - 配置只允许一个 active
provider。 - 不在业务代码中写死模型名称。 -
不实现模型排行榜、动态路由、自动多模型 fallback。 - Prompt、输出
schema、版本和 token/耗时日志独立管理。 - LLM 返回必须经过 Zod schema
校验；不合格可有限重试。 - 对事实类字段，LLM 只能引用采集到的
evidence，不得自行补充价格、套餐、销量、佣金、地址等信息。

若某个 Agent 环境无法直接向本地服务暴露主模型调用能力，Phase 0
选择最简单、可审计的单一适配器；不得为此引入复杂模型平台。

## 3.4 系统组件

### A. Research Engine

-   发现公开可访问的达人和作品；
-   采集作品公开可见信息；
-   7/30/90 天窗口分析；
-   研究图文结构、标题、内容类型、发布频率；
-   研究抖音团购商品和小红书视觉趋势；
-   对不可访问、需要登录、受限制的数据明确标记。

### B. Product Intelligence

-   团购商品标准化；
-   全国/本地分类；
-   苏州/昆山地理匹配；
-   商品有效期、适用门店、套餐、佣金、推广资格核验；
-   候选商品评分；
-   商品变更和失效检测。

### C. Creative Planner

-   只使用商品证据和素材证据；
-   选择创意角度；
-   选择海报型/纯文字贴图型；
-   选择模板、配色、字体和贴图；
-   生成三套差异化创意 brief；
-   生成标题/正文/话题；
-   输出结构化 JSON，不直接自由绘制最终图。

### D. Static Image Renderer

-   根据模板 schema 生成 HTML；
-   CSS/SVG 布局；
-   Playwright 输出 1242×1660；
-   Sharp 处理与导出；
-   候选图 3 张；
-   生成缩略图和预览。

### E. Quality Gate

-   商品事实校验；
-   素材授权校验；
-   OCR；
-   文本完整性；
-   文字重叠/遮挡；
-   视觉布局；
-   图片尺寸/文件格式；
-   图文与商品相关性；
-   价格/套餐/门店一致性；
-   不通过阻止发布。

### F. Douyin Publisher

-   持久化独立浏览器 profile；
-   用户扫码登录；
-   正常打开发布页面；
-   上传一张图片；
-   填写标题/正文/话题；
-   选择主团购商品；
-   尝试勾选智能推荐相关产品；
-   确认发布状态；
-   保存作品 URL 和截图；
-   遇到验证暂停全部发布队列。

### G. Orchestrator

-   durable job queue；
-   状态机；
-   幂等键；
-   重试；
-   账号全局熔断；
-   定时调研；
-   生产队列；
-   开机自启；
-   人工暂停/恢复。

### H. Local Console

-   系统状态；
-   当前任务；
-   待审核/待发布/失败任务；
-   候选图预览；
-   商品详情和证据；
-   发布历史；
-   账号验证状态；
-   日志与诊断；
-   一键暂停/继续/停止；
-   数据截图上传入口（非强制）。

------------------------------------------------------------------------

# 4. 项目目录结构

建议项目名：`douyin-groupbuy-studio`（最终仓库名可在创建仓库时确定）。

``` text
douyin-groupbuy-studio/
├─ README.md
├─ AGENTS.md
├─ CONTRIBUTING.md
├─ CHANGELOG.md
├─ LICENSE
├─ pnpm-workspace.yaml
├─ package.json
├─ pnpm-lock.yaml
├─ tsconfig.base.json
├─ .env.example
├─ .gitignore
│
├─ docs/
│  ├─ PRD.md
│  ├─ ARCHITECTURE.md
│  ├─ CAPABILITY_MATRIX.md
│  ├─ DATA_MODEL.md
│  ├─ API_CONTRACT.md
│  ├─ PUBLISHER_RUNBOOK.md
│  ├─ VISUAL_SYSTEM.md
│  ├─ SECURITY.md
│  ├─ TEST_PLAN.md
│  ├─ PHASE_PLAN.md
│  ├─ DECISIONS/
│  │  ├─ ADR-0001-modular-monolith.md
│  │  ├─ ADR-0002-image-rendering.md
│  │  ├─ ADR-0003-local-storage.md
│  │  └─ ADR-0004-browser-publishing.md
│  └─ handover/
│     ├─ CURRENT_STATUS.md
│     ├─ NEXT_AGENT_PROMPT.md
│     └─ ACCEPTANCE_REPORTS/
│
├─ apps/
│  ├─ server/
│  │  ├─ src/
│  │  │  ├─ app.ts
│  │  │  ├─ server.ts
│  │  │  ├─ plugins/
│  │  │  ├─ routes/
│  │  │  └─ middleware/
│  │  └─ package.json
│  │
│  ├─ console/
│  │  ├─ src/
│  │  │  ├─ app/
│  │  │  ├─ pages/
│  │  │  ├─ components/
│  │  │  ├─ api/
│  │  │  └─ styles/
│  │  └─ package.json
│  │
│  ├─ worker/
│  │  ├─ src/
│  │  │  ├─ worker.ts
│  │  │  ├─ handlers/
│  │  │  └─ schedulers/
│  │  └─ package.json
│  │
│  └─ cli/
│     ├─ src/
│     │  ├─ index.ts
│     │  └─ commands/
│     └─ package.json
│
├─ packages/
│  ├─ domain/
│  │  ├─ src/
│  │  │  ├─ entities/
│  │  │  ├─ value-objects/
│  │  │  ├─ state-machines/
│  │  │  └─ errors/
│  │  └─ package.json
│  │
│  ├─ contracts/
│  │  ├─ src/
│  │  │  ├─ api/
│  │  │  ├─ events/
│  │  │  ├─ adapters/
│  │  │  └─ schemas/
│  │  └─ package.json
│  │
│  ├─ database/
│  │  ├─ src/
│  │  ├─ migrations/
│  │  ├─ seeds/
│  │  └─ package.json
│  │
│  ├─ workflow/
│  │  ├─ src/
│  │  │  ├─ orchestrator/
│  │  │  ├─ queue/
│  │  │  ├─ policies/
│  │  │  └─ handlers/
│  │  └─ package.json
│  │
│  ├─ research/
│  │  ├─ src/
│  │  │  ├─ douyin/
│  │  │  ├─ xiaohongshu/
│  │  │  ├─ creators/
│  │  │  ├─ content-analysis/
│  │  │  └─ evidence/
│  │  └─ package.json
│  │
│  ├─ products/
│  │  ├─ src/
│  │  │  ├─ normalization/
│  │  │  ├─ eligibility/
│  │  │  ├─ scoring/
│  │  │  └─ geo/
│  │  └─ package.json
│  │
│  ├─ creative/
│  │  ├─ src/
│  │  │  ├─ planner/
│  │  │  ├─ prompts/
│  │  │  ├─ copy/
│  │  │  └─ schemas/
│  │  └─ package.json
│  │
│  ├─ renderer/
│  │  ├─ src/
│  │  │  ├─ render/
│  │  │  ├─ layout/
│  │  │  ├─ typography/
│  │  │  ├─ image-processing/
│  │  │  └─ export/
│  │  ├─ templates/
│  │  │  ├─ poster/
│  │  │  └─ text-sticker/
│  │  └─ package.json
│  │
│  ├─ assets/
│  │  ├─ manifest/
│  │  ├─ stickers/
│  │  ├─ fonts/
│  │  ├─ photos/
│  │  └─ package.json
│  │
│  ├─ quality/
│  │  ├─ src/
│  │  │  ├─ gates/
│  │  │  ├─ ocr/
│  │  │  ├─ visual/
│  │  │  ├─ relevance/
│  │  │  └─ reports/
│  │  └─ package.json
│  │
│  ├─ publisher/
│  │  ├─ src/
│  │  │  ├─ browser/
│  │  │  ├─ douyin/
│  │  │  ├─ selectors/
│  │  │  ├─ flows/
│  │  │  ├─ verification/
│  │  │  └─ reconciliation/
│  │  └─ package.json
│  │
│  ├─ llm/
│  │  ├─ src/
│  │  │  ├─ provider/
│  │  │  ├─ prompts/
│  │  │  └─ output-validation/
│  │  └─ package.json
│  │
│  └─ observability/
│     ├─ src/
│     └─ package.json
│
├─ templates/
│  ├─ poster-001/
│  ├─ poster-002/
│  ├─ poster-003/
│  ├─ text-sticker-001/
│  ├─ text-sticker-002/
│  └─ ...
│
├─ scripts/
│  ├─ install.ps1
│  ├─ dev.ps1
│  ├─ build.ps1
│  ├─ test.ps1
│  ├─ start.ps1
│  ├─ stop.ps1
│  ├─ register-autostart.ps1
│  ├─ remove-autostart.ps1
│  ├─ backup.ps1
│  └─ diagnostics.ps1
│
├─ tests/
│  ├─ fixtures/
│  ├─ contract/
│  ├─ integration/
│  ├─ e2e/
│  ├─ visual-regression/
│  └─ acceptance/
│
├─ runtime/                  # 不提交 Git
│  ├─ data/
│  ├─ logs/
│  ├─ browser-profile/
│  ├─ screenshots/
│  ├─ artifacts/
│  ├─ cache/
│  └─ backups/
│
└─ .github/
   └─ workflows/
      ├─ ci.yml
      └─ release.yml
```

规则： - `runtime/`、浏览器
profile、Cookie、数据库、日志、用户上传文件不得提交 Git。 -
目录结构可以在 Phase 0 后微调，但模块边界和接口责任不能混乱。 -
所有模块必须有 README 或 package 内说明。 - 每个模块只能通过
contracts/domain 暴露能力，不允许跨模块随意读取内部文件。

------------------------------------------------------------------------

# 5. 数据模型与数据库设计

SQLite 开启 WAL、外键约束、busy
timeout。数据库迁移必须版本化。所有时间统一保存 UTC ISO
8601，同时保留原始平台时间和时区信息。

## 5.1 核心表

### `accounts`

-   `id`
-   `platform`（douyin）
-   `account_type`（creator）
-   `display_name`
-   `status`
-   `browser_profile_key`
-   `last_session_check_at`
-   `created_at`
-   `updated_at`

V1 只启用一个账号，但 schema 不写死单账号。

### `creators`

-   `id`
-   `platform`
-   `creator_handle`
-   `profile_url`
-   `display_name`
-   `category_tags_json`
-   `discovery_source`
-   `status`
-   `first_seen_at`
-   `last_seen_at`

### `reference_contents`

-   `id`
-   `creator_id`
-   `platform`
-   `content_url`
-   `content_type`（image/video）
-   `published_at`
-   `title`
-   `caption_excerpt`
-   `visible_metrics_json`
-   `product_refs_json`
-   `visual_features_json`
-   `copy_features_json`
-   `evidence_status`
-   `observed_at`

### `merchants`

-   `id`
-   `platform_merchant_id`（如可得）
-   `name`
-   `region`
-   `city`
-   `address`
-   `source_url`
-   `verified_at`

### `groupbuy_products`

-   `id`
-   `platform_product_id`
-   `product_name`
-   `brand_name`
-   `merchant_id`
-   `scope`（national/local）
-   `category`
-   `套餐内容_json`
-   `price_current`
-   `price_original`
-   `commission_value`
-   `commission_type`
-   `valid_from`
-   `valid_until`
-   `eligible_regions_json`
-   `eligible_stores_json`
-   `promotion_eligibility`
-   `product_url`
-   `source_evidence_json`
-   `verification_status`
-   `last_verified_at`
-   `status`

金额使用 decimal string 或整数分，禁止浮点数直接存金额。

### `assets`

-   `id`
-   `asset_type`（photo/sticker/character/font）
-   `file_path`
-   `preview_path`
-   `mime_type`
-   `sha256`
-   `source_url`
-   `author`
-   `license_id`
-   `commercial_use_allowed`
-   `modification_allowed`
-   `attribution_text`
-   `verified_by`
-   `verified_at`
-   `tags_json`
-   `status`

### `templates`

-   `id`
-   `name`
-   `style_type`（poster/text_sticker）
-   `version`
-   `schema_json`
-   `preview_path`
-   `enabled`
-   `created_at`

### `creative_briefs`

-   `id`
-   `product_id`
-   `angle`
-   `style_type`
-   `template_id`
-   `copy_style`
-   `palette_json`
-   `asset_ids_json`
-   `evidence_refs_json`
-   `llm_prompt_version`
-   `brief_json`
-   `created_at`

### `content_jobs`

-   `id`
-   `product_id`
-   `state`
-   `priority`
-   `idempotency_key`
-   `creative_brief_id`
-   `retry_count`
-   `last_error_code`
-   `last_error_message`
-   `created_at`
-   `updated_at`

### `image_candidates`

-   `id`
-   `content_job_id`
-   `candidate_no`（1--3）
-   `file_path`
-   `thumbnail_path`
-   `template_id`
-   `creative_params_json`
-   `quality_score`
-   `ocr_result_json`
-   `quality_status`
-   `selected`
-   `created_at`

### `publications`

-   `id`
-   `content_job_id`
-   `account_id`
-   `product_id`
-   `platform_content_id`
-   `content_url`
-   `publish_status`
-   `published_at`
-   `title`
-   `caption`
-   `hashtags_json`
-   `main_product_attached`
-   `smart_recommend_enabled`
-   `created_at`
-   `updated_at`

### `publish_attempts`

-   `id`
-   `publication_id`
-   `attempt_no`
-   `started_at`
-   `finished_at`
-   `status`
-   `error_code`
-   `error_detail`
-   `screenshot_path`
-   `platform_confirmation`
-   `created_at`

### `metric_snapshots`

-   `id`
-   `publication_id`
-   `captured_at`
-   `window_label`（24h/72h/7d/manual）
-   `play_count`
-   `like_count`
-   `comment_count`
-   `favorite_count`
-   `share_count`
-   `order_count`
-   `gmv`
-   `commission`
-   `source_type`（screenshot/manual/official）
-   `source_file_path`
-   `confidence`
-   `raw_ocr_json`

数据缺失必须存 NULL，不得写 0 代替未知。

### `research_runs`

-   `id`
-   `platform`
-   `started_at`
-   `finished_at`
-   `window_days`
-   `status`
-   `items_found`
-   `items_verified`
-   `errors_json`

### `jobs`

-   `id`
-   `job_type`
-   `payload_json`
-   `state`
-   `priority`
-   `attempt_count`
-   `max_attempts`
-   `available_at`
-   `locked_at`
-   `locked_by`
-   `last_error`
-   `idempotency_key`
-   `created_at`
-   `updated_at`

### `audit_events`

-   `id`
-   `entity_type`
-   `entity_id`
-   `event_type`
-   `actor_type`（system/user/agent）
-   `payload_json`
-   `created_at`

### `capabilities`

-   `id`
-   `capability_key`
-   `status`（verified/unavailable/requires_manual/unknown）
-   `evidence`
-   `last_checked_at`
-   `account_scope`
-   `notes`

## 5.2 数据原则

-   原始证据与 LLM 解释分开存储。
-   所有价格、佣金、套餐、有效期必须能追溯来源。
-   每次重新核验保留历史快照。
-   商品信息变化时，旧内容任务必须重新验证。
-   图片候选图和最终发布图均保存。
-   发布日志不能只保存在控制台内存中。
-   删除/归档操作必须有审计记录。
-   任何凭据、Cookie、浏览器 profile 不进入 SQLite 普通业务表。

------------------------------------------------------------------------

# 6. 核心状态机与工作流

## 6.1 商品状态

`discovered → normalized → eligibility_check → verified → scored → queued`

异常状态： - `unverified` - `ineligible` - `expired` - `blocked` -
`needs_manual_review`

只有 `verified` 且推广资格确认的商品可进入自动内容生产。

## 6.2 内容任务状态

``` text
created
  → product_verified
  → research_attached
  → creative_planned
  → candidates_rendered
  → candidates_quality_checked
  → candidate_selected
  → copy_ready
  → relevance_checked
  → ready_to_publish
  → publishing
  → published
```

异常分支： - `needs_manual_review` - `quality_failed` -
`product_changed` - `asset_license_blocked` - `publish_failed` -
`account_paused` - `cancelled`

所有状态变化必须经过显式 transition function，不允许随意更新字符串。

## 6.3 全局发布状态

``` text
READY
PUBLISHING
PAUSED_AUTH
PAUSED_PLATFORM
PAUSED_MANUAL
STOPPED
```

-   检测到验证码/安全验证/登录失效：全局进入 `PAUSED_AUTH`。
-   所有未开始的发布任务冻结。
-   当前任务保存 checkpoint。
-   用户完成验证后，session health check 成功，自动从队列剩余位置继续。
-   若无法确认当前任务是否已经发布，必须先
    reconciliation，不得直接重发。

## 6.4 发布幂等与查重

每个发布任务生成稳定 `idempotency_key`，建议：
`account_id + product_id + creative_fingerprint + planned_publish_slot`

重试前： 1. 检查本地 publication 记录； 2.
检查平台页面/可见作品列表中是否出现对应内容； 3. 若存在，更新为
published，不重发； 4. 若结果未知，进入 reconciliation，不盲目重发； 5.
确认未发布后，才允许最多 2 次重试。

------------------------------------------------------------------------

# 7. 研究、达人发现与团购选品

## 7.1 达人发现

目标不是只找粉丝多的达人，而是找值得学习的团购内容创作者。

评分维度： - 可见播放表现； - 可见互动表现； -
可核实团购推广表现（订单/GMV/佣金若不可见则 unknown）； - 内容质量； -
更新频率； - 图文视觉质量； - 商品选择与内容匹配度； - 7/30/90
天表现趋势。

不得： - 用点赞/播放推算真实订单； - 用粉丝量直接代表转化； -
将无法访问的账号数据当成 0； - 绕过登录、验证码、权限或访问限制。

## 7.2 7/30/90 天窗口

-   7 天：发现新趋势、短期爆款、快速上升作品。
-   30 天：识别持续表现较好的达人、商品和内容结构。
-   90 天：观察长期稳定性和内容风格演变。

采集字段至少包括： - 达人 URL/ID； - 作品 URL/ID； - 发布时间； -
内容类型； - 标题/可见文案； - 可见互动指标； - 可见团购商品； -
商品范围和门店； - 采集时间； - 证据来源； - 可用性状态。

## 7.3 平台分工

### 抖音

研究： - 团购达人； - 图文和视频作品； - 团购商品链接； -
可见发布频率； - 可见互动； - 商品挂载和推广资格。

### 小红书

仅研究： - 视觉趋势； - 标题表达； - 信息层级； - 配色； -
插画/贴纸风格； - 字体与排版灵感。

禁止直接复制笔记图片、文字或受保护的原创设计。仅提炼通用创意规律，重新创作。

## 7.4 商品范围

-   全国团购；
-   本地团购：苏州、昆山优先；
-   其他地区商品只有在系统明确支持且商品范围可核实时才纳入。

## 7.5 商品评分模型

初始建议权重（可配置，Phase 6 用真实数据调整）：

  维度                       初始权重
  ------------------------ ----------
  商品热度/近期关注                20
  佣金与收益吸引力                 15
  优惠力度/价格竞争力              10
  可核实销量/评价表现              10
  内容创作潜力                     15
  视觉吸引力                       10
  推广资格与可挂载性               10
  有效期/门店/地域可靠性           10
  **合计**                    **100**

注意： - 任何关键资格/有效期校验失败，直接阻断，不可由高分抵消。 -
数据不可得的评分项标记
`unknown`，按配置采用降权/置信度处理，不伪造分数。 - 输出评分理由和
evidence refs。

## 7.6 首个测试商品

商品： - 品牌/商家：爷爷不泡茶 - 团购名称：【柿柿可利】柿柿椰椰 /
柿柿有杏 2 选 1 - 范围：全国团购（待实际核验）

必须核验： - 商品是否仍在达人选品入口； - 当前账号是否可推广； -
当前商品名称、套餐、价格、佣金、有效期； - 是否允许挂载到图文； -
实际页面是否提供智能推荐相关产品开关。

------------------------------------------------------------------------

# 8. 创意策划与文案生成契约

## 8.1 输入

`CreativePlanner` 输入： - 已核验商品 JSON； - 商品证据； -
授权素材清单； - 参考趋势摘要（非原文复制）； - 当前模板库； -
已发布内容的去重摘要； - 用户已确认的视觉规范。

## 8.2 输出

必须输出结构化 `CreativePlan`：

``` ts
type VisualStyle = "poster" | "text_sticker";

interface CreativePlan {
  productId: string;
  campaignAngle: string;
  visualStyle: VisualStyle;
  candidates: Array<{
    candidateNo: 1 | 2 | 3;
    conceptName: string;
    headline: string;
    supportingLines: string[];
    optionalPriceLabel?: string;
    optionalCta?: string;
    copyStyle: string;
    templateId: string;
    palette: {
      primary: string;
      secondary: string[];
      accent: string;
      background: string;
    };
    assetIds: string[];
    photoAssetIds: string[];
    layoutIntent: string;
    evidenceRefs: string[];
    differentiationNotes: string[];
  }>;
  publishCopy: {
    title: string;
    caption?: string;
    hashtags: string[];
  };
  factualClaims: Array<{
    claim: string;
    evidenceRef: string;
  }>;
}
```

校验： - `candidates.length === 3`； - candidateNo 唯一且为 1、2、3； -
`text_sticker` 的 `photoAssetIds` 必须为空； - 所有 `assetIds`
必须已通过授权校验； - 所有事实声明必须有 evidence； -
价格字段没有证据不得生成； - 三个候选创意必须有差异说明。

## 8.3 文案原则

-   口语化、自然、有推荐理由；
-   标题简洁、明确、有记忆点；
-   结构由 AI 决定：标题、标题+正文、标题+正文+话题；
-   不每条都套相同句式；
-   轻量种草引导；
-   不虚构体验、评价、排队、销量、优惠或门店场景；
-   不复制对标达人原文；
-   不使用平台违规或误导性宣传内容。

------------------------------------------------------------------------

# 9. 静态图文生产技术细节

## 9.1 主渲染方案

使用： - HTML 结构定义区域； - CSS Grid/Flex 进行排版； - SVG
绘制图形、描边、箭头、标签和装饰； - Playwright 在固定 viewport
输出高清图； - Sharp 做最终尺寸、色彩空间、压缩与 PNG 导出。

不允许通过让 LLM 自由生成 HTML 直接渲染生产图。LLM 只能输出 schema
化的内容和布局意图，模板代码由开发者维护。

## 9.2 AnyText2

定位：可插拔的标题视觉增强实验，不是主渲染器。

用户确认的应用范围： - 主标题； - 少量重点关键词。

处理原则： 1. AnyText2 生成标题艺术视觉层/风格参考； 2.
最终准确中文必须由模板引擎按指定字体渲染； 3. 防止 AI
字形和程序字形重叠造成重影； 4. OCR 检查最终图； 5. AnyText2
效果不稳定、部署成本过高或影响一致性时，使用 SVG/CSS
字体效果替代，不阻塞主线。

## 9.3 图片质量门禁

每张候选图必须执行：

### 文件检查

-   尺寸正确；
-   PNG 可解码；
-   sRGB；
-   文件大小不超过实测平台限制；
-   没有透明背景残留（除非模板明确允许）。

### OCR 检查

-   必须识别主标题；
-   关键商品名、价格、套餐内容识别一致；
-   不得有乱码、缺字、错字；
-   所有必需文字都在安全区域内；
-   OCR 置信度低的文字进入二次检查。

### 布局检查

-   文字无重叠；
-   贴纸不遮挡核心信息；
-   视觉层级明确；
-   手机缩略图仍能看清主标题；
-   纯文字贴图型不得出现菜品照片；
-   海报型实拍素材不得被 AI 改造为虚假菜品。

### 视觉评分

-   主标题醒目；
-   信息层级；
-   色彩协调；
-   图片清晰；
-   留白和密度；
-   贴图相关性；
-   商品识别度；
-   三候选差异度。

自动评分只负责排序，不能覆盖硬性失败项。

------------------------------------------------------------------------

# 10. 商品与内容相关性质量门禁

发布前必须校验：

1.  图文主题和主团购商品相符；
2.  品牌/门店一致；
3.  套餐内容一致；
4.  价格/优惠有证据且仍有效；
5.  图片中的真实菜品与实际商品一致；
6.  地域/门店适用范围符合账号和用户目标；
7.  商品当前有效；
8.  当前账号有推广资格；
9.  图片没有虚构门店/客流/服务体验；
10. 标题和正文不误导。

判定： - `PASS`：可进入发布； -
`WARN`：非关键缺失，按策略决定是否需要人工确认； -
`BLOCK`：任何关键事实错误、资格未知、商品失效或素材授权问题，禁止发布。

不允许把"LLM 觉得相关"作为唯一证据。必须由结构化字段和 evidence refs
支撑。

------------------------------------------------------------------------

# 11. 抖音发布模块规格

## 11.1 浏览器会话

-   Playwright Chromium 使用独立持久化 profile。
-   profile 位置在 `runtime/browser-profile/`，不进入 Git。
-   首次由用户扫码登录。
-   后续复用会话。
-   不读取/导出 Cookie 作为普通配置，不将会话凭据发送到外部服务。
-   浏览器保持可见，方便用户观察。
-   不启用 stealth
    插件、指纹伪装、代理轮换、验证码识别绕过或隐藏自动化。

## 11.2 发布流程

1.  检查全局发布状态为 READY。
2.  检查账号 session 正常。
3.  获取一条 `ready_to_publish` 任务。
4.  再次核验商品有效性、推广资格和相关性。
5.  打开正常抖音发布页面。
6.  选择图文发布类型。
7.  上传唯一最终图片。
8.  填写标题/正文/话题。
9.  进入团购商品挂载入口。
10. 搜索并选择主团购商品。
11. 核对主商品名称、套餐、商家/品牌、适用范围。
12. 如果页面提供智能推荐相关产品选项且可用，勾选。
13. 如果该选项不可用，记录
    `smart_recommend_enabled=false`，只挂主商品继续。
14. 检查发布前摘要。
15. 提交发布。
16. 等待平台确认。
17. 获取作品链接/ID（若平台提供）。
18. 保存页面截图、日志和最终状态。

## 11.3 发布结果判定

成功必须至少满足： -
平台界面明确显示发布成功，或作品出现在可核实的作品列表； -
主商品挂载结果已确认； - 本地 publication 状态更新为 `published`； -
记录可用作品 URL/ID；若平台不提供则标记 unavailable，不虚构。

不能只因为点击了"发布"就记为成功。

## 11.4 智能推荐降级

-   主商品挂载是强制项。
-   智能推荐可用则勾选。
-   智能推荐不可用则只挂主商品并继续。
-   不得为了勾选推荐而选择不相关商品。
-   记录 UI 能力状态和截图证据。

## 11.5 发布失败

-   网络/上传可恢复错误：最多重试 2 次。
-   每次重试先查作品是否已经发布。
-   页面结构变化：暂停当前发布任务并记录 selector/截图。
-   商品搜索无结果：暂停当前任务，不得随意挂相似商品。
-   账号安全验证：全局暂停。
-   不确定是否发布成功：进入 reconciliation，不得盲目重发。

## 11.6 安全验证恢复

-   检测验证码/登录过期/安全校验/账号异常；
-   全局发布队列进入 `PAUSED_AUTH`；
-   停止启动新发布任务；
-   用户在正常页面完成验证；
-   系统重新检查登录会话和发布页面可用性；
-   检查上一个任务是否已发布；
-   会话确认恢复后自动继续剩余队列。

------------------------------------------------------------------------

# 12. Agent 无关接口契约

目标：未来任何 Agent 都能通过 HTTP API 或 CLI
驱动系统，而不需要理解内部实现。

## 12.1 HTTP API

统一前缀：`/api/v1`

### 健康与控制

-   `GET /health`
-   `GET /system/status`
-   `POST /system/pause`
-   `POST /system/resume`
-   `POST /system/stop`
-   `POST /system/start`

### 调研

-   `POST /research/runs`
-   `GET /research/runs/:id`
-   `GET /research/creators`
-   `GET /research/contents`

### 商品

-   `POST /products/discover`
-   `GET /products`
-   `GET /products/:id`
-   `POST /products/:id/verify`
-   `POST /products/:id/score`

### 创意与图文

-   `POST /content-jobs`
-   `GET /content-jobs`
-   `GET /content-jobs/:id`
-   `POST /content-jobs/:id/generate`
-   `GET /content-jobs/:id/candidates`
-   `POST /content-jobs/:id/select-candidate`
-   `POST /content-jobs/:id/quality-check`

### 发布

-   `POST /publications`
-   `GET /publications`
-   `GET /publications/:id`
-   `POST /publications/:id/reconcile`
-   `POST /publisher/session/check`
-   `POST /publisher/session/pause`
-   `POST /publisher/session/resume`

### 素材与模板

-   `GET /assets`
-   `POST /assets/import`
-   `GET /templates`
-   `GET /templates/:id`

### 数据截图

-   `POST /metrics/import-screenshot`
-   `GET /metrics/publications/:id`

### 日志与诊断

-   `GET /audit-events`
-   `GET /diagnostics`
-   `GET /capabilities`

## 12.2 API 通用约定

请求头： - `Content-Type: application/json` -
`Idempotency-Key: <stable-key>`（对创建任务/发布操作必需）

成功响应：

``` json
{
  "ok": true,
  "data": {},
  "requestId": "uuid"
}
```

错误响应：

``` json
{
  "ok": false,
  "error": {
    "code": "PRODUCT_NOT_ELIGIBLE",
    "message": "商品推广资格未确认",
    "retryable": false,
    "details": {}
  },
  "requestId": "uuid"
}
```

规则： - HTTP 状态码表达通用结果； - error.code 使用稳定枚举； -
不把堆栈返回给普通客户端； - 所有创建型接口支持幂等； - 所有分页接口使用
cursor 或 limit/offset； - 所有时间为 ISO 8601； - 所有金额以分或
decimal string 表达； - API 文档自动生成 OpenAPI 3.1。

## 12.3 关键 TypeScript 接口

``` ts
export interface LLMProvider {
  generateStructured<T>(input: {
    systemPrompt: string;
    userPayload: unknown;
    schema: unknown;
    traceId: string;
  }): Promise<T>;
}

export interface ResearchSource {
  readonly platform: "douyin" | "xiaohongshu";
  discover(input: ResearchQuery): Promise<ResearchItem[]>;
  inspect(url: string): Promise<ResearchEvidence>;
}

export interface ProductSource {
  discover(input: ProductQuery): Promise<ProductCandidate[]>;
  verify(productId: string): Promise<ProductVerification>;
}

export interface AssetRepository {
  search(query: AssetSearchQuery): Promise<AssetRecord[]>;
  verifyLicense(assetId: string): Promise<LicenseVerification>;
}

export interface CreativePlanner {
  plan(input: CreativeInput): Promise<CreativePlan>;
}

export interface ImageRenderer {
  renderCandidate(input: RenderInput): Promise<RenderedCandidate>;
}

export interface QualityGate {
  inspect(input: QualityInput): Promise<QualityReport>;
}

export interface Publisher {
  checkSession(): Promise<SessionStatus>;
  publish(input: PublishInput): Promise<PublishResult>;
  reconcile(input: ReconcileInput): Promise<ReconcileResult>;
}

export interface DurableJobQueue {
  enqueue<T>(job: JobDefinition<T>): Promise<string>;
  claim(workerId: string): Promise<JobRecord | null>;
  complete(jobId: string, result: unknown): Promise<void>;
  fail(jobId: string, error: AppError): Promise<void>;
}
```

## 12.4 CLI

至少提供：

``` powershell
# 安装依赖与初始化
pnpm install
pnpm db:migrate
pnpm assets:validate

# 开发
pnpm dev
pnpm test
pnpm test:e2e
pnpm lint
pnpm typecheck

# 运行
pnpm start
pnpm stop
pnpm status

# 调研与选品
pnpm cli research --platform douyin --window 7d
pnpm cli products discover --scope national
pnpm cli products discover --scope local --cities "苏州,昆山"

# 图文生产
pnpm cli content create --product <productId> --dry-run
pnpm cli content render --job <jobId>
pnpm cli content inspect --job <jobId>

# 发布（默认 dry-run）
pnpm cli publish --job <jobId> --dry-run
pnpm cli publish --job <jobId> --confirm-live

# 诊断和备份
pnpm diagnostics
pnpm backup
```

真实发布必须使用显式 `--confirm-live`，控制台也必须有明确的 live mode
状态。自动工作流启用 live mode 前，需用户首次明确授权并保存审计记录。

## 12.5 Agent 接入

-   HTTP API + OpenAPI 是主契约。
-   CLI 是第二契约。
-   可在后续增加 MCP Server，但不能让 MCP 成为核心业务逻辑。
-   Agent 调用工具时只接触稳定 API schema，不读写数据库文件。
-   Agent 不允许直接操纵内部数据库或修改任务状态。
-   关键动作（启用 live publish、暂停/恢复、清理账号
    profile）必须经过受控接口。
-   `AGENTS.md` 说明项目规则；`NEXT_AGENT_PROMPT.md` 每次交接更新。

------------------------------------------------------------------------

# 13. 安全、隐私与平台合规

## 13.1 明确禁止

-   验证码自动破解或代答；
-   绕过登录、权限、风控或访问限制；
-   浏览器指纹伪装、stealth、代理轮换来逃避识别；
-   模拟真人鼠标轨迹以规避平台检测；
-   隐藏自动化控制或对平台作虚假身份声明；
-   通过非授权接口获取私有订单、佣金或账号数据；
-   未经授权批量下载/复用其他创作者内容；
-   商品信息不实、虚假销量/评价/门店环境。

## 13.2 允许的可靠性自动化

-   正常浏览器启动和页面导航；
-   页面元素等待；
-   上传进度检测；
-   合理的操作节奏以避免误操作；
-   失败重试；
-   状态核验；
-   截图留痕；
-   用户登录会话复用；
-   安全验证时暂停并等待用户。

## 13.3 本地数据保护

-   `.env`、browser profile、Cookie、token、用户数据不进 Git。
-   日志自动脱敏。
-   API 默认仅绑定 `127.0.0.1`。
-   如需局域网访问，必须显式配置认证和防火墙。
-   数据库备份需可恢复测试。
-   上传截图和素材存放在 runtime 目录。
-   删除数据要有用户确认和审计记录。

------------------------------------------------------------------------

# 14. 调度与产能策略

目标是支持每天 10
条以上的内容生产能力，但发布数量必须服从平台规则、账号权限和质量。

## 14.1 队列优先级

综合： - 商品评分； - 热点时效； - 素材准备程度； - 任务耗时； -
商品重复推广间隔； - 历史内容相似度； - 当前发布队列长度。

## 14.2 同商品复推

-   允许热门商品在不同时间重复推广；
-   每次必须有实质创意差异；
-   不可简单替换颜色/标题后重复；
-   计算文案相似度、视觉相似度和发布时间间隔；
-   商品失效、权限变化、套餐变更时停止复推；
-   频率不得违反平台规则或造成刷屏。

## 14.3 动态调研

-   基础周期可配置；
-   商品热度变化时可以提高调研优先级；
-   图片生成和发布队列繁忙时降低调研资源占用；
-   研究结果去重；
-   不得因高频访问触发平台限制；遇到限制立即退避或暂停。

------------------------------------------------------------------------

# 15. 轻量数据截图复盘

数据复盘不作为核心流程，也不要求用户每天上传。

用户有空时提供抖音后台截图，系统： 1. 保存原始截图； 2. OCR
识别播放、点赞、评论、收藏、分享、订单、GMV、佣金等可见字段； 3.
用户/系统确认作品对应关系； 4. 识别统计时间范围； 5. 记录来源和置信度；
6. 与历史作品/创意参数关联； 7. 输出简短观察，不阻塞选品、制图和发布。

缺失字段存
NULL；截图无法识别时标记待确认；不能把播放量当订单量，也不能由播放量推算出单。

------------------------------------------------------------------------

# 16. Windows 本地运行与部署

## 16.1 初始安装

PowerShell 脚本负责： - 检查 Node.js 22； - 检查 pnpm； - 安装依赖； -
下载 Playwright Chromium； - 创建 runtime 目录； - 初始化 SQLite； -
运行 migrations； - 检查字体和 OCR 组件； - 生成 `.env`； - 运行
diagnostics。

## 16.2 后台运行

-   V1 采用本地后台进程；
-   Windows Task Scheduler 注册开机启动；
-   不要求先开发 Windows Service；
-   进程崩溃可由任务计划程序重启；
-   应用内部通过 SQLite lease 防止重复 worker；
-   控制台可查看服务状态。

## 16.3 控制台

首页至少显示： - 系统运行状态； - 账号登录状态； - 当前全局发布状态； -
待调研商品数； - 待生成内容数； - 待发布数； - 今日已发布数； -
失败/隔离任务数； - 最近 20 条日志； - 暂停/恢复/停止按钮。

## 16.4 备份

至少备份： - SQLite 数据库； - 模板配置； - 素材 manifest； -
用户自定义配置； - 任务审计数据。

不备份： - 临时缓存； - 可重新下载的临时文件； - 明文 Cookie/token。

浏览器 profile
的备份策略必须单独设计，不能把账号会话文件上传到公共云端。

------------------------------------------------------------------------

# 17. Phase 0--8 逐阶段实施计划与验收门槛

每个 Phase 完成后，必须生成： -
`docs/handover/ACCEPTANCE_REPORTS/PHASE-X.md` - 变更摘要； -
测试结果； - 未完成事项； - 风险； - 下一阶段入口； - Git commit hash。

## Phase 0：技术调研、能力验证与架构冻结

### 工作内容

1.  确认 Windows 版本、Node/Python 环境和运行限制。
2.  检查目标抖音达人账号实际权限。
3.  实测图文发布入口、图片格式/比例/大小要求。
4.  实测团购商品选择入口。
5.  实测智能推荐相关产品选项是否存在。
6.  实测主商品搜索、选择、确认流程。
7.  实测是否能可靠识别发布成功及作品 URL。
8.  核验首个测试商品当前状态和推广资格。
9.  研究抖音公开可访问内容、达人发现与商品信息的可用来源。
10. 研究小红书公开视觉参考的可用访问方式。
11. 对 Playwright 持久化 profile 做最小 PoC。
12. 对 HTML/CSS/SVG + Playwright + Sharp 做 3:4 样图 PoC。
13. 对 OCR 引擎做中文准确率、速度和 Windows 安装成本测试。
14. 对 AnyText2 做可选标题增强 PoC；不合格就不进入核心依赖。
15. 检查所有候选开源项目和素材许可证。

### 必须交付

-   `docs/CAPABILITY_MATRIX.md`
-   `docs/ARCHITECTURE.md`
-   ADR 文件；
-   `docs/PHASE_PLAN.md`
-   真实 UI 流程截图（脱敏）；
-   图片尺寸/上传约束记录；
-   商品核验记录；
-   开源依赖许可证清单；
-   Phase 0 验收报告。

### 验收门槛

-   每项抖音能力都标记
    `verified / unavailable / requires_manual / unknown`。
-   不得以搜索结果或想象替代真实 UI 实测。
-   如果自动挂载团购在账号上不可用，必须明确阻塞范围和可行降级方案。
-   如果发布流程需要用户操作，明确记录人工节点。
-   图片渲染 PoC 产出 1242×1660 PNG，中文无缺字。
-   OCR 对样图核心文字识别正确。
-   没有未审查许可证的生产依赖。
-   Phase 0 未通过，不得进入真实自动发布开发。

## Phase 1：项目骨架、数据库、接口和任务队列

### 工作内容

-   创建独立仓库；
-   初始化 pnpm workspace；
-   TypeScript strict；
-   Fastify；
-   React/Vite 控制台；
-   SQLite + Drizzle migrations；
-   durable jobs；
-   Pino 日志；
-   Zod contracts；
-   OpenAPI；
-   CLI；
-   diagnostics；
-   `.env.example`；
-   Windows install/dev/start/stop scripts。

### 验收门槛

-   全新 Windows 环境按 README 可安装。
-   `pnpm typecheck`、`pnpm lint`、`pnpm test` 全通过。
-   DB migration 可从空库执行。
-   任务进程重启后未完成任务不丢失。
-   同一 idempotency key 不重复创建任务。
-   API 只绑定 localhost。
-   runtime 文件均被 Git ignore。
-   控制台能显示系统状态、任务列表和日志。

## Phase 2：抖音静态图文视觉引擎

### 工作内容

-   5--8 套模板；
-   海报型与纯文字贴图型；
-   字体和配色 Token；
-   30--50 个已审授权贴纸；
-   真实照片轻度精修；
-   3 候选图渲染；
-   预览、导出、模板版本；
-   AnyText2 可插拔 PoC。

### 验收门槛

-   每个商品稳定生成 3 张不同创意图。
-   三张图均为 1242×1660 PNG。
-   纯文字贴图型 0 菜品照片。
-   海报型照片来源可追溯。
-   字体和贴纸许可证信息完整。
-   中文无乱码、错位、溢出。
-   视觉回归测试通过。
-   至少 5 套模板达到人工评审合格。
-   AnyText2 不稳定不得阻塞核心渲染。
-   不能仅靠换色构成三张候选图差异。

## Phase 3：商品研究、创意策划和文案

### 工作内容

-   Product/Creator/Content schema；
-   证据记录；
-   全国和苏州/昆山商品分类；
-   7/30/90 天研究数据模型；
-   商品综合评分；
-   创意规划器；
-   文案生成；
-   三候选差异检查；
-   同商品复推策略。

### 验收门槛

-   所有商品关键事实有 evidence refs。
-   未知字段保持 unknown/null。
-   推广资格未确认不得进入自动发布队列。
-   三套创意有可解释差异。
-   不复制对标原文。
-   首测商品只有在实时核验通过后才进入流程。
-   没有可用真实订单数据时不虚构转化表现。

## Phase 4：质量门禁、OCR、相关性核验

### 工作内容

-   OCR adapter；
-   文字精确性检查；
-   视觉布局检测；
-   商品事实校验；
-   价格/套餐/门店一致性；
-   贴纸授权检查；
-   质量评分；
-   自动修复和失败隔离。

### 验收门槛

-   错别字/乱码/文字截断能被测试集发现。
-   纯文字贴图型出现菜品照片时必定 BLOCK。
-   商品价格错误时必定 BLOCK。
-   商品失效/推广资格未知时必定 BLOCK。
-   图片素材授权未知时必定 BLOCK。
-   硬性失败项不能被平均分抵消。
-   自动修复有最大次数，不存在无限循环。
-   失败任务隔离，不影响其他任务。

## Phase 5：抖音发布与团购挂载

### 工作内容

-   独立持久化浏览器 profile；
-   首次扫码登录；
-   session health check；
-   图文发布 UI；
-   图片上传；
-   文案填写；
-   主商品搜索和挂载；
-   智能推荐选项探测；
-   发布确认；
-   作品 URL/ID 记录；
-   截图和 audit；
-   reconciliation；
-   dry-run/live mode。

### 验收门槛

-   dry-run 不产生真实发布。
-   正常登录后可进入正确图文发布页。
-   只上传 1 张最终图片。
-   主商品选择必须核对商品标识/名称/套餐。
-   智能推荐可用则勾选；不可用则记录并只挂主商品。
-   主商品挂载失败绝不发布。
-   发布结果有平台证据。
-   不确定是否发布时不会重复提交。
-   网络类错误最多重试 2 次。
-   验证码/安全校验出现时全队列暂停。
-   不包含任何反检测或绕过逻辑。
-   必须在用户授权账号上由用户明确批准首次 live test。

## Phase 6：达人发现与自动选品

### 工作内容

-   抖音公开内容来源适配；
-   小红书视觉参考适配；
-   达人自动发现；
-   7/30/90 天窗口；
-   商品发现和排序；
-   苏州/昆山本地商品；
-   全国商品；
-   研究去重；
-   证据完整性。

### 验收门槛

-   来源、采集时间和可用性状态完整。
-   不可访问数据标记 unavailable/unknown。
-   订单数据不由播放量推算。
-   商品资格、有效期和地域必须核验。
-   重复达人/作品/商品有去重机制。
-   调研失败不会阻塞已经准备好的合格内容。

## Phase 7：全自动工作流、Windows 后台与恢复

### 工作内容

-   动态调研调度；
-   商品队列排序；
-   3 图生产队列；
-   自动选图；
-   自动发布；
-   全局暂停/恢复；
-   安全验证恢复；
-   有限重试；
-   开机自启；
-   诊断和备份；
-   运行控制台。

### 验收门槛

-   Windows 重启后可自动启动服务。
-   服务进程重启后队列恢复。
-   同一任务不被两个 worker 同时处理。
-   账号验证触发全局发布暂停。
-   用户完成验证后 session 恢复，剩余任务可自动继续。
-   已发布任务不会重复发布。
-   用户可一键暂停/停止。
-   任务失败有错误原因和可恢复状态。
-   产能压测报告明确系统处理能力；不承诺违反平台限制的发布数量。
-   后台运行 24 小时稳定性测试通过。

## Phase 8：最终验收、优化和交付

### 工作内容

-   全量端到端测试；
-   性能和资源优化；
-   安全审查；
-   许可证复核；
-   文档完善；
-   安装包/部署脚本；
-   用户手册；
-   Codex 交接包；
-   Git tag/release。

### 最终验收门槛

-   从商品发现到真实图文发布的端到端闭环通过。
-   3 候选图质量达到人工评审标准。
-   主商品挂载可核实。
-   智能推荐降级逻辑正确。
-   发布成功证据完整。
-   验证暂停与恢复通过。
-   重试不会造成重复发布。
-   所有测试通过。
-   无 P0/P1 未解决缺陷。
-   新 Agent 仅阅读
    README、AGENTS.md、CURRENT_STATUS.md、NEXT_AGENT_PROMPT.md
    即可继续开发。
-   交付完整 Git commit/tag、测试报告和已知限制清单。

------------------------------------------------------------------------

# 18. 测试策略与质量标准

## 18.1 测试层级

1.  Unit：业务规则、评分、状态机、schema、模板布局。
2.  Contract：API、adapter、LLM structured output。
3.  Integration：SQLite、job queue、renderer、OCR。
4.  E2E：本地 console、dry-run 发布流程。
5.  Live acceptance：仅在用户授权账号上小批量真实测试。
6.  Visual regression：固定商品输入的模板截图比对。
7.  Recovery：进程崩溃、网络中断、账号验证、页面变化。
8.  Security：敏感信息泄漏、路径穿越、API 本地绑定、文件上传限制。

## 18.2 质量门槛

-   TypeScript `strict: true`。
-   不允许 `any` 无理由扩散。
-   所有外部数据先 schema validation。
-   所有异常有稳定 error code。
-   所有 job handler 必须幂等。
-   所有发布操作必须有审计。
-   核心业务逻辑测试覆盖率建议 ≥ 80%；发布状态机、商品资格、质量门禁要求
    100% 分支测试。
-   不以覆盖率代替真实验收。
-   禁止忽略失败测试或用 `skip` 掩盖未完成工作。
-   ESLint、Prettier、TypeScript、Vitest、Playwright E2E 纳入 CI。

## 18.3 视觉验收

建立固定样例集： - 奶茶/饮品； - 火锅； - 自助餐； - 烧烤； - 特色菜； -
甜品； - 纯文字贴图型无照片样例。

每套模板至少由两种商品测试。评审： - 3 秒内是否能识别主题； -
标题是否醒目； - 手机缩略图可读性； - 信息是否准确； -
画面是否像抖音信息流内容，而非小红书手帐； -
贴图是否服务于情绪和阅读； - 是否有模板重复感。

------------------------------------------------------------------------

# 19. 配置项建议

`.env.example` 仅放非敏感示例：

``` env
NODE_ENV=development
APP_HOST=127.0.0.1
APP_PORT=4780
DATABASE_URL=file:./runtime/data/app.db
LOG_LEVEL=info

RENDER_WIDTH=1242
RENDER_HEIGHT=1660
RENDER_FORMAT=png

DOUYIN_BROWSER_HEADLESS=false
DOUYIN_PROFILE_DIR=./runtime/browser-profile
DOUYIN_LIVE_PUBLISH_ENABLED=false
DOUYIN_MAX_RETRIES=2

RESEARCH_BASE_INTERVAL_MINUTES=360
RESEARCH_CITIES=苏州,昆山
CONTENT_CANDIDATES_PER_PRODUCT=3
CONTENT_DAILY_TARGET=10

LLM_PROVIDER=agent-main
OCR_PROVIDER=auto
```

注意： - `CONTENT_DAILY_TARGET=10`
是内部目标值，不代表平台允许或保证每日发布 10 条。 -
真实平台能力和限制以 Phase 0 验证及平台规则为准。 - 不在 `.env` 中保存
Cookie。 - 所有配置通过 Zod 校验，非法配置启动失败并给出明确提示。

------------------------------------------------------------------------

# 20. 首个端到端验收用例

## 输入

商品： 「爷爷不泡茶」【柿柿可利】「柿柿椰椰 / 柿柿有杏 2 选 1」

来源： 达人当前可访问的团购商品入口，需实时核验。

## 过程

1.  读取商品信息；
2.  核验推广资格、有效期、套餐、价格和全国范围；
3.  收集品牌/商品允许使用的素材；
4.  生成三个创意：
    -   海报型：商品主视觉 + 强标题；
    -   海报型或另一差异构图；
    -   纯文字贴图型：完全不放饮品照片；
5.  三张均执行 OCR 和视觉检测；
6.  评分选择 1 张；
7.  生成发布标题/正文/话题；
8.  检查内容与团购商品相关性；
9.  dry-run 展示完整发布摘要；
10. 用户明确批准 live test 后，正常浏览器发布；
11. 选择主商品；
12. 智能推荐可用则勾选，不可用则只挂主商品；
13. 发布；
14. 确认作品存在；
15. 保存 URL、截图、任务日志和审计记录。

## 验收结果

必须提供： - 商品证据； - 3 张候选 PNG； - 候选图质量报告； -
最终选择理由； - 发布文案； - 商品相关性报告； - 发布截图； - 作品
URL/ID（若平台提供）； - 主商品挂载结果； - 智能推荐状态； - 完整 audit
trail。

------------------------------------------------------------------------

# 21. Codex 执行顺序与工作规则

## 21.1 开始前

Codex 必须先： 1. 阅读本文件； 2. 创建独立项目目录和 Git 仓库； 3. 生成
`AGENTS.md`； 4. 建立 Phase 0 checklist； 5. 检查本机 Windows 环境； 6.
执行真实平台能力验证； 7. 形成 Phase 0 报告； 8. 等 Phase 0
验收通过后进入 Phase 1。

不得跳过 Phase 0 直接开发自动发布。

## 21.2 每个 Phase 的执行要求

-   先拆任务，再实现；
-   每个模块先定义 contract；
-   先写测试再实现关键业务规则；
-   完成后执行 lint/typecheck/unit/integration/e2e；
-   失败必须修复，不允许带病进入下一阶段；
-   更新 `CURRENT_STATUS.md`；
-   更新 `CHANGELOG.md`；
-   写 Phase 验收报告；
-   Git commit 使用清晰、可追踪的消息；
-   不得把真实账号凭据、Cookie、截图中的隐私信息提交 Git。

## 21.3 交接要求

每次 Agent 交接，必须更新：

`docs/handover/CURRENT_STATUS.md` - 当前 Phase； - 已完成内容； -
未完成内容； - 当前分支和 commit； - 测试状态； - 风险与阻塞； -
下一步任务。

`docs/handover/NEXT_AGENT_PROMPT.md` - 新 Agent 应先读哪些文件； -
当前开发目标； - 不可变更的需求； - 如何运行测试； - 如何验收本阶段。

## 21.4 禁止的开发行为

-   不得为了赶进度删除测试；
-   不得用静态假数据冒充真实商品；
-   不得把"点击发布"当成发布成功；
-   不得把"页面出现商品"当成已挂载成功，必须核对；
-   不得绕过账号安全验证；
-   不得把所有逻辑写在一个大脚本里；
-   不得引入没有必要的微服务/Redis/Kafka；
-   不得把模型 prompt 写死在 UI；
-   不得让 LLM 直接控制数据库；
-   不得把图片模板做成只能靠人工改代码的硬编码海报；
-   不得将小红书风格重新作为默认视觉风格；
-   不得重新引入 AutoJY/dengju；
-   不得把 PostFlow 变成运行时强依赖。

------------------------------------------------------------------------

# 22. 最终交付清单

项目交付时必须包含：

-   [ ] 可运行的 Windows 本地项目；
-   [ ] 完整 Git 仓库；
-   [ ] `README.md`；
-   [ ] `AGENTS.md`；
-   [ ] 本开发规格文档；
-   [ ] 架构图和模块说明；
-   [ ] API OpenAPI 文档；
-   [ ] 数据库 schema 和 migrations；
-   [ ] 5--8 套高质量模板；
-   [ ] 30--50 个授权明确的开源贴纸素材；
-   [ ] 字体资源和许可证记录；
-   [ ] 三候选图生成能力；
-   [ ] OCR 和质量门禁；
-   [ ] 商品相关性核验；
-   [ ] 抖音正常 UI 发布模块；
-   [ ] 主团购商品挂载；
-   [ ] 智能推荐降级逻辑；
-   [ ] 全局安全暂停与恢复；
-   [ ] 发布幂等和失败重试；
-   [ ] 本地控制台；
-   [ ] Windows 开机自启脚本；
-   [ ] 备份与诊断工具；
-   [ ] 全阶段测试报告；
-   [ ] Phase 0--8 验收报告；
-   [ ] Agent 交接文档；
-   [ ] 最终 release tag。

------------------------------------------------------------------------

# 23. 最终产品原则

本项目的核心不是"尽可能多地自动点击"，而是建立一条**真实、稳定、可验收的团购内容生产线**。

优先级始终是：

1.  图文质量；
2.  商品信息准确；
3.  团购挂载正确；
4.  发布结果可核实；
5.  自动化稳定；
6.  才是提高生产和发布数量。

先让第一张图真正达到可发布水准，再让第一条团购图文真正挂载成功。后续每个
Phase 都围绕这个闭环迭代。

**本文件为 V1.0 需求基线。任何重大需求变更必须新增 ADR
和版本记录，不允许 Agent 擅自改写已确认决策。**

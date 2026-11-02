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

## 素材自带字幕

按 2fps 抽 360×640 帧，逐行统计「亮字核心 + 邻域暗描边」像素，连续成带的行算一层
字幕（`legacy_sub.min_score` 默认 0.3）；素材可能同时有两层（如上层白字只在中段出现、
下层黄字全程出现）。

检测到**任意一层**就判定这条素材「自带字幕」，整条跳过字幕环节：不画黑条、不叠加我们的
字幕，画面与声音保持原样（只加片头特效/BGM）。检测不到字幕的素材正常生成字幕。
可用 `legacy_sub.enabled: false` 关闭检测（全部按无字幕处理）。

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

再次运行同一条素材会优先使用校对稿。自带字幕的素材会整条跳过字幕，校对稿不生效。

## 已知限制与风险

- 自带字幕的素材保留原 AI 字幕，原字幕里的错字无法修正，发布前需抽检。
- 无字幕素材的 ASR 只做初稿：品牌名、口音、背景音会听错，发布前必须人工过一遍字幕。
- BGM 来自本机曲库并按内容关键词自动匹配；如需替换，改 `config.json` 的 `bgm.rules`
  或在 `bgm.default` 指定。BGM 是否可商用取决于曲目授权，对外投放前确认版权。
- 所有 26 条素材都是约 23.5fps（1083/46）720×1280，导出时上采样到 30fps / 1080×1920，
  画面清晰度不能超过源素材。
- 内置 `QQ视频20261101142136.mp4` 是已发布的 11月1日.mp4 的原始素材，批量跑之前先确认是否要跳过。

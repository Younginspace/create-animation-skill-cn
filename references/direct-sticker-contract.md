# 视频片段与静态表情 `direct sticker`

## 适用范围

- 单个用户授权的 MP4、MOV、WebM 或 MKV，截取1.5—6秒，叠加1—16字，交付512×512、12fps、无限循环 GIF。
- 单个用户授权的静态 JPEG/PNG，叠加1—16字，交付512×512 PNG。
- 不处理多视频拼接、变速、配乐、口播字幕、台词自动定位或超过一个片段的剪辑。

视频截 GIF 与静态 PNG 使用 Node.js 22+ 驱动的 FFmpeg 直接链路，不依赖 HyperFrames CLI 或无头浏览器。预装 FFmpeg 必须带 `drawtext`、`libfreetype` 和相应 PNG/GIF encoder/muxer；GIF 还必须带 `palettegen`、`paletteuse`。同时必须有 ffprobe 和已授权、可显示简体中文的本地字体；必要时设置 `CREATE_ANIMATION_FONT_PATH`。

## 片段选择

1. 用户给出“第12—15秒”“1:20开始截3秒”等明确时间时，使用 `clip.mode: "time-range"`；不调用 VLM。
2. 用户说“成功提示出现之后”“狗跳起来那一段”等视觉事件时，使用 `clip.mode: "visual-query"`：
   - 先运行 `selection` 生成最多48个抽样帧组成的编号联系表；
   - 查看全部联系表和 `selection-index.json`，按可见证据选择候选时间；
   - 把 `resolved_start_seconds`、`resolved_end_seconds` 写回 brief；
   - 同时把生成的 `selection-index.json` 绝对路径写入 `selection_index_path`；渲染会核对联系表摘要、源素材 SHA、查询文案和证据样本时间，不能只填任意编号跳过联系表；
   - 定位存在多个候选或置信度不足时，让用户选片段，不伪造精确时间。
3. 用户说“他说某句话的时候”属于音频语义定位，需要 ASR；当前没有本地 ASR 证据时，让用户提供大致时间，不拿 VLM 猜台词。

语义搜索不把整段视频上传给第三方：FFmpeg 在本地抽低清联系表，当前 Agent 的看图能力只查看这些派生帧。视频超过30分钟且用户没有给大概分钟范围时，必须先追问；明确时间截取不受这条语义搜索上限影响，但仍受512MB附件和4小时硬上限约束。

## Source brief

视频示例：

```json
{
  "schema_kind": "direct-sticker-source",
  "schema_version": 1,
  "project_name": "screen-success",
  "source": {
    "path": "/absolute/authorized/screen-recording.mp4",
    "source_id": "attachment-1",
    "kind": "video",
    "authorized": true,
    "alt": "用户本轮提供的录屏"
  },
  "approved_media_roots": ["/absolute/authorized"],
  "clip": {
    "mode": "visual-query",
    "query": "发送成功提示出现之后",
    "resolved_start_seconds": 6,
    "resolved_end_seconds": 9,
    "evidence_samples": [7, 8, 9],
    "selection_index_path": "/absolute/private/run/screen-success-selection/selection-index.json"
  },
  "message": { "title": "搞定了" },
  "use_case": "群聊表情",
  "aspect_ratio": "1:1",
  "duration_seconds": 3,
  "output_format": "gif",
  "style": "energetic",
  "loop": true,
  "text_position": "bottom",
  "crop_anchor": "center",
  "facts_to_preserve": ["只截取成功提示后的片段"],
  "privacy_review": {
    "status": "reviewed-no-sensitive-content",
    "confirmation": "已检查选中片段，不含账号、通知、聊天隐私或状态栏敏感信息",
    "actions": []
  }
}
```

静态 PNG 使用 `source.kind: "image"`、`duration_seconds: 0`、`output_format: "png"`、`loop: false`，且不含 `clip`。`text_position` 必须由看图后明确选择 `top` 或 `bottom`；`crop_anchor` 必须明确选择 `center/top/bottom/left/right`，v1 不用 `auto` 猜主体位置。

## 私有执行入口

由执行者形成 brief 时，不把含绝对路径的 JSON 留在工程或交付包中。通过 stdin 使用私有包装入口：

```bash
# 只校验；输出 render-ready 或 selection-required
node scripts/direct_sticker_from_stdin.mjs validate

# visual-query 尚未解析时生成联系表
node scripts/direct_sticker_from_stdin.mjs selection <输出父目录>

# 时间段已明确或已由联系表解析后生成成品
node scripts/direct_sticker_from_stdin.mjs render <输出父目录>
```

若 brief 是用户明确提供的文件，可直接运行：

```bash
node scripts/validate_direct_sticker_brief.mjs <brief.json>
node scripts/prepare_video_selection.mjs <brief.json> <输出父目录>
node scripts/render_direct_sticker.mjs <brief.json> <输出父目录>
node scripts/approve_direct_sticker.mjs <direct sticker 工程目录>
node scripts/verify_direct_sticker.mjs <final.gif|final.png> <delivery-brief.json> <visual-approval.json>
```

## 隐私与安全

- 必须使用本轮授权路径和 `source_id`；拒绝符号链接、过宽授权根和授权根外路径。
- 源文件经已打开的安全句柄流式复制到0700私有临时目录；复制前后核对设备号、inode、大小和时间，渲染结束后清理。
- 只允许一个视频流、最多一个音频流；拒绝字幕、数据和附件流。音频一律不进入 GIF。
- 原始视频或图片不写入交付工程；交付 brief 只保留来源标识、摘要和派生结果，不含绝对路径。
- 录屏重点检查账号、通知、聊天、手机号、二维码、状态栏、浏览器标签和文件路径。当前链路不会自动打码；未确认时必须暂停。
- FFmpeg 输出统一丢弃输入 metadata 与 chapters；PNG 成品验证还会拒绝文本、EXIF和时间类 ancillary chunks。

## 验收

- GIF/PNG 必须是512×512、单视频流且无音频、字幕、数据或附件流。
- GIF 必须是12fps、1.5—6秒并带无限循环扩展；首帧已能读到完整文案。
- PNG 必须是真实可解码的单帧 PNG。
- 联系表中的编号、索引时间与最终 `resolved_*` 必须可追溯；不把视觉猜测描述成确定事实。
- 交付前必须查看 `previews/start.png`、`middle.png`、`end.png`（静态图查看 `previews/final.png`），确认裁切锚点、文案换行、主体遮挡和循环接缝；技术验证不能替代这一步。
- 文字在120px聊天缩略图中可读，不遮住画面主要人物、宠物或界面状态。

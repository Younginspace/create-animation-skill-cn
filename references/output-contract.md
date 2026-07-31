# Brief 与交付契约

## 目录

- [输入 source brief](#输入-source-briefjson)
- [字段规则](#字段规则)
- [工程产物](#工程产物)
- [验证闭环](#验证闭环)
- [最终交付](#最终交付)

## 输入 `source-brief.json`

```json
{
  "schema_kind": "source",
  "schema_version": 2,
  "project_name": "family-birthday",
  "function": "card",
  "message": {
    "title": "生日快乐",
    "subtitle": "愿新的一岁平安顺意",
    "signature": "爱你的家人"
  },
  "media": [
    {
      "path": "/absolute/path/photo.jpg",
      "source_id": "attachment-1",
      "authorized": true,
      "alt": "用户提供的生日照片"
    }
  ],
  "approved_media_roots": ["/absolute/path"],
  "use_case": "聊天分享",
  "aspect_ratio": "1:1",
  "duration_seconds": 6,
  "output_format": "mp4",
  "style": "warm",
  "loop": false,
  "facts_to_preserve": ["祝福对象未写姓名"],
  "privacy_review": {
    "status": "reviewed-no-sensitive-content",
    "confirmation": "已检查本轮图片，不含需遮挡的证件、车牌、地址或账户信息",
    "actions": []
  }
}
```

## 字段规则

| 字段 | 必需 | 规则 |
|---|---|---|
| `schema_kind` | 是 | 输入固定为 `source`；不得拿 delivery brief 反向充当输入 |
| `schema_version` | 是 | 当前固定为 `2` |
| `project_name` | 是 | 英文、数字和短横线；1—48字符 |
| `function` | 是 | `sticker`、`card`、`photo-story` |
| `message.title` | 条件 | 必须是字符串；`sticker`、`card` 必填；`photo-story` 可省略或使用空字符串，不接受 `null`，不得渲染占位文字 |
| `message.subtitle` | 否 | 不补造日期、地点、关系或经历 |
| `message.signature` | 否 | 只有用户提供时写入；最多16字符 |
| `media` | 是 | 数组；每项含本地静态 JPG/PNG 路径、唯一且不超过80字符的附件标识、`authorized: true`；最多12项、单项25MB、合计300MB、单图4000万像素；拒绝 GIF/WebP/AVIF/APNG、伪造魔数、无效 CRC/IDAT 与不可解析像素流；JPEG 仅在像素门通过后做 FFmpeg 真解码 |
| `approved_media_roots` | 是 | 最多12项；本轮附件沙箱或用户逐项批准目录；有素材时不能为空；拒绝系统根、用户主目录、`/private`、`/tmp`、`/usr`、`/data` 等公共或单层顶级目录 |
| `use_case` | 是 | 如聊天、朋友圈素材、视频号素材、本地保存 |
| `aspect_ratio` | 是 | `1:1`、`9:16`、`16:9` |
| `duration_seconds` | 是 | 遵守功能时长范围 |
| `output_format` | 是 | `mp4` 或 `gif` |
| `style` | 是 | `warm`、`playful`、`clean`、`energetic` |
| `loop` | 是 | 表情包默认 `true`，其他默认 `false` |
| `facts_to_preserve` | 是 | 明确不得改变或补造的事实，可为空数组 |
| `privacy_review` | 是 | 必须含 `status`、非空 `confirmation` 和 `actions`；状态只允许 `reviewed-no-sensitive-content`、`user-confirmed-keep`、`source-already-redacted` |

本 Skill 不自动遮挡、打码或修图。只有素材在进入 Skill 前已经完成脱敏时，才能使用 `source-already-redacted`，并在 `actions` 中逐项记录已完成的处理；另两种状态的 `actions` 必须为空。

输入 brief 只在受控执行环境中使用，含经本轮授权的源素材绝对路径。它不进入交付工程，文件本身最大256KB。若由执行者创建，应把 JSON 通过 stdin 交给 `scaffold_from_stdin.mjs`；包装入口在权限0700的任务私有临时目录内以0600文件写入，依次运行 validate 与 scaffold，并在同一个 `finally` 中覆盖校验失败、生成失败和成功路径做清理。若 brief 是用户明确提供的文件，本 Skill 只读取，不擅自删除用户文件。

## 工程产物

脚手架必须生成：

- `delivery-brief.json`：固定声明 `schema_kind: "delivery"`、`schema_version: 2`；只保留素材标识和工程相对路径，不含原始绝对路径、授权根目录；`privacy_review` 只保留状态、已完成动作，并声明 `image_metadata: "sensitive-stripped-orientation-preserved"`。PNG 只保留 `IHDR`、`PLTE`、`IDAT`、`IEND` 及透明度必需的 `tRNS`；JPEG 丢弃全部自由 APP/COM 段，只重建最小方向标记，并按需把 Adobe APP14 重建为固定版本、零 flags、仅保留色彩转换值的规范段；与输入 `source-brief.json` 使用不同文件名，禁止互相覆盖或混用；
- `BRIEF.md`：给执行者阅读的事实、边界和输出约定；
- `animation-plan.json`：可检查的镜头与时间计划；
- `asset-manifest.json`：素材标识、工程相对路径、SHA-256 和 `metadata_sanitized: true`；不保存原始绝对路径；
- `hyperframes.json`：工程元数据与 composition 入口；
- `index.html`：固定尺寸、固定时长、可随机寻帧，作为 HyperFrames CLI 默认入口；
- `assets/`：本地素材副本；
- `renders/`、`snapshots/`：输出目录。
- `scaffold_project.mjs` 的第二个参数是工程父目录；脚本自动创建 `<父目录>/<project_name>/`，调用方不得重复附加项目名。

脚手架只创建此前不存在的新工程目录；同名路径即使是空目录或符号链接也必须失败并更换 `project_name`。素材仅使用验证时同一只 `O_NOFOLLOW` 文件句柄读到的字节，不按路径二次读取；工程父目录、工程目录和三个子目录均记录设备号/inode并在写入前后复核，输出文件以 `O_EXCL | O_NOFOLLOW` 的保留句柄写入，避免把旧素材、目录跳转或路径替换混入新交付。生成中途失败时，脚本先关闭全部保留句柄，再只对“本次排他创建且父目录/工程目录设备号、inode、真实路径仍匹配”的半成品做回滚；预存目录或身份已变化的路径绝不删除。

## 验证闭环

媒体成品和可继续渲染的工程是两类不同交付，必须分别验证：

```bash
# 快照检查后必须人工查看并显式批准；批准绑定工程与证据摘要
node scripts/check_project.mjs <工程目录>
node scripts/approve_preview.mjs <工程目录> <snapshots/verified-时间戳目录>

# 成品验证：只接受 MP4/GIF，delivery brief 与 ffprobe 都是硬门槛
node scripts/verify_delivery.mjs renders/final.<mp4|gif> delivery-brief.json

# 工程验证：参数必须是工程目录，不接受单个 HTML 或 ZIP
node scripts/verify_project.mjs <工程目录>
```

`verify_delivery.mjs` 不只核对比例：只允许一个视频流，拒绝音频、字幕、数据和附件流；MP4 必须是 H.264、`yuv420p`、30fps，并精确匹配 composition 的 1080×1080、1080×1920 或 1920×1080；本地优化 GIF 必须是 GIF codec、12fps，并为 512×512、512×910 或 512×288。`loop: true` 的 GIF 必须带无限循环扩展，`loop: false` 的 GIF 不得含循环扩展；只有扩展名、容器、codec、像素格式、帧率、绝对尺寸、时长和循环语义全部一致才通过。

`verify_project.mjs` 要求工程目录同时存在 `delivery-brief.json`、`index.html`、`hyperframes.json`、`animation-plan.json`、`asset-manifest.json` 和 `assets/`。它以有界文件句柄读取并限制目录深度、项目项数、工程总量和素材总量；严格核对功能时长、固定画布、30fps、渲染器版本、元数据一致性、精确离线 CSP、真实 HTML 时间线注册、网络/动态执行入口、离线资源引用、每个本地素材的 SHA-256、图片允许格式与清洗后字节是否闭环。JPEG 还会在像素门通过后再次做 FFmpeg 真解码。所有文本文件都会扫描任意绝对路径和远程 URL；任何符号链接、特殊文件、`source-brief.json`、旧 `brief.json`、`.git`、`node_modules`、漏登记、缺失或仍含可剥离元数据的素材都会失败。

`delivery-brief.json` 的 `message`、`use_case`、`style`、`facts_to_preserve`、隐私状态、素材标识和输出参数均由共享严格校验器同时用于工程与成品验证；缺字段、未知类型、越界或非法枚举不能只靠其他文件“看起来一致”而通过。`check_project.mjs` 的 `run-manifest.json` 记录当前工程契约摘要与快照证据摘要；`approve_preview.mjs` 只有在人查看完指定快照后才运行，`render_project.mjs` 在渲染前和写回前都会拒绝缺失、过期或不匹配的批准。

首版不把单个 HTML 或 ZIP 当作“已验证工程包”。如需发工程，应交付已经通过 `verify_project.mjs` 的完整工程目录；ZIP 仅可作为该目录的传输容器，解压后必须重新按目录验证，单独 `unzip -t` 不构成交付验收。

## 最终交付

聊天中只需说明：

1. 主文件及兼容文件；
2. 比例、时长、是否循环；
3. 使用了哪些用户素材标识；不得暴露原始绝对路径；
4. 做过哪些隐私处理；
5. 任何降级项，例如“本机缺少渲染环境，仅交付已通过工程目录验证、可继续渲染的工程”。

不要声称已发布、已同步或会持续维护。

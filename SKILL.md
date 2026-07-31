---
name: create-animation
description: 用用户在本轮明确提供并授权的静态 JPEG/PNG 照片、截图、栅格图标和短文案制作可分享的动态表情包、动态祝福/邀请卡或照片故事短片，并交付 MP4 或 GIF 文件。适用于“把这张图做成会动的表情”“做一张生日动态卡”“把这些照片做成十几秒回忆短片”等请求，也适用于修改本 Skill 已生成的动画工程。不用于人物口型驱动、影视级角色动画、纯文生视频、现成视频剪辑、配乐、旁白、口播字幕、多段视频重排、超过30秒的复杂剪辑、自动发布到社交平台，或只有静态修图需求的请求。
---

# 制作动画

把用户的真实素材变成一份能直接预览和分享的短动画。吸收技术复杂度，不要求用户理解 HyperFrames、时间线或编码参数。

## 执行流程

1. **选择一个功能**
   - 单张照片、贴纸或短句，强调循环反应：`sticker`（动态表情包）。
   - 祝福、邀请、官宣或提醒：`card`（动态卡片）。
   - 3—12张照片按真实顺序讲一件事：`photo-story`（照片故事）。
   - 无法唯一判断时，只问“你更想要表情包、动态卡片，还是照片短片？”
   - 只读取命中的一个规则文件：[sticker-rules.md](references/sticker-rules.md)、[card-rules.md](references/card-rules.md) 或 [photo-story-rules.md](references/photo-story-rules.md)。

2. **检查最低输入**
   - 始终复用本轮对话和附件，不重复索取。
   - 最低输入为：要表达什么、可用真实素材、使用位置、期望比例或输出格式。
   - 缺少素材时：
     - `sticker` 可做纯文字表情；
     - `card` 可做纯文字动态图卡；
     - `photo-story` 必须有至少3张图片，缺失时追问。
   - 用户未指定时：`sticker` 采用聊天分享、1:1、循环 GIF；`card` 采用聊天分享、1:1、MP4；`photo-story` 采用聊天分享、9:16、MP4。
   - 不为配色、字体或每个动画动作逐项追问；根据内容和素材保守选择。

3. **锁定事实与授权**
   - 只使用用户在本轮提供或逐项明确授权的素材；“本地能读取”不等于已授权。
   - 把附件沙箱或用户批准目录写入 `approved_media_roots`；每个素材写 `source_id` 和 `authorized: true`。脚本会拒绝素材根以外的路径、符号链接，以及 `/private`、`/tmp`、用户主目录等过宽授权。
   - 首版只接收可完整解析的静态 JPEG/PNG；PNG 必须通过像素流解析，JPEG 还必须由预装 FFmpeg 真实解码。动画 GIF/WebP/AVIF/APNG 不受寻帧时间线控制，必须拒绝。
   - 不编造照片中的地点、人物关系、日期、经历或祝福对象。
   - 未知事实不写进字幕；可把用户原话缩短，但不得改变含义。
   - 首版不接收音乐；若用户要求配乐，说明当前仅支持图片和文字，不联网找歌。
   - 逐张检查未成年人、身份证件、住址、车牌、敏感聊天、账户名和状态栏/菜单栏信息。本 Skill 不会自动遮挡：有敏感内容时必须暂停，直到用户明确同意保留，或用户提供已脱敏副本。
   - 在 `privacy_review` 留下三选一状态与依据：确认无敏感内容、用户明确同意保留、输入素材已先行脱敏。未完成确认不得生成工程。

4. **形成 brief 并脚手架**
   - 按 [output-contract.md](references/output-contract.md) 形成 source brief；它只在授权执行环境中使用。
   - 由执行者创建时，把 JSON 通过 stdin 交给私有包装入口。它会在权限0700的任务临时目录中以0600写入，依次校验和脚手架，并在 `finally` 中覆盖 validate/scaffold 成功或失败的所有路径做清理：

```bash
node scripts/scaffold_from_stdin.mjs <工程父目录>
```

   - 若 brief 是用户明确提供的文件，只读取、不代替用户删除；从本 Skill 目录运行：

```bash
node scripts/validate_brief.mjs <source-brief.json>
node scripts/scaffold_project.mjs <source-brief.json> <工程父目录>
```

   - 第二个参数必须是父目录；脚手架会在其下新建 `<project_name>/`，不要再把 `project_name` 拼进参数。
   - 脚手架只复制校验时同一只安全文件句柄实际读到的字节，不会在校验后按原路径二次读取；随后把 PNG 收窄到像素解码、调色板和透明度必需的 chunk，JPEG 丢弃全部自由 APP/COM 元数据，只重建最小方向标记和规范化 Adobe 色彩转换段。清洗后的 JPEG 会再次真实解码。最后记录 SHA-256，并生成脱敏 `delivery-brief.json`、计划、manifest 和带离线 CSP、可寻帧的根目录 `index.html`。
   - 它只创建此前不存在的新工程目录；即使同名目录为空也拒绝写入，以避免符号链接与目录替换。不把新任务合并进旧素材。
   - 脚本只生成可用基线。需要个性化时，在保持 [hyperframes-contract.md](references/hyperframes-contract.md) 约束的前提下修改 composition。
   - 修改已有工程时，不重跑脚手架：先用 `node scripts/verify_project.mjs <工程目录>` 验证，再读取 `delivery-brief.json` 和计划后修改 `index.html`；如需换素材，用新 `project_name` 重新生成工程，保留旧版。

5. **检查运行环境**
   - 首次执行或换机器时运行：

```bash
node scripts/check_runtime.mjs
```

   - 读取 [runtime-and-china.md](references/runtime-and-china.md) 判断档位：
     - `author-only`：只能校验和生成工程，任务尚未完成；
     - `preview-check`：可本地逐帧检查，但不能交付媒体成片；
     - `full-render`：可检查、渲染并验证 MP4/GIF。
   - 不在运行时加载 Google Fonts、jsDelivr、国外地图或远程图片。所有必需资源必须本地化。

6. **预览、修正、再渲染**
   - 从本 Skill 目录先运行 `node scripts/check_project.mjs <工程目录>`。该入口会先验证离线工程闭环，再调用固定版本的 HyperFrames 做快照检查。
   - 检查入口会先把已验证工程冻结到私有临时目录执行，再把本次快照写回 `snapshots/verified-<时间戳>/`；`photo-story` 会从 `animation-plan.json` 推导每次换图前/中/后三个时间点，并生成其中的 `transitions/`，必须逐张查看。
   - 人工查看至少首帧、主动作峰值、结束帧；`photo-story` 还要检查每次换图。检查入口会输出本次 `snapshots/verified-<时间戳>/` 的准确路径。
   - 发现文字截断、人物被遮、闪白、素材变形或结束帧不能自然循环时，修改后重新检查。
   - 快照人工确认无误后，从本 Skill 目录运行 `node scripts/approve_preview.mjs <工程目录> <snapshots/verified-时间戳目录>`。该命令把人工批准绑定到当前工程 SHA-256 和本次快照证据 SHA-256；工程或快照改变后旧批准自动失效。
   - 只有检查通过且存在与当前工程一致的人工批准后才渲染；`render_project.mjs` 会强制读取该批准，不能直接绕过。生产执行不允许临时 `dlx`/`npx` 下载；检查和渲染入口会关闭 HyperFrames telemetry、以 0.7.83 实际支持的参数跳过后台联网检查，并把两项浏览器路径同时固定到只放行 loopback 的离线守卫。渲染同样只执行私有冻结副本，源工程变化时拒绝回写。
   - 从本 Skill 目录运行 `node scripts/render_project.mjs <工程目录> [draft|high]`，让 `brief.output_format` 决定 MP4 或循环 GIF。

7. **交付并说明**
   - 使用 `node scripts/verify_delivery.mjs <产物路径> <delivery-brief.json>` 做最终检查；缺 brief 或 ffprobe 都不得通过。
   - `author-only` 或 `preview-check` 只能说明阻断与可恢复工程位置；不得把 HTML、ZIP、截图或旧产物冒充成片。
   - 默认交付一个主文件；仅在分享场景确实需要时增加一个兼容格式。
   - 告知用户：主文件、比例、时长、是否循环、使用了哪些用户素材，以及任何未完成或降级项。
   - 不自动发布、不声称已同步微信/QQ，也不承诺跨会话继续维护工程。

## 工具规则

- 读取静态 JPEG/PNG 图片元数据并查看实际像素后再设计，不凭文件名猜内容；首版不接收视频或 SVG。
- 脚本用于可重复的结构、路径、校验和工程生成；视觉判断仍需看快照。
- HyperFrames 只负责确定性的 HTML 动效和渲染，不替代文生视频或角色动画模型。
- 外部素材搜索不是默认步骤；必须搜索时，先确认授权和来源，并下载到工程内再渲染。
- 渲染命令、国内安装方式与失败恢复只在需要时读取 [runtime-and-china.md](references/runtime-and-china.md)。
- 维护或重新审计上游版本时才读取 [source-attribution.md](references/source-attribution.md)；执行普通用户任务时不读取。

## 质量检查

- 是否命中且只执行一个功能？
- 是否使用真实素材和用户原话，未补造经历？
- 隐私状态是否有依据；敏感内容未确认时是否暂停？
- 是否明确用途、比例、时长和主输出格式？
- 文字在手机尺寸下是否一眼可读，且没有贴边或截断？
- 动效是否由内容驱动，而不是堆叠无关特效？
- 每一帧是否可由时间值确定，且没有网络运行时依赖？
- 人像主体是否完整、图片是否未拉伸、切换是否无闪白？
- 循环产物首尾是否自然，非循环产物是否有稳定结束帧？
- 是否先预览检查、再渲染、最后验证文件？
- 交付说明是否区分“已生成视频”和“尚未完成、只保留工程”？

## 运行边界

- 单个作品默认不超过30秒；需要完整剪辑、口播字幕或多段视频重排时交给视频剪辑能力。
- 不调用海外 TTS、ASR、地图、字体或素材服务作为必需链路。
- 不在没有运行环境证据时承诺可渲染，不在没有发布权限时替用户发布。
- 不把用户素材上传到未经确认的第三方服务。

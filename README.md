# create-animation-skill-cn

面向中文 C 端用户的可审计动画制作 Skill。它把用户明确授权的静态 JPEG/PNG、单段视频和短文案制作成：

- 动态表情包（GIF）
- 视频片段表情包（GIF）
- 静态照片表情包（PNG）
- 动态祝福卡、生日卡与邀请卡（MP4）
- 30 秒以内的照片故事（MP4）

仓库根目录就是可安装的 Skill 目录，入口为 [`SKILL.md`](SKILL.md)。

## 当前状态

`v0.5.0` 在中文语境 Creative 路由之外，新增不依赖 HyperFrames/浏览器的视频截 GIF 与静态 PNG 链路：

- 用户给出明确时间时直接截取，不调用 VLM；描述“成功提示出现后”等视觉事件时，本地抽取编号联系表供当前 Agent 看图定位；
- 视频表情固定为单个1.5—6秒片段、512×512、12fps、无限循环 GIF，音频一律移除；
- 静态照片表情直接交付512×512 PNG，不会为了套动画链路强制输出 GIF 或 MP4；
- 语义搜索单次最多覆盖30分钟，更长视频先让用户缩小大概分钟范围；准确时间截取不受该搜索窗口限制；
- 台词自动定位仍需要 ASR，当前没有本地 ASR 时不会拿画面模型猜台词；
- direct sticker 只依赖 FFmpeg、ffprobe 和本地中文字体，不依赖 HyperFrames CLI 或无头浏览器；

- 照片表情默认使用全屏原图，不再叠加冗余装饰背景；
- 成年父母生日、儿童生日、家庭聚餐邀请、考试加油与一般提醒拥有不同视觉系统；
- 纯文字表情先判断受众、语气、构图和视觉隐喻，再建立文字主次、背景/中景/前景和差异化动效；
- 每个新工程通过 `cn-context-router-v2` 生成 `creative-plan.json`，触发信号和创意判断会进入校验与人工批准摘要；
- 纯文字表情和无图卡片只重排用户原话，不自动补写英文题头、关系、日期、地点或祝福；
- 照片表情会在工作状态、强反应、粗粝热梗、可爱反应和干净克制五类语法间自动选择，且首帧即可读、循环不黑场；
- GIF 是可直接保存的真实文件，固定优化为 512px、12fps、128 色；
- 工程、素材、关键帧人工批准与最终媒体都有本地校验；
- 不在任务运行时自动联网安装依赖；
- GitHub/ZIP 安装导致脚本失去可执行位时，浏览器守卫会自动生成私有可执行副本；
- 透明背景 GIF 尚未作为已验证能力开放。

v0.5 已新增并实测：录屏视觉语义选段、明确时间视频截 GIF、真实照片静态 PNG，以及超过30分钟且范围不足时的安全暂停；原有图片动画合约回归测试保持通过。脚手架仍是可修改的设计起点；`SKILL.md` 要求交付前按真实文案和素材进行视觉判断。

## 安装

直接克隆到 Agent 的 Skill 目录：

```bash
git clone --depth 1 https://github.com/Younginspace/create-animation-skill-cn.git \
  ~/.codex/skills/create-animation
```

也可以下载仓库 ZIP，将解压后的目录命名为 `create-animation`，并确保目录根部直接存在 `SKILL.md`。

## 运行环境

合约校验和纯文字工程生成需要：

- Node.js 22+

视频截 GIF 或静态 PNG 需要 Node.js 22+，并只额外要求预装：

- FFmpeg 与 ffprobe（FFmpeg 带 `drawtext/libfreetype`，GIF 还需 `palettegen/paletteuse`）
- 有明确授权的本地中文字体

常规图片动画的预览与渲染另外需要：

- `hyperframes@0.7.83` CLI
- Chrome 或 Chromium
- FFmpeg 与 ffprobe
- 有明确授权的本地中文字体

GIF 会先由 HyperFrames 捕获为本地 MP4 中间产物，再由 FFmpeg 转为受控 GIF；这避免把上游 0.7.83 的高细节调色板编码故障暴露给普通用户。

运行时不会用 `npx`、`pnpm dlx` 或 `bunx` 自动下载缺失依赖。国内部署与离线策略见 [`references/runtime-and-china.md`](references/runtime-and-china.md)。

## 快速检查

```bash
node scripts/check_runtime.mjs
node scripts/contract_self_test.mjs
```

常规动画输入示例位于 [`assets/brief.example.json`](assets/brief.example.json)，视频/静态表情示例位于 [`assets/direct-sticker.example.json`](assets/direct-sticker.example.json)。

视频或静态表情的 direct sticker 流程见 [`references/direct-sticker-contract.md`](references/direct-sticker-contract.md)：

```bash
# stdin 输入 direct-sticker-source JSON
node scripts/direct_sticker_from_stdin.mjs validate
node scripts/direct_sticker_from_stdin.mjs selection ./runs
node scripts/direct_sticker_from_stdin.mjs render ./runs
# 查看 runs/<project>/previews 后：
node scripts/approve_direct_sticker.mjs ./runs/<project>
node scripts/verify_direct_sticker.mjs ./runs/<project>/renders/final.<gif|png> ./runs/<project>/delivery-brief.json ./runs/<project>/visual-approval.json
```

## 基本流程

```bash
# 1. 校验输入
node scripts/validate_brief.mjs source-brief.json

# 2. 生成工程
node scripts/scaffold_project.mjs source-brief.json ./runs

# 3. 检查工程并生成快照
node scripts/check_project.mjs ./runs/<project_name>

# 4. 人工确认快照
node scripts/approve_preview.mjs \
  ./runs/<project_name> \
  ./runs/<project_name>/snapshots/verified-<timestamp>

# 5. 渲染并验收
node scripts/render_project.mjs ./runs/<project_name> high
node scripts/verify_delivery.mjs \
  ./runs/<project_name>/renders/final.<gif|mp4> \
  ./runs/<project_name>/delivery-brief.json
```

完整路由、安全边界和交付规则以 [`SKILL.md`](SKILL.md) 为准。

## 隐私与安全

- 只处理用户在当前任务中明确提供并授权的本地素材；
- 不包含远程素材搜索、地图、TTS/ASR、数字人口型或第三方上传；
- 建议在任务沙箱中运行，并由容器或操作系统策略限制进程外网；
- 不要把含用户素材路径的 `source-brief.json`、快照或渲染成品提交到仓库。

## 来源与许可证

本项目以 Apache License 2.0 发布。渲染接口兼容性与工作流参考了 Apache-2.0 许可的 [HyperFrames](https://github.com/heygen-com/hyperframes)，详细版本和改造边界见 [`references/source-attribution.md`](references/source-attribution.md) 与 [`NOTICE`](NOTICE)。

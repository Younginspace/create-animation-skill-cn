# create-animation-skill-cn

面向中文 C 端用户的可审计动画制作 Skill。它把用户明确授权的静态 JPEG/PNG 和短文案制作成：

- 动态表情包（GIF）
- 动态祝福卡、生日卡与邀请卡（MP4）
- 30 秒以内的照片故事（MP4）

仓库根目录就是可安装的 Skill 目录，入口为 [`SKILL.md`](SKILL.md)。

## 当前状态

`v0.4.1` 已把中文语境自动 Creative 路由接入实际工程协议，并强化照片表情的自动美学路由：

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

已用十个典型用户案例完成 v0.4 全量复测：八个可交付案例均重新完成“工程生成 → 关键帧人审 → GIF/MP4 渲染 → ffprobe 验证”，两个边界案例正确暂停或转交。脚手架仍是可修改的设计起点；`SKILL.md` 要求交付前按真实文案和素材进行视觉判断。

## 安装

直接克隆到 Agent 的 Skill 目录：

```bash
git clone --depth 1 https://github.com/Younginspace/create-animation-skill-cn.git \
  ~/.codex/skills/create-animation
```

也可以下载仓库 ZIP，将解压后的目录命名为 `create-animation`，并确保目录根部直接存在 `SKILL.md`。

## 运行环境

纯文字工程生成需要：

- Node.js 22+

预览与渲染还需要预装：

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

输入契约示例位于 [`assets/brief.example.json`](assets/brief.example.json)。

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

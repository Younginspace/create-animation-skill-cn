# create-animation-skill-cn

面向中文 C 端用户的可审计动画制作 Skill。它把用户明确授权的静态 JPEG/PNG 和短文案制作成：

- 动态表情包（GIF）
- 动态祝福卡、生日卡与邀请卡（MP4）
- 30 秒以内的照片故事（MP4）

仓库根目录就是可安装的 Skill 目录，入口为 [`SKILL.md`](SKILL.md)。

## 当前状态

`v0.1.0` 是优化前的公开基线，用于建立可追溯版本：

- 工程、素材、预览批准与最终媒体都有本地校验；
- 不在任务运行时自动联网安装依赖；
- 支持真实 GIF/MP4 交付验证；
- 已知视觉问题：无图卡片的基础脚手架过于同质化，照片表情默认装饰背景偏重；
- 透明背景 GIF 尚未作为已验证能力开放。

后续版本会把表情背景策略、场景化卡片模板和视觉验收门槛作为重点改造项。

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


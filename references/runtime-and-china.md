# 运行环境与国内可用性

## 结论

HyperFrames 本体是 Apache-2.0 开源项目，composition 是本地 HTML/CSS/JavaScript，适合做确定性短动效。国内可用性的主要风险不在动画代码，而在首次安装、浏览器、FFmpeg、远程字体/脚本和上游某些工作流依赖的海外服务。

本 Skill 把远程字体、CDN脚本、地图、HeyGen、海外TTS/ASR和素材搜索移出必需链路。基线 composition 不依赖 GSAP CDN。生产执行阶段**完全禁止** `pnpm dlx`、`npx`、`bunx` 等自动联网回退；只接受预装的 `hyperframes` 命令，或 `HYPERFRAMES_CLI` 指向的可执行文件，且版本必须严格为 `0.7.83`。

## 运行档位

### `author-only`

需要 Node.js 22 或更高。纯文字任务可校验 brief 并生成完整工程，但不能声称已经完成浏览器快照检查或生成视频。含 PNG 的任务仍可由内置解析器验证；含 JPEG 的任务必须另有预装 FFmpeg 做真实解码，缺少时要停止，不能把结构标记检查冒充像素有效。工程复核也会重新比对图片清洗后的字节，并对 JPEG 再解码一次，因此不能只靠 manifest 中的 `metadata_sanitized: true` 声明放行。

若缺少 CLI、浏览器或本地中文字体，`check_runtime.mjs` 会停留在此档。工程可以交给预装完整依赖的环境继续处理；但 JPEG 输入在缺少 FFmpeg 时不会生成工程。

### `preview-check`

在 `author-only` 基础上还需要：

- HyperFrames CLI 严格为 0.7.83；
- Chromium/Chrome；
- 已授权的本地中文字体。

此档可运行 HyperFrames 快照检查，但缺少 FFmpeg 或 ffprobe 时仍不能生成并验收最终媒体文件。

### `full-render`

在 `preview-check` 基础上还需要：

- FFmpeg 与 ffprobe；
- 足够写入工程、浏览器缓存和渲染文件的空间。

推荐先运行环境检查。脚本会严格核对 CLI 版本，且不会尝试联网补装：

```bash
node <SKILL_DIR>/scripts/check_runtime.mjs
```

确认达到对应档位后，在工程目录执行：

```bash
node <SKILL_DIR>/scripts/check_project.mjs .
node <SKILL_DIR>/scripts/approve_preview.mjs . snapshots/verified-<时间戳>
node <SKILL_DIR>/scripts/render_project.mjs . high
node <SKILL_DIR>/scripts/verify_delivery.mjs renders/final.<mp4|gif> delivery-brief.json
```

`check_project.mjs` 与 `render_project.mjs` 都会先运行工程闭环验证，再把工程复制到权限收窄的私有临时目录并复验，只对该冻结副本调用精确版本的预装 CLI。二者给 0.7.83 根命令保留 `--json`；这是该版本真正跳过 npm 版本查询与远程 Skill 清单查询的必要条件，不只是输出格式偏好。检查入口还会传入 `--at-transitions`；照片故事会从计划中推导每次换图前/中/后三个明确时间点，并把本次结果保存到 `snapshots/verified-<时间戳>/transitions/`。人工查看后必须显式运行 `approve_preview.mjs`；批准同时绑定当前工程契约 SHA-256 和快照证据 SHA-256，任何后续修改都会让渲染入口拒绝旧批准。

`render_project.mjs` 会在私有运行目录生成并验证临时产物；只有 CLI 成功退出、成品通过 delivery brief + ffprobe 验证、源工程未变化且 `renders/` 身份未被替换时，才以排他临时句柄复制并原子替换 `renders/final.<格式>`。GIF 不直接走 0.7.83 的 GIF 调色板编码：先由 HyperFrames 生成本地 MP4 中间产物，再由 FFmpeg 压到 512px 宽、12fps、128色调色板并清除容器元数据。这规避了高细节图片在上游 GIF 编码阶段可复现的内部错误；任一步失败都会清理私有运行目录并保留旧的 final。

如使用 `HYPERFRAMES_CLI`，它必须指向可直接执行且能通过 `--version --json` 检查的 0.7.83 CLI 文件；不要指向需由 `node` 间接启动的源码入口。环境检查、版本检查、快照检查和渲染子进程都会设置 `HYPERFRAMES_NO_TELEMETRY=1`、`HYPERFRAMES_NO_UPDATE_CHECK=1`、`HYPERFRAMES_NO_AUTO_INSTALL=1` 与 `DO_NOT_TRACK=1`；其中 CLI 的后台更新请求另由上述 `--json` 参数可靠跳过。

运行入口会把 `HYPERFRAMES_BROWSER_PATH` 和 `PRODUCER_HEADLESS_SHELL_PATH` 同时指向本 Skill 的浏览器守卫，由守卫调用已预装的真实 Chrome/Chromium。若 ZIP 下载或 GitHub 网页编辑让守卫文件失去可执行位，入口会读取已验证的守卫源码，在权限0700的私有临时目录生成权限0700的可执行副本，任务结束后删除；不要求用户手工 `chmod`。浏览器只放行 `localhost`、`127.0.0.1` 与 `::1`，外部代理端口固定为不可达地址，并禁用 QUIC、后台联网、组件更新与非代理 WebRTC。composition 还必须携带 `connect-src 'none'` 的精确 CSP，工程验证会拒绝网络 API、动态执行和页面跳转入口。以上是应用层防线；生产环境仍必须用容器/OS egress policy 作为整个 Node/FFmpeg 进程的最终网络边界，不能把浏览器参数描述成系统级防火墙。

## 国内生产建议

| 依赖 | 开发机 | 元宝生产建议 |
|---|---|---|
| `hyperframes@0.7.83` | 在受控安装阶段从 npm 或内部镜像安装 | 执行镜像内预装，锁版本与完整性哈希；任务运行时禁联网补装 |
| Node.js | 本地/系统 | 固定 Node 22+ 镜像 |
| Chromium | 受控安装阶段准备 | 预装固定版本；两个 HyperFrames 浏览器环境变量均固定到离线守卫，禁止运行时下载 |
| FFmpeg/ffprobe | 系统包 | 预装并登记许可证构建选项 |
| 中文字体 | 系统字体 | 使用已获授权的本地字体包 |
| GSAP | 不需要 | 基线使用自带时间线适配器 |
| 图片素材 | 用户本地素材 | 保存在任务沙箱，不上传第三方 |

`check_runtime.mjs` 只证明当前任务环境“能否运行”，不替代生产供应链证明。元宝镜像发布 CI 还必须核对 OCI image digest / SBOM、HyperFrames lockfile integrity、Chromium 与 FFmpeg/ffprobe 二进制 SHA-256、FFmpeg configure flags 与许可证结论，以及中文字体文件 SHA-256、授权凭证 ID 和简体中文字形抽样。缺少这些发布记录时，即使任务探测为 `full-render`，也只能说明技术可执行，不能说明生产合规。

## 失败恢复

- npm 不通：只在镜像构建或人工安装阶段切内部镜像；任务运行时直接失败，不切换到不明镜像。
- CLI 缺失或版本不符：停在 `author-only`，由运维补齐严格为 0.7.83 的预装 CLI。
- 浏览器缺失：停在 `author-only`，不要在用户等待时临时下载大型浏览器。
- FFmpeg 或 ffprobe 缺失：停在 `preview-check`，保留工程和快照；不要声称 MP4 已完成。
- 中文字体缺字：更换本地授权字体后重新检查换行与边界。
- GIF 过大：优先缩短至6秒内；正式渲染入口固定优化为512px宽、12fps、128色。仍过大时在征得用户同意后交付MP4。
- `check_project.mjs` 失败：先修复工程闭环或 HyperFrames 报错后重跑；不得绕过包装入口直接渲染。
- `render_project.mjs` 报缺少批准：查看最新 `snapshots/verified-*` 的全部关键帧，显式运行 `approve_preview.mjs`；工程或快照已经变化时必须重新检查，不能复制旧 `approval.json`。

#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requirePreviewApproval } from "./approve_preview.mjs";
import {
  freezeProject,
  guardedRuntimeEnv,
  NO_TRACKING_ENV,
} from "./runtime_guard.mjs";
import { verifyDelivery } from "./verify_delivery.mjs";
import { verifyProject } from "./verify_project.mjs";

const REQUIRED_HYPERFRAMES_VERSION = "0.7.83";
const PROCESS_TIMEOUT_MS = 20 * 60 * 1000;
export { NO_TRACKING_ENV };

function inspectCli(name) {
  const result = spawnSync(name, ["--version", "--json"], {
    encoding: "utf8",
    timeout: 5000,
    env: NO_TRACKING_ENV,
  });
  const output = (result.stdout || result.stderr || "").trim();
  const detectedVersion = output.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1] ?? null;
  return {
    available: !result.error && result.status === 0,
    detectedVersion,
  };
}

export function resolveRunner() {
  const override = process.env.HYPERFRAMES_CLI;
  if (override) {
    if (!existsSync(override)) {
      throw new Error("HYPERFRAMES_CLI 指向的文件不存在");
    }
    const inspected = inspectCli(override);
    if (!inspected.available) {
      throw new Error("HYPERFRAMES_CLI 必须指向可直接执行且能通过 --version --json 检查的 CLI");
    }
    if (inspected.detectedVersion !== REQUIRED_HYPERFRAMES_VERSION) {
      throw new Error(
        `HYPERFRAMES_CLI 版本必须严格为 ${REQUIRED_HYPERFRAMES_VERSION}，当前为 ${inspected.detectedVersion || "无法识别"}`,
      );
    }
    return override;
  }
  const inspected = inspectCli("hyperframes");
  if (!inspected.available) {
    throw new Error(
      "未找到预装 HyperFrames CLI；生产执行禁止 pnpm dlx、npx、bunx 等自动联网回退",
    );
  }
  if (inspected.detectedVersion !== REQUIRED_HYPERFRAMES_VERSION) {
    throw new Error(
      `HyperFrames CLI 版本必须严格为 ${REQUIRED_HYPERFRAMES_VERSION}，当前为 ${inspected.detectedVersion || "无法识别"}`,
    );
  }
  return "hyperframes";
}

async function captureDirectoryIdentity(directory) {
  const info = await lstat(directory);
  const resolved = await realpath(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || resolved !== directory) {
    throw new Error(`输出目录必须是非符号链接的真实目录：${directory}`);
  }
  return { dev: info.dev, ino: info.ino, resolved };
}

async function assertDirectoryIdentity(directory, expected) {
  const current = await captureDirectoryIdentity(directory);
  if (
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.resolved !== expected.resolved
  ) {
    throw new Error("renders/ 在渲染期间被替换，拒绝回写");
  }
}

async function copyArtifactAtomically(source, destination, assertSafe) {
  const destinationDir = path.dirname(destination);
  const temporary = path.join(
    destinationDir,
    `.create-animation.${process.pid}.${Date.now()}.${path.basename(destination)}.tmp`,
  );
  const sourceHandle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let targetHandle = null;
  try {
    const sourceInfo = await sourceHandle.stat();
    if (!sourceInfo.isFile() || sourceInfo.size <= 0) throw new Error("待交付产物不是非空普通文件");
    await assertSafe();
    targetHandle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW || 0),
      0o600,
    );
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (position < sourceInfo.size) {
      const length = Math.min(buffer.length, sourceInfo.size - position);
      const { bytesRead } = await sourceHandle.read(buffer, 0, length, position);
      if (!bytesRead) throw new Error("读取临时产物时意外结束");
      await targetHandle.write(buffer, 0, bytesRead, position);
      position += bytesRead;
    }
    const sourceAfter = await sourceHandle.stat();
    if (
      sourceAfter.size !== sourceInfo.size ||
      sourceAfter.mtimeMs !== sourceInfo.mtimeMs ||
      sourceAfter.ctimeMs !== sourceInfo.ctimeMs
    ) {
      throw new Error("临时产物在复制期间发生变化");
    }
    await targetHandle.sync();
    await targetHandle.close();
    targetHandle = null;
    await assertSafe();
    await rename(temporary, destination);
    await assertSafe();
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  } finally {
    await targetHandle?.close().catch(() => {});
    await sourceHandle.close().catch(() => {});
  }
}

export async function main() {
  const projectDir = path.resolve(process.argv[2] || ".");
  const quality = process.argv[3] || "high";
  if (!["draft", "high"].includes(quality)) {
    console.error("质量必须是 draft 或 high");
    process.exit(2);
  }
  let frozen = null;
  try {
    const projectCheck = await verifyProject(projectDir);
    if (!projectCheck.ok) {
      throw new Error(`工程未通过交付前验证：${projectCheck.errors.join("；")}`);
    }
    const previewApproval = await requirePreviewApproval(projectDir);
    frozen = await freezeProject(projectDir, verifyProject);
    const executionProject = frozen.frozenRoot;
    const brief = JSON.parse(
      await readFile(path.join(executionProject, "delivery-brief.json"), "utf8"),
    );
    const format = brief.output_format;
    if (!["mp4", "gif"].includes(format)) throw new Error("brief.output_format 必须是 mp4 或 gif");
    const rendersDir = path.join(projectDir, "renders");
    await mkdir(rendersDir, { recursive: false, mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const rendersIdentity = await captureDirectoryIdentity(rendersDir);
    const output = path.join(rendersDir, `final.${format}`);
    const temporaryOutput = path.join(
      frozen.workspace,
      `.final.${process.pid}.${Date.now()}.tmp.${format}`,
    );
    const captureOutput =
      format === "gif"
        ? path.join(frozen.workspace, `.capture.${process.pid}.${Date.now()}.tmp.gif`)
        : temporaryOutput;
    const runner = resolveRunner();
    const runtimeEnv = await guardedRuntimeEnv();
    const args = [
      "render",
      executionProject,
      "--quality",
      quality,
      "--format",
      format,
      "--output",
      captureOutput,
      "--strict",
      "--no-best-effort",
      "--json",
    ];
    if (format === "gif") args.push("--fps", "12", "--gif-loop", brief.loop ? "0" : "1");
    const result = spawnSync(runner, args, {
      stdio: "inherit",
      env: runtimeEnv,
      timeout: PROCESS_TIMEOUT_MS,
    });
    if (result.error) {
      await unlink(captureOutput).catch(() => {});
      await unlink(temporaryOutput).catch(() => {});
      throw result.error;
    }
    if (result.status !== 0) {
      await unlink(captureOutput).catch(() => {});
      await unlink(temporaryOutput).catch(() => {});
      throw new Error(`HyperFrames 渲染进程退出码 ${result.status ?? 1}`);
    }
    const captureInfo = await stat(captureOutput).catch(() => null);
    if (!captureInfo?.isFile() || captureInfo.size <= 0) {
      await unlink(captureOutput).catch(() => {});
      await unlink(temporaryOutput).catch(() => {});
      throw new Error("HyperFrames 未生成有效的临时产物，原 final 文件保持不变");
    }
    if (format === "gif") {
      const filter =
        "fps=12,scale=512:-2:flags=lanczos,split[s0][s1];" +
        "[s0]palettegen=max_colors=128:stats_mode=diff[p];" +
        "[s1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle";
      const optimization = spawnSync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          "-i",
          captureOutput,
          "-filter_complex",
          filter,
          "-map_metadata",
          "-1",
          "-loop",
          brief.loop ? "0" : "-1",
          temporaryOutput,
        ],
        { stdio: "inherit", env: runtimeEnv, timeout: PROCESS_TIMEOUT_MS },
      );
      await unlink(captureOutput).catch(() => {});
      if (optimization.error) {
        await unlink(temporaryOutput).catch(() => {});
        throw new Error(`GIF 本地优化失败：${optimization.error.message}`);
      }
      if (optimization.status !== 0) {
        await unlink(temporaryOutput).catch(() => {});
        throw new Error(`GIF 本地优化进程退出码 ${optimization.status ?? 1}`);
      }
    }
    const outputInfo = await stat(temporaryOutput).catch(() => null);
    if (!outputInfo?.isFile() || outputInfo.size <= 0) {
      await unlink(captureOutput).catch(() => {});
      await unlink(temporaryOutput).catch(() => {});
      throw new Error("未生成有效的最终临时产物，原 final 文件保持不变");
    }
    const deliveryCheck = await verifyDelivery(
      temporaryOutput,
      path.join(executionProject, "delivery-brief.json"),
    );
    if (!deliveryCheck.ok) {
      throw new Error(`临时产物未通过成品验证：${deliveryCheck.errors.join("；")}`);
    }
    const currentApproval = await requirePreviewApproval(projectDir);
    if (
      currentApproval.approvalId !== previewApproval.approvalId ||
      currentApproval.contractSha256 !== previewApproval.contractSha256
    ) {
      throw new Error("预览批准记录在渲染期间发生变化，拒绝回写");
    }
    const assertSafeOutput = async () => {
      await frozen.assertSourceUnchanged();
      await assertDirectoryIdentity(rendersDir, rendersIdentity);
    };
    await copyArtifactAtomically(temporaryOutput, output, assertSafeOutput);
    console.log(`主产物：${output}`);
  } catch (error) {
    console.error(`渲染失败：${error.message}`);
    process.exitCode = 1;
  } finally {
    await frozen?.cleanup().catch(() => {});
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  await main();
}

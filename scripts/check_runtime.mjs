#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import {
  BROWSER_GUARD_PATH,
  NO_TRACKING_ENV,
  resolveRealBrowserPath,
} from "./runtime_guard.mjs";

const REQUIRED_HYPERFRAMES_VERSION = "0.7.83";

function command(name, args = ["--version"]) {
  const result = spawnSync(name, args, {
    encoding: "utf8",
    timeout: 5000,
    env: NO_TRACKING_ENV,
  });
  return {
    available: !result.error && result.status === 0,
    version: (result.stdout || result.stderr || "").trim().split("\n")[0] || null,
  };
}

function inspectHyperframesCli(name) {
  // HyperFrames 0.7.83 only suppresses both background version/skill-manifest
  // requests when the root command includes --json.
  const result = command(name, ["--version", "--json"]);
  const detectedVersion = result.version?.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1] ?? null;
  return {
    command: name,
    ...result,
    detected_version: detectedVersion,
    required_version: REQUIRED_HYPERFRAMES_VERSION,
    exact_version: result.available && detectedVersion === REQUIRED_HYPERFRAMES_VERSION,
  };
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
const realBrowserPath = await resolveRealBrowserPath().catch(() => null);
const browser = realBrowserPath
  ? { name: realBrowserPath, ...command(realBrowserPath) }
  : { name: null, available: false, version: null };
const browserGuardAvailable = await access(BROWSER_GUARD_PATH, constants.R_OK)
  .then(() => true)
  .catch(() => false);
const overridePath = process.env.HYPERFRAMES_CLI || null;
const overrideCli = overridePath
  ? {
      path: overridePath,
      exists: existsSync(overridePath),
      ...inspectHyperframesCli(overridePath),
    }
  : null;
const installedCli = overridePath ? null : inspectHyperframesCli("hyperframes");
const selectedCli = overrideCli ?? installedCli;
const fontCandidates = [
  "/System/Library/Fonts/STHeiti Medium.ttc",
  "/System/Library/Fonts/PingFang.ttc",
  "/Library/Fonts/Microsoft Yahei.ttf",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
];
const fontPath = fontCandidates.find(existsSync) ?? null;
const report = {
  node: { available: true, version: process.versions.node, meets_requirement: nodeMajor >= 22 },
  ffmpeg: command("ffmpeg", ["-version"]),
  ffprobe: command("ffprobe", ["-version"]),
  browser,
  browser_guard: {
    available: browserGuardAvailable,
    path: BROWSER_GUARD_PATH,
    private_executable_copy_created_per_run: browserGuardAvailable,
    pins_hyperframes_browser_path: browserGuardAvailable && browser.available,
  },
  hyperframes_cli: installedCli,
  hyperframes_cli_override: overrideCli,
  selected_hyperframes_cli: selectedCli,
  chinese_font: { available: Boolean(fontPath), path: fontPath },
  automatic_network_fallback: false,
  telemetry_disabled_for_hyperframes: true,
  root_cli_background_requests_suppressed_by_json: true,
  npm_self_install_disabled_by_wrapper: true,
  browser_auto_download_prevented_by_explicit_guard_path:
    browserGuardAvailable && browser.available,
  hard_network_boundary: "浏览器启动参数 + CSP；生产环境仍需由 OS/容器 egress 策略兜底",
};
const hasExactCli = Boolean(selectedCli?.exact_version);
const canPreview =
  report.node.meets_requirement &&
  hasExactCli &&
  browser.available &&
  browserGuardAvailable &&
  report.chinese_font.available;
const canRender = canPreview && report.ffmpeg.available && report.ffprobe.available;
report.mode = canRender ? "full-render" : canPreview ? "preview-check" : "author-only";
report.capabilities = {
  "author-only": report.node.meets_requirement,
  "preview-check": canPreview,
  "full-render": canRender,
};
report.missing = [];
if (!report.node.meets_requirement) report.missing.push("Node.js 22+");
if (!selectedCli?.available) {
  report.missing.push("预装 HyperFrames CLI 或 HYPERFRAMES_CLI");
} else if (!hasExactCli) {
  report.missing.push(`HyperFrames CLI 必须严格为 ${REQUIRED_HYPERFRAMES_VERSION}`);
}
if (!report.ffmpeg.available) report.missing.push("ffmpeg");
if (!report.ffprobe.available) report.missing.push("ffprobe");
if (!browser.available) report.missing.push("Chrome/Chromium");
if (!browserGuardAvailable) report.missing.push("可读取的本地浏览器离线守卫");
if (!report.chinese_font.available) report.missing.push("已授权中文字体");

console.log(JSON.stringify(report, null, 2));
console.log(`\n运行档位：${report.mode}`);
if (report.missing.length) console.log(`缺少：${report.missing.join("、")}`);
process.exitCode = 0;

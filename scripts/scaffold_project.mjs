#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeJpegBuffer,
  inspectImageBuffer,
  loadBrief,
  validateBrief,
} from "./validate_brief.mjs";
import { validateDeliveryBriefContract } from "./delivery_brief_contract.mjs";

const DIMS = {
  "1:1": [1080, 1080],
  "9:16": [1080, 1920],
  "16:9": [1920, 1080],
};
const THEMES = {
  warm: { bg: "#F6EBDD", ink: "#36261F", accent: "#E67864", soft: "#F3C7B7" },
  playful: { bg: "#FFF36D", ink: "#171717", accent: "#FF5A7A", soft: "#69D7FF" },
  clean: { bg: "#F4F7FA", ink: "#132238", accent: "#3977F6", soft: "#B9D0FF" },
  energetic: { bg: "#0B1020", ink: "#FFFFFF", accent: "#6CFFB8", soft: "#824CFF" },
};
export const COMPOSITION_CSP =
  "default-src 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; script-src-attr 'none'; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function escapeHtml(value = "") {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function openExclusive(filePath) {
  return open(
    filePath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW || 0),
    0o600,
  );
}

async function writeHandle(handle, data) {
  await handle.writeFile(data);
  await handle.sync();
}

async function matchesDirectoryIdentity(directory, expected) {
  try {
    const current = await lstat(directory);
    return (
      current.isDirectory() &&
      !current.isSymbolicLink() &&
      current.dev === expected.dev &&
      current.ino === expected.ino &&
      (await realpath(directory)) === expected.realPath
    );
  } catch {
    return false;
  }
}

async function rollbackCreatedProject(state) {
  if (!state) return { removed: false, reason: "没有本次创建的工程目录记录" };
  const parentMatches = await matchesDirectoryIdentity(state.trustedRoot, state.parent);
  if (!parentMatches) return { removed: false, reason: "工程父目录身份已变化" };
  const projectMatches = await matchesDirectoryIdentity(state.projectDir, state.project);
  if (!projectMatches) return { removed: false, reason: "工程目录身份已变化" };
  // Recheck both identities immediately before the only recursive removal.
  // rollbackState is created only after this process wins the exclusive mkdir,
  // so a pre-existing project can never reach this branch.
  if (
    !(await matchesDirectoryIdentity(state.trustedRoot, state.parent)) ||
    !(await matchesDirectoryIdentity(state.projectDir, state.project))
  ) {
    return { removed: false, reason: "回滚前目录身份复核失败" };
  }
  await rm(state.projectDir, { recursive: true, force: false, maxRetries: 0 });
  return { removed: true, reason: "" };
}

function stripJpegMetadata(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error("JPEG 魔数无效");
  const chunks = [buffer.subarray(0, 2)];
  let orientation = null;
  let adobeTransform = null;
  let sawScan = false;
  let sawEnd = false;
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff || offset + 1 >= buffer.length) {
      throw new Error(`JPEG marker 边界无效（offset=${offset}）`);
    }
    const markerStart = offset;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) throw new Error("JPEG marker 不完整");
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0x00) throw new Error("JPEG 扫描外出现转义 marker");
    if (marker === 0xd9) {
      chunks.push(buffer.subarray(markerStart, offset));
      sawEnd = true;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      chunks.push(buffer.subarray(markerStart, offset));
      continue;
    }
    if (offset + 2 > buffer.length) throw new Error("JPEG 段长度缺失");
    const length = buffer.readUInt16BE(offset);
    const segmentEnd = offset + length;
    if (length < 2 || segmentEnd > buffer.length) throw new Error("JPEG 段长度无效");
    if (marker === 0xda) {
      sawScan = true;
      chunks.push(buffer.subarray(markerStart, segmentEnd));
      offset = segmentEnd;
      const scanStart = offset;
      let foundNextMarker = false;
      while (offset < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const nextMarkerStart = offset;
        let codeOffset = offset + 1;
        while (codeOffset < buffer.length && buffer[codeOffset] === 0xff) codeOffset += 1;
        if (codeOffset >= buffer.length) throw new Error("JPEG 扫描数据末尾 marker 不完整");
        const code = buffer[codeOffset];
        if (code === 0x00 || (code >= 0xd0 && code <= 0xd7)) {
          offset = codeOffset + 1;
          continue;
        }
        chunks.push(buffer.subarray(scanStart, nextMarkerStart));
        offset = nextMarkerStart;
        foundNextMarker = true;
        break;
      }
      if (!foundNextMarker) throw new Error("JPEG 扫描数据缺少结束 marker");
      continue;
    }
    if (marker === 0xe1 && orientation == null) {
      const payload = buffer.subarray(offset + 2, segmentEnd);
      orientation = readExifOrientation(payload);
    }
    if (marker === 0xee && adobeTransform == null) {
      const payload = buffer.subarray(offset + 2, segmentEnd);
      if (
        payload.length === 12 &&
        payload.toString("ascii", 0, 5) === "Adobe" &&
        payload[11] <= 2
      ) {
        adobeTransform = payload[11];
      }
    }
    // Every APP0—APP15 segment can carry arbitrary private bytes. Preserve only
    // a canonical numeric Adobe APP14 color-transform segment; reconstruct the
    // orientation later from a minimal APP1 rather than copying source EXIF.
    const isSensitiveMetadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!isSensitiveMetadata) chunks.push(buffer.subarray(markerStart, segmentEnd));
    offset = segmentEnd;
  }
  if (!sawScan || !sawEnd) throw new Error("JPEG 缺少完整 SOS/EOI");
  const safeHeaderSegments = [];
  if (orientation && orientation !== 1) safeHeaderSegments.push(makeOrientationSegment(orientation));
  if (adobeTransform != null) safeHeaderSegments.push(makeAdobeSegment(adobeTransform));
  if (safeHeaderSegments.length) chunks.splice(1, 0, ...safeHeaderSegments);
  return Buffer.concat(chunks);
}

function readExifOrientation(payload) {
  if (payload.length < 20 || payload.toString("ascii", 0, 6) !== "Exif\u0000\u0000") return null;
  const tiff = 6;
  const byteOrder = payload.toString("ascii", tiff, tiff + 2);
  const little = byteOrder === "II";
  if (!little && byteOrder !== "MM") return null;
  const read16 = (offset) => (little ? payload.readUInt16LE(offset) : payload.readUInt16BE(offset));
  const read32 = (offset) => (little ? payload.readUInt32LE(offset) : payload.readUInt32BE(offset));
  if (read16(tiff + 2) !== 42) return null;
  const ifdOffset = tiff + read32(tiff + 4);
  if (ifdOffset + 2 > payload.length) return null;
  const count = read16(ifdOffset);
  for (let index = 0; index < count; index += 1) {
    const entry = ifdOffset + 2 + index * 12;
    if (entry + 12 > payload.length) return null;
    const tag = read16(entry);
    const type = read16(entry + 2);
    const itemCount = read32(entry + 4);
    if (tag === 0x0112 && type === 3 && itemCount === 1) {
      const value = read16(entry + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

function makeOrientationSegment(orientation) {
  const payload = Buffer.alloc(32);
  payload.write("Exif\u0000\u0000", 0, "binary");
  payload.write("II", 6, "ascii");
  payload.writeUInt16LE(42, 8);
  payload.writeUInt32LE(8, 10);
  payload.writeUInt16LE(1, 14);
  payload.writeUInt16LE(0x0112, 16);
  payload.writeUInt16LE(3, 18);
  payload.writeUInt32LE(1, 20);
  payload.writeUInt16LE(orientation, 24);
  payload.writeUInt32LE(0, 28);
  const segment = Buffer.alloc(payload.length + 4);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return segment;
}

function makeAdobeSegment(transform) {
  const payload = Buffer.alloc(12);
  payload.write("Adobe", 0, "ascii");
  payload.writeUInt16BE(100, 5);
  payload[11] = transform;
  const segment = Buffer.alloc(payload.length + 4);
  segment[0] = 0xff;
  segment[1] = 0xee;
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return segment;
}

function stripPngMetadata(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error("PNG 魔数无效");
  const chunks = [buffer.subarray(0, 8)];
  // Preserve only pixel-decoding chunks plus palette transparency. Color hints
  // such as gAMA/cHRM/sRGB are not needed to decode the pixels and can still
  // carry covert bytes, so they are removed with every other ancillary chunk.
  const allowed = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS"]);
  const critical = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
  let sawIend = false;
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) throw new Error("PNG chunk 长度无效");
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (["acTL", "fcTL", "fdAT"].includes(type)) throw new Error("不接受 APNG 动画 chunk");
    if (/^[A-Z]/.test(type) && !critical.has(type)) {
      throw new Error(`不接受未知 PNG 关键 chunk：${type}`);
    }
    if (allowed.has(type)) chunks.push(buffer.subarray(offset, end));
    offset = end;
    if (type === "IEND") {
      sawIend = true;
      break;
    }
  }
  if (!sawIend || offset !== buffer.length) throw new Error("PNG 缺少 IEND 或含尾随数据");
  const sanitized = Buffer.concat(chunks);
  const metadata = inspectImageBuffer(sanitized);
  if (!metadata?.valid || metadata.type !== "png") {
    throw new Error(`PNG 清洗后不可解码：${metadata?.validationErrors?.join("、") || "结构无效"}`);
  }
  return sanitized;
}

export function sanitizeImage(buffer, extension) {
  if (extension === ".png") return stripPngMetadata(buffer);
  return stripJpegMetadata(buffer);
}

function mediaMarkup(brief, assets) {
  if (!assets.length) return `<div class="symbol">${brief.function === "sticker" ? "✓" : "✦"}</div>`;
  return assets
    .map(
      (asset, index) =>
        `<img class="media media-${index + 1}" src="${escapeHtml(asset.project_path)}" alt="${escapeHtml(asset.alt)}" />`,
    )
    .join("\n");
}

function frameScript(brief, assetCount) {
  const duration = Number(brief.duration_seconds);
  const photoWindows =
    brief.function === "photo-story"
      ? Array.from({ length: assetCount }, (_, i) => ({
          start: (duration * i) / assetCount,
          end: (duration * (i + 1)) / assetCount,
          blend: Math.min(0.3, (duration / assetCount) * 0.12),
        }))
      : [];
  return `
const duration = ${duration};
const loop = ${brief.loop ? "true" : "false"};
let current = 0;
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const easeOut = (x) => 1 - Math.pow(1 - clamp(x), 3);
const easeInOut = (x) => x < .5 ? 4*x*x*x : 1 - Math.pow(-2*x + 2, 3)/2;
const title = document.querySelector(".title");
const subtitle = document.querySelector(".subtitle");
const signature = document.querySelector(".signature");
const hero = document.querySelector(".hero");
const media = [...document.querySelectorAll(".media")];
const windows = ${JSON.stringify(photoWindows)};

function applyFrame(seconds) {
  current = clamp(Number(seconds) || 0, 0, duration);
  const p = current / duration;
  const enter = easeOut(clamp(current / Math.min(1.1, duration * .22)));
  const exit = ${brief.loop ? "1 - easeInOut(clamp((current - duration * .78) / (duration * .22)))" : "1"};
  title.style.opacity = String(enter * exit);
  title.style.transform = \`translateY(\${(1-enter)*70}px) scale(\${.86 + enter*.14})\`;
  subtitle.style.opacity = String(clamp((current - .45) / .65) * exit);
  signature.style.opacity = String(clamp((current - .8) / .7) * exit);
  if (hero) {
    const pulse = Math.sin(p * Math.PI * 2);
    const settle = ${brief.function === "card" ? "1 - clamp((current - (duration - 1.5)) / .4)" : "1"};
    hero.style.transform = \`translateY(\${(1-enter)*90}px) rotate(\${pulse*2.5*settle}deg) scale(\${.88 + enter*.12 + Math.max(0,pulse)*.025*settle})\`;
    hero.style.opacity = String(enter * exit);
  }
  if (windows.length) {
    media.forEach((el, i) => {
      const w = windows[i];
      const local = clamp((current - w.start) / (w.end - w.start));
      const fadeIn = i === 0 ? 1 : easeInOut(clamp((current - (w.start - w.blend)) / (2*w.blend)));
      el.style.opacity = String(fadeIn);
      el.style.transform = \`scale(\${1.04 + local*.035}) translateY(\${(local-.5)*-18}px)\`;
      el.style.zIndex = String(i + 1);
    });
  }
}
function play() {
  // HyperFrames owns playback and calls seek deterministically. Wall-clock
  // requestAnimationFrame/setInterval loops are intentionally forbidden.
  return current;
}
function pause() {
  return current;
}
applyFrame(0);
window.__timelines = window.__timelines || {};
window.__timelines["${brief.project_name}"] = {
  duration: () => duration,
  time: () => current,
  seek: (t) => applyFrame(t),
  play,
  pause,
  timeScale: () => 1
};`;
}

function compositionHtml(brief, assets) {
  const [width, height] = DIMS[brief.aspect_ratio];
  const theme = THEMES[brief.style];
  const imageFit = brief.function === "photo-story" ? "cover" : "cover";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${COMPOSITION_CSP}" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(brief.message.title || brief.project_name)}</title>
  <style>
    @font-face {
      font-family: "Yuanbao CJK";
      src: local("Heiti SC Medium"), local("STHeitiSC-Medium"), local("Microsoft YaHei"), local("Noto Sans CJK SC"), local("Source Han Sans SC");
      font-style: normal;
      font-weight: 400;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: ${theme.bg}; }
    body { font-family: "Yuanbao CJK", sans-serif; }
    #stage { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; color: ${theme.ink}; background:
      radial-gradient(circle at 18% 16%, ${theme.soft}88 0 8%, transparent 34%),
      radial-gradient(circle at 84% 78%, ${theme.accent}66 0 10%, transparent 36%),
      ${theme.bg}; }
    .clip, .scene { position: absolute; inset: 0; }
    .media { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: ${imageFit}; }
    .photo-story .media { opacity: 0; }
    .photo-story::after { content: ""; position: absolute; inset: 0; z-index: 20; background: linear-gradient(180deg,rgba(0,0,0,.08),transparent 42%,rgba(0,0,0,.54)); }
    .content { position: absolute; z-index: 30; inset: 0; padding: ${brief.aspect_ratio === "9:16" ? "210px 86px 230px" : "90px 72px"}; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; }
    .photo-story .content { justify-content: flex-end; color: #fff; text-shadow: 0 3px 24px rgba(0,0,0,.45); }
    .hero { width: ${brief.aspect_ratio === "9:16" ? "760px" : "620px"}; height: ${brief.aspect_ratio === "9:16" ? "760px" : "620px"}; max-height: 48%; border-radius: 38px; overflow: hidden; box-shadow: 0 28px 80px rgba(0,0,0,.22); margin-bottom: 54px; background: ${theme.soft}; }
    .hero .media { position: relative; object-fit: cover; }
    .symbol { display: grid; place-items: center; width: 100%; height: 100%; font-size: 280px; color: ${theme.ink}; }
    .title { max-width: 94%; font-size: ${brief.aspect_ratio === "9:16" ? "104px" : "88px"}; line-height: 1.08; font-weight: 900; letter-spacing: -.03em; text-wrap: balance; }
    .subtitle { max-width: 88%; margin-top: 28px; font-size: ${brief.aspect_ratio === "9:16" ? "44px" : "38px"}; line-height: 1.35; font-weight: 600; }
    .signature { margin-top: 34px; font-size: 32px; opacity: .8; }
    .sticker .content { justify-content: center; }
    .sticker .title { font-size: 118px; color: ${theme.ink}; text-shadow: 0 7px 0 ${theme.bg}; }
    .decor { position: absolute; z-index: 25; width: 180px; height: 180px; border: 18px solid ${theme.accent}; border-radius: 50%; right: 6%; top: 8%; opacity: .5; }
  </style>
</head>
<body>
  <main id="stage" class="${brief.function}" data-composition-id="${brief.project_name}" data-start="0" data-duration="${brief.duration_seconds}" data-fps="30" data-width="${width}" data-height="${height}">
    <section id="scene-main" class="scene clip" data-start="0" data-duration="${brief.duration_seconds}" data-track-index="0">
      ${brief.function === "photo-story" ? mediaMarkup(brief, assets) : ""}
      <div class="decor"></div>
      <div class="content">
        ${brief.function !== "photo-story" ? `<div class="hero">${mediaMarkup(brief, assets)}</div>` : ""}
        <div class="title">${escapeHtml(brief.message.title)}</div>
        <div class="subtitle">${escapeHtml(brief.message.subtitle || "")}</div>
        <div class="signature">${escapeHtml(brief.message.signature || "")}</div>
      </div>
    </section>
  </main>
  <script>${frameScript(brief, assets.length)}</script>
</body>
</html>
`;
}

function briefMarkdown(brief, assets) {
  const facts = brief.facts_to_preserve.length ? brief.facts_to_preserve.map((item) => `- ${item}`).join("\n") : "- 无";
  const privacy = brief.privacy_review.actions.length
    ? brief.privacy_review.actions.map((item) => `- ${item}（输入素材进入本 Skill 前已完成）`).join("\n")
    : "- 无图像遮挡动作";
  return `# ${brief.message.title || brief.project_name}

## 交付约定

- 功能：${brief.function}
- 用途：${brief.use_case}
- 比例：${brief.aspect_ratio}
- 时长：${brief.duration_seconds}秒
- 主格式：${brief.output_format}
- 循环：${brief.loop ? "是" : "否"}
- 风格：${brief.style}

## 文案

- 标题：${brief.message.title}
- 副标题：${brief.message.subtitle || "无"}
- 署名：${brief.message.signature || "无"}

## 素材

${assets.length ? assets.map((item) => `- ${item.project_path}（${item.alt || "用户提供图片"}）`).join("\n") : "- 纯文字/图形，不使用外部素材"}

## 必须保留的事实

${facts}

## 隐私处理

状态：${brief.privacy_review.status}

${privacy}

工程素材副本会把 PNG 收窄到像素、调色板和透明度必需块；JPEG 会移除全部自由 APP/COM 段，只重建方向和规范色彩转换信息。本 Skill 不会自动遮挡图像内容。
`;
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const [input, outputRoot] = argv;
  if (!input || !outputRoot) {
    console.error(
      "用法：node scripts/scaffold_project.mjs <source-brief.json> <工程父目录>（自动创建 <父目录>/<project_name>）",
    );
    process.exit(2);
  }
  const openedHandles = [];
  let rollbackState = null;
  let generationFailed = false;
  try {
    const brief = await loadBrief(input);
    // Hold the exact bytes read from each authorized O_NOFOLLOW handle. The
    // scaffold never re-opens user-provided paths after validation, so a path
    // swap cannot change the bytes copied into the project.
    const validatedMedia = [];
    const result = await validateBrief(brief, {
      onValidatedMedia: async ({ index, item, extension, buffer }) => {
        const sanitizedBuffer = sanitizeImage(buffer, extension);
        if (extension !== ".png") {
          const decoded = decodeJpegBuffer(sanitizedBuffer);
          if (!decoded.ok) {
            throw new Error(`素材 ${item.source_id} 清洗后验证失败：${decoded.error}`);
          }
        }
        validatedMedia[index] = { item, extension, sanitizedBuffer };
      },
    });
    if (result.errors.length) throw new Error(`brief 未通过校验：${result.errors.join("；")}`);
    if (validatedMedia.filter(Boolean).length !== brief.media.length) {
      throw new Error("素材快照数量与 brief 不一致，已停止");
    }
    const requestedRoot = path.resolve(outputRoot);
    const rootLinkInfo = await lstat(requestedRoot);
    if (rootLinkInfo.isSymbolicLink()) throw new Error("工程父目录不得是符号链接");
    const rootInfo = await stat(requestedRoot);
    if (!rootInfo.isDirectory()) throw new Error("工程父目录不是目录");
    const trustedRoot = await realpath(requestedRoot);
    const trustedRootIdentity = await lstat(trustedRoot);
    if (!trustedRootIdentity.isDirectory() || trustedRootIdentity.isSymbolicLink()) {
      throw new Error("工程父目录真实路径不是普通目录");
    }
    const assertOutputRootIdentity = async () => {
      const current = await lstat(trustedRoot);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== trustedRootIdentity.dev ||
        current.ino !== trustedRootIdentity.ino ||
        (await realpath(trustedRoot)) !== trustedRoot
      ) {
        throw new Error("工程父目录在生成期间被替换，已停止");
      }
    };
    const projectDir = path.join(trustedRoot, brief.project_name);
    const relativeProject = path.relative(trustedRoot, projectDir);
    if (
      !relativeProject ||
      relativeProject === ".." ||
      relativeProject.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeProject)
    ) {
      throw new Error("project_name 未能形成工程父目录内的安全子目录");
    }
    await assertOutputRootIdentity();
    try {
      await mkdir(projectDir, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new Error(`输出工程路径已存在（包括空目录或符号链接）：${projectDir}；请更换 project_name`);
      }
      throw error;
    }
    await assertOutputRootIdentity();
    const createdProject = await lstat(projectDir);
    const projectRealPath = await realpath(projectDir);
    if (!createdProject.isDirectory() || createdProject.isSymbolicLink() || projectRealPath !== projectDir) {
      throw new Error("新建工程目录未通过真实路径检查");
    }
    rollbackState = {
      trustedRoot,
      projectDir,
      parent: {
        dev: trustedRootIdentity.dev,
        ino: trustedRootIdentity.ino,
        realPath: trustedRoot,
      },
      project: {
        dev: createdProject.dev,
        ino: createdProject.ino,
        realPath: projectRealPath,
      },
    };
    const directoryIdentities = new Map([[projectDir, createdProject]]);
    const assertDirectoryIdentity = async (directory) => {
      const expected = directoryIdentities.get(directory);
      if (!expected) throw new Error(`缺少目录身份记录：${directory}`);
      const current = await lstat(projectDir);
      const currentDirectory = directory === projectDir ? current : await lstat(directory);
      const currentRealPath = await realpath(directory);
      if (
        !currentDirectory.isDirectory() ||
        currentDirectory.isSymbolicLink() ||
        currentDirectory.dev !== expected.dev ||
        currentDirectory.ino !== expected.ino ||
        currentRealPath !== directory
      ) {
        throw new Error(`工程目录在写入期间被替换，已停止：${directory}`);
      }
    };
    const assertProjectIdentity = async () => {
      await assertOutputRootIdentity();
      await assertDirectoryIdentity(projectDir);
      for (const directory of [...directoryIdentities.keys()].filter((item) => item !== projectDir)) {
        await assertDirectoryIdentity(directory);
      }
    };
    for (const dir of ["assets", "renders", "snapshots"]) {
      const directory = path.join(projectDir, dir);
      await mkdir(directory, { recursive: false, mode: 0o700 });
      const identity = await lstat(directory);
      if (!identity.isDirectory() || identity.isSymbolicLink() || (await realpath(directory)) !== directory) {
        throw new Error(`新建子目录未通过真实路径检查：${dir}`);
      }
      directoryIdentities.set(directory, identity);
    }
    await assertProjectIdentity();

    const assets = [];
    for (const [index, snapshot] of validatedMedia.entries()) {
      await assertProjectIdentity();
      const { item, extension, sanitizedBuffer } = snapshot;
      const name = `media-${String(index + 1).padStart(2, "0")}${extension}`;
      const target = path.join(projectDir, "assets", name);
      const targetHandle = await openExclusive(target);
      openedHandles.push(targetHandle);
      await assertProjectIdentity();
      await writeHandle(targetHandle, sanitizedBuffer);
      assets.push({
        source_id: item.source_id,
        project_path: `assets/${name}`,
        alt: item.alt || "用户提供图片",
        sha256: sha256(sanitizedBuffer),
        metadata_sanitized: true,
      });
    }
    const [width, height] = DIMS[brief.aspect_ratio];
    const plan = {
      version: 1,
      function: brief.function,
      duration_seconds: brief.duration_seconds,
      fps: 30,
      width,
      height,
      scenes:
        brief.function === "photo-story"
          ? assets.map((asset, index) => ({
              id: `photo-${index + 1}`,
              start: (brief.duration_seconds * index) / assets.length,
              duration: brief.duration_seconds / assets.length,
              asset: asset.project_path,
              motion: "gentle-ken-burns",
              transition_overlap_seconds: Math.min(0.3, (brief.duration_seconds / assets.length) * 0.12),
            }))
          : [{ id: "main", start: 0, duration: brief.duration_seconds, motion: brief.function === "sticker" ? "loop-pulse" : "title-rise" }],
    };
    const hyperframes = {
      version: 1,
      name: brief.project_name,
      composition: "index.html",
      width,
      height,
      fps: 30,
      duration: brief.duration_seconds,
      renderer: "hyperframes@0.7.83",
      source_skill: "create-animation",
    };
    const deliveryBrief = {
      schema_kind: "delivery",
      schema_version: 2,
      project_name: brief.project_name,
      function: brief.function,
      message: brief.message,
      use_case: brief.use_case,
      duration_seconds: brief.duration_seconds,
      aspect_ratio: brief.aspect_ratio,
      output_format: brief.output_format,
      style: brief.style,
      loop: brief.loop,
      facts_to_preserve: brief.facts_to_preserve,
      privacy_review: {
        status: brief.privacy_review.status,
        actions: brief.privacy_review.actions,
        image_metadata: "sensitive-stripped-orientation-preserved",
      },
      media: assets.map(({ source_id, project_path, alt }) => ({ source_id, project_path, alt })),
    };
    const deliveryContractErrors = validateDeliveryBriefContract(deliveryBrief, {
      label: "脚手架生成的 delivery brief",
    });
    if (deliveryContractErrors.length) {
      throw new Error(`脚手架内部 delivery brief 契约失败：${deliveryContractErrors.join("；")}`);
    }
    const generatedFiles = new Map([
      ["delivery-brief.json", `${JSON.stringify(deliveryBrief, null, 2)}\n`],
      ["BRIEF.md", briefMarkdown(brief, assets)],
      ["animation-plan.json", `${JSON.stringify(plan, null, 2)}\n`],
      ["asset-manifest.json", `${JSON.stringify(assets, null, 2)}\n`],
      ["hyperframes.json", `${JSON.stringify(hyperframes, null, 2)}\n`],
      ["index.html", compositionHtml(brief, assets)],
    ]);
    for (const [name, content] of generatedFiles) {
      await assertProjectIdentity();
      const handle = await openExclusive(path.join(projectDir, name));
      openedHandles.push(handle);
      await assertProjectIdentity();
      await writeHandle(handle, content);
      await options.onCheckpoint?.("generated-file-written", { name, projectDir });
    }
    await assertProjectIdentity();
    console.log(`已生成工程：${projectDir}`);
    console.log(`入口：${path.join(projectDir, "index.html")}`);
  } catch (error) {
    generationFailed = true;
    console.error(`生成失败：${error.message}`);
    process.exitCode = 1;
  } finally {
    await Promise.all(openedHandles.map((handle) => handle.close().catch(() => {})));
    if (generationFailed && rollbackState) {
      try {
        const rollback = await rollbackCreatedProject(rollbackState);
        if (!rollback.removed) console.error(`安全回滚跳过：${rollback.reason}`);
      } catch (error) {
        console.error(`安全回滚失败：${error.message}`);
      }
    }
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  await main();
}

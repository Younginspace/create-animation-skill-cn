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
  warm: { bg: "#F6EBDD", ink: "#36261F", accent: "#D45C49", soft: "#F3C7B7" },
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
  if (!assets.length) return "";
  return assets
    .map(
      (asset, index) =>
        `<img class="media media-${index + 1}" src="${escapeHtml(asset.project_path)}" alt="${escapeHtml(asset.alt)}" />`,
    )
    .join("\n");
}

function cardVariant(brief) {
  const text = [
    brief.message.title,
    brief.message.subtitle,
    brief.use_case,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/生日|寿星|周岁|新一岁|birthday/.test(text)) return "birthday";
  if (/邀请|聚餐|婚礼|婚宴|乔迁|宴会|派对|见面|地点|地址|入席|invite/.test(text)) {
    return "invitation";
  }
  if (/加油|考试|高考|中考|上岸|冲刺|必胜|逢考必过|go for it/.test(text)) {
    return "encouragement";
  }
  return "announcement";
}

function cardContext(brief, variant) {
  const text = [brief.message.title, brief.message.subtitle, brief.use_case]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (variant === "birthday") {
    if (/妈妈|母亲|老妈|mom|mother/.test(text)) return "mom";
    if (/爸爸|父亲|老爸|dad|father/.test(text)) return "dad";
    if (/宝宝|宝贝|孩子|女儿|儿子|child|kid/.test(text)) return "child";
  }
  if (variant === "invitation") {
    if (/聚餐|家宴|团圆|吃饭|晚餐|午餐|饭局|dinner|lunch/.test(text)) return "dinner";
    if (/婚礼|婚宴|结婚|wedding/.test(text)) return "wedding";
    if (/派对|party/.test(text)) return "party";
  }
  return "general";
}

function cardKicker(variant, context) {
  if (variant === "birthday" && context === "mom") return "WITH LOVE · FOR MOM";
  if (variant === "birthday" && context === "dad") return "WITH LOVE · FOR DAD";
  if (variant === "birthday" && context === "child") return "OUR LITTLE STAR";
  if (variant === "invitation" && context === "dinner") return "FAMILY TABLE";
  if (variant === "invitation" && context === "wedding") return "SAVE THE DATE";
  if (variant === "invitation" && context === "party") return "LET'S CELEBRATE";
  return {
    birthday: "HAPPY DAY",
    invitation: "INVITATION",
    encouragement: "GO FOR IT",
    announcement: "JUST FOR YOU",
  }[variant];
}

function dateToken(brief) {
  const text = [brief.message.title, brief.message.subtitle].filter(Boolean).join(" ");
  const match = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!match) return "SAVE · THE · DATE";
  return `${String(match[1]).padStart(2, "0")} · ${String(match[2]).padStart(2, "0")}`;
}

function cardDecorationMarkup(brief, variant, context) {
  if (variant === "birthday") {
    return `
      <div class="birthday-word" aria-hidden="true" data-layout-allow-occlusion>${context === "mom" ? "MOM" : context === "dad" ? "DAD" : "HBD"}</div>
      <div class="birthday-confetti" aria-hidden="true">
        ${Array.from({ length: 16 }, (_, index) => `<i class="confetti confetti-${index + 1} decor-piece"></i>`).join("")}
      </div>
      <div class="birthday-cake decor-piece" aria-hidden="true"><i class="cake-icing"></i><i class="cake-shadow"></i></div>
      <div class="birthday-candles" aria-hidden="true">
        <i class="candle"><b class="flame"></b></i>
        <i class="candle"><b class="flame"></b></i>
        <i class="candle"><b class="flame"></b></i>
      </div>
      <div class="birthday-ribbon" aria-hidden="true">LOVE · JOY · HEALTH · ALWAYS</div>`;
  }
  if (variant === "invitation") {
    if (context === "dinner") {
      return `
        <div class="dinner-sun" aria-hidden="true"></div>
        <div class="dinner-plate decor-piece" aria-hidden="true"><i></i><b></b></div>
        <div class="dinner-chopsticks" aria-hidden="true"><i></i><i></i></div>
        <div class="dinner-steam" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="invite-date">${escapeHtml(dateToken(brief))}</div>
        <div class="invite-seal decor-piece" aria-hidden="true">聚</div>`;
    }
    return `
      <div class="invite-frame decor-piece" aria-hidden="true"></div>
      <div class="invite-rail decor-piece" aria-hidden="true"></div>
      <div class="invite-seal decor-piece" aria-hidden="true">邀</div>`;
  }
  if (variant === "encouragement") {
    return `
      <div class="speed-lines" aria-hidden="true">
        ${Array.from({ length: 7 }, (_, index) => `<i class="speed-line speed-line-${index + 1} decor-piece" data-layout-allow-overflow></i>`).join("")}
      </div>
      <div class="progress-track" aria-hidden="true"><i class="progress-fill"></i></div>
      <div class="encourage-mark decor-piece" aria-hidden="true">✓</div>`;
  }
  return `
    <div class="announcement-orbit decor-piece" aria-hidden="true"></div>
    <div class="announcement-star decor-piece" aria-hidden="true">✦</div>
    <div class="announcement-block decor-piece" aria-hidden="true"></div>`;
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
const content = document.querySelector(".content");
const stickerMedia = document.querySelector(".sticker-media");
const cardMedia = document.querySelector(".card-media");
const decorations = [...document.querySelectorAll(".decor-piece")];
const flames = [...document.querySelectorAll(".flame")];
const progressFill = document.querySelector(".progress-fill");
const media = [...document.querySelectorAll(".media")];
const windows = ${JSON.stringify(photoWindows)};

function applyFrame(seconds) {
  current = clamp(Number(seconds) || 0, 0, duration);
  const p = current / duration;
  const enter = easeOut(clamp(current / Math.min(1.1, duration * .22)));
  const exit = ${brief.loop ? "1 - easeInOut(clamp((current - duration * .78) / (duration * .22)))" : "1"};
  const settle = ${brief.loop ? "exit" : "1"};
  const pulse = Math.sin(p * Math.PI * 2);
  title.style.opacity = String(enter * exit);
  title.style.transform = \`translateY(\${(1-enter)*76}px) scale(\${.84 + enter*.16 + Math.max(0,pulse)*.012*settle})\`;
  subtitle.style.opacity = String(clamp((current - .45) / .65) * exit);
  signature.style.opacity = String(clamp((current - .8) / .7) * exit);
  if (content) {
    content.style.transform = \`translateY(\${(1-enter)*24}px)\`;
  }
  if (stickerMedia) {
    stickerMedia.style.opacity = String(enter * exit);
    stickerMedia.style.transform = \`scale(\${1.015 + Math.max(0,pulse)*.018}) translateY(\${pulse*-5}px)\`;
  }
  if (cardMedia) {
    cardMedia.style.opacity = String(enter);
    cardMedia.style.transform = \`scale(\${1.06 - enter*.035 + p*.018*settle}) translateY(\${p*-10*settle}px)\`;
  }
  decorations.forEach((el, i) => {
    const phase = p * Math.PI * 2 + i * .71;
    el.style.opacity = String(clamp((current - .18 - i*.025) / .55) * settle);
    el.style.transform = \`translateY(\${(1-enter)*(26 + (i%3)*12) + Math.sin(phase)*5*settle}px) rotate(\${Math.sin(phase)*4*settle}deg)\`;
  });
  flames.forEach((el, i) => {
    const flicker = 1 + Math.sin(p * Math.PI * 8 + i) * .12 * settle;
    el.style.transform = \`translateX(-50%) scaleY(\${flicker}) rotate(\${Math.sin(p*Math.PI*6+i)*4*settle}deg)\`;
  });
  if (progressFill) progressFill.style.width = \`\${Math.round(enter * 100)}%\`;
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
  const hasMedia = assets.length > 0;
  const variant = brief.function === "card" ? cardVariant(brief) : null;
  const context = variant ? cardContext(brief, variant) : null;
  const stageClasses = [
    brief.function,
    hasMedia ? "has-media" : "no-media",
    variant ? `card-${variant}` : "",
    variant && context ? `card-${variant}-${context}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  let sceneMarkup = "";
  if (brief.function === "photo-story") {
    sceneMarkup = `
      ${mediaMarkup(brief, assets)}
      <div class="content">
        <div class="title">${escapeHtml(brief.message.title)}</div>
        <div class="subtitle">${escapeHtml(brief.message.subtitle || "")}</div>
        <div class="signature">${escapeHtml(brief.message.signature || "")}</div>
      </div>`;
  } else if (brief.function === "sticker") {
    sceneMarkup = `
      ${hasMedia ? `<div class="sticker-media">${mediaMarkup(brief, assets)}</div>` : '<div class="sticker-accent" aria-hidden="true"></div>'}
      <div class="content">
        <div class="title">${escapeHtml(brief.message.title)}</div>
        <div class="subtitle">${escapeHtml(brief.message.subtitle || "")}</div>
        <div class="signature">${escapeHtml(brief.message.signature || "")}</div>
      </div>`;
  } else {
    sceneMarkup = `
      ${hasMedia ? `<div class="card-media">${mediaMarkup(brief, assets)}</div><div class="card-shade" aria-hidden="true"></div>` : ""}
      ${cardDecorationMarkup(brief, variant, context)}
      <div class="content">
        <div class="kicker">${cardKicker(variant, context)}</div>
        <div class="title">${escapeHtml(brief.message.title)}</div>
        <div class="subtitle">${escapeHtml(brief.message.subtitle || "")}</div>
        <div class="signature">${escapeHtml(brief.message.signature || "")}</div>
      </div>`;
  }
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
    #stage { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; color: ${theme.ink}; background: ${theme.bg}; }
    .clip, .scene { position: absolute; inset: 0; }
    .media { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .content { position: absolute; z-index: 30; inset: 0; padding: ${brief.aspect_ratio === "9:16" ? "210px 86px 230px" : "90px 72px"}; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; }
    .title { max-width: 94%; font-size: ${brief.aspect_ratio === "9:16" ? "104px" : "88px"}; line-height: 1.08; font-weight: 900; letter-spacing: -.03em; text-wrap: balance; }
    .subtitle { max-width: 88%; margin-top: 28px; font-size: ${brief.aspect_ratio === "9:16" ? "44px" : "38px"}; line-height: 1.35; font-weight: 600; }
    .signature { margin-top: 34px; font-size: 32px; opacity: .8; }
    .kicker { margin-bottom: 28px; font: 800 ${brief.aspect_ratio === "9:16" ? "30px" : "26px"}/1 sans-serif; letter-spacing: .28em; }

    /* 照片故事保持全屏叙事，不与表情/卡片模板混用。 */
    .photo-story .media { opacity: 0; }
    .photo-story::after { content: ""; position: absolute; inset: 0; z-index: 20; background: linear-gradient(180deg,rgba(0,0,0,.08),transparent 42%,rgba(0,0,0,.54)); }
    .photo-story .content { justify-content: flex-end; color: #fff; text-shadow: 0 3px 24px rgba(0,0,0,.45); }

    /* 有照片的表情包：原图就是背景和主体，不再套渐变画布、圆环或卡片。 */
    .sticker.has-media { background: #101010; }
    .sticker-media { position: absolute; inset: 0; overflow: hidden; transform-origin: 50% 50%; }
    .sticker-media .media { object-position: center center; }
    .sticker.has-media::after { content: ""; position: absolute; inset: 0; z-index: 20; background: linear-gradient(180deg,rgba(0,0,0,.08),transparent 48%,rgba(0,0,0,.5)); }
    .sticker .content { justify-content: center; }
    .sticker.has-media .content { justify-content: flex-end; padding-bottom: ${brief.aspect_ratio === "9:16" ? "230px" : "96px"}; color: #fff; }
    .sticker .title { max-width: 96%; font-size: ${brief.aspect_ratio === "9:16" ? "138px" : "122px"}; line-height: .98; }
    .sticker.has-media .title { text-shadow: 0 5px 0 rgba(0,0,0,.9), 0 0 24px rgba(0,0,0,.85); }
    .sticker.no-media { background: ${theme.bg}; }
    .sticker.no-media .title { color: ${theme.ink}; }
    .sticker-accent { position: absolute; z-index: 4; left: 14%; right: 14%; top: 58%; height: 22px; border-radius: 999px; background: ${theme.accent}; transform: rotate(-3deg); }

    /* 有照片的卡片：全屏照片 + 信息层，避免“矩形卡套在背景上”。 */
    .card-media { position: absolute; inset: 0; transform-origin: center; }
    .card-shade { position: absolute; inset: 0; z-index: 10; background: linear-gradient(180deg,rgba(0,0,0,.08),rgba(0,0,0,.12) 42%,rgba(0,0,0,.74)); }
    .card.has-media .content { justify-content: flex-end; align-items: flex-start; text-align: left; color: #fff; text-shadow: 0 3px 22px rgba(0,0,0,.45); }
    .card.has-media .title, .card.has-media .subtitle { max-width: 88%; }
    .card.has-media .kicker { color: #fff; }

    /* 无图生日：排版、蜡烛和纸屑共同构成场景，不使用通用中心卡片。 */
    .card-birthday.no-media { background: radial-gradient(circle at 82% 12%, ${theme.soft} 0 8%, transparent 25%), radial-gradient(circle at 15% 88%, ${theme.accent}22 0 12%, transparent 31%), ${theme.bg}; }
    .card-birthday.no-media::before { content: ""; position: absolute; z-index: 1; width: 74%; height: 74%; right: -24%; top: -34%; border: 120px solid ${theme.soft}; border-radius: 50%; opacity: .72; }
    .card-birthday.no-media .content { justify-content: flex-start; align-items: flex-start; text-align: left; padding: ${brief.aspect_ratio === "9:16" ? "330px 110px 720px" : "132px 96px 420px"}; }
    .card-birthday.no-media .title { max-width: ${brief.aspect_ratio === "9:16" ? "86%" : "68%"}; font-size: ${brief.aspect_ratio === "9:16" ? "152px" : "128px"}; line-height: .94; }
    .card-birthday.no-media .subtitle { max-width: 62%; }
    .card-birthday .kicker { color: ${theme.accent}; }
    .birthday-word { position: absolute; z-index: 2; right: -1%; top: ${brief.aspect_ratio === "9:16" ? "30%" : "26%"}; color: ${theme.accent}; font: 950 ${brief.aspect_ratio === "9:16" ? "330px" : "245px"}/.8 sans-serif; letter-spacing: -.1em; writing-mode: vertical-rl; }
    .birthday-confetti { position: absolute; inset: 0; z-index: 5; }
    .confetti { position: absolute; width: 18px; height: 58px; border-radius: 9px; background: ${theme.accent}; }
    .confetti:nth-child(3n) { background: ${theme.soft}; transform: rotate(45deg); }
    .confetti:nth-child(2n) { width: 28px; height: 28px; border-radius: 50%; background: ${theme.ink}; }
    .confetti-1{left:5%;top:8%}.confetti-2{left:28%;top:6%}.confetti-3{left:73%;top:10%}.confetti-4{left:91%;top:21%}
    .confetti-5{left:8%;top:45%}.confetti-6{left:88%;top:43%}.confetti-7{left:16%;top:73%}.confetti-8{left:79%;top:68%}
    .confetti-9{left:5%;top:89%}.confetti-10{left:94%;top:85%}.confetti-11{left:38%;top:92%}.confetti-12{left:62%;top:88%}
    .confetti-13{left:49%;top:7%}.confetti-14{left:67%;top:51%}.confetti-15{left:27%;top:58%}.confetti-16{left:87%;top:93%}
    .birthday-cake { position: absolute; z-index: 10; right: ${brief.aspect_ratio === "9:16" ? "84px" : "76px"}; bottom: ${brief.aspect_ratio === "9:16" ? "280px" : "86px"}; width: ${brief.aspect_ratio === "9:16" ? "720px" : "500px"}; height: ${brief.aspect_ratio === "9:16" ? "330px" : "226px"}; border-radius: 34px 34px 62px 62px; background: linear-gradient(90deg,${theme.accent},#EF8E72 48%,${theme.accent}); box-shadow: 0 28px 0 ${theme.ink}, 0 46px 42px rgba(54,38,31,.18); }
    .cake-icing { position: absolute; inset: -2px -2px auto; height: 74px; border-radius: 34px 34px 44% 40%; background: #fff; }
    .cake-icing::before, .cake-icing::after { content: ""; position: absolute; top: 46px; width: 72px; height: 58px; border-radius: 0 0 40px 40px; background: #fff; }
    .cake-icing::before { left: 18%; } .cake-icing::after { right: 25%; height: 82px; }
    .cake-shadow { position: absolute; left: 9%; right: 9%; bottom: 44px; height: 14px; border-radius: 99px; background: ${theme.ink}22; }
    .birthday-candles { position: absolute; z-index: 12; right: ${brief.aspect_ratio === "9:16" ? "270px" : "220px"}; bottom: ${brief.aspect_ratio === "9:16" ? "604px" : "304px"}; display: flex; gap: 42px; }
    .candle { position: relative; width: 30px; height: 126px; border-radius: 12px; background: repeating-linear-gradient(-45deg,#fff 0 13px,${theme.accent} 13px 26px); box-shadow: 0 12px 24px rgba(0,0,0,.12); }
    .flame { position: absolute; left: 50%; top: -64px; width: 36px; height: 56px; border-radius: 52% 48% 50% 50% / 62% 62% 38% 38%; background: #FFB020; transform: translateX(-50%); transform-origin: 50% 100%; box-shadow: 0 0 28px #FFB02088; }
    .birthday-ribbon { position: absolute; z-index: 18; left: ${brief.aspect_ratio === "9:16" ? "110px" : "96px"}; bottom: ${brief.aspect_ratio === "9:16" ? "150px" : "60px"}; color: ${theme.ink}; font: 800 22px/1 sans-serif; letter-spacing: .18em; writing-mode: vertical-rl; }

    /* 邀请：使用票券边界、竖向信息轨和印章语义，内容左对齐。 */
    .card-invitation.no-media { background: linear-gradient(135deg,${theme.bg} 0 68%,${theme.soft} 68% 100%); }
    .card-invitation.no-media::before { content: "INVITE"; position: absolute; right: -38px; bottom: 2%; color: ${theme.ink}0D; font: 900 ${brief.aspect_ratio === "9:16" ? "220px" : "180px"}/1 sans-serif; letter-spacing: -.08em; transform: rotate(-90deg) translateX(40%); transform-origin: right bottom; }
    .card-invitation .content { align-items: flex-start; text-align: left; padding-left: ${brief.aspect_ratio === "9:16" ? "150px" : "130px"}; }
    .card-invitation .title, .card-invitation .subtitle { max-width: 76%; }
    .card-invitation .kicker { color: ${theme.accent}; }
    .invite-frame { position: absolute; z-index: 4; inset: ${brief.aspect_ratio === "9:16" ? "110px 80px" : "64px"}; border: 4px solid ${theme.ink}; border-radius: 42px; }
    .invite-rail { position: absolute; z-index: 5; left: ${brief.aspect_ratio === "9:16" ? "112px" : "92px"}; top: 20%; bottom: 20%; width: 12px; border-radius: 999px; background: ${theme.accent}; }
    .invite-seal { position: absolute; z-index: 8; right: 11%; top: 12%; width: 132px; height: 132px; display: grid; place-items: center; border: 5px solid ${theme.accent}; border-radius: 50%; color: ${theme.accent}; font-size: 54px; font-weight: 900; transform: rotate(10deg); }

    /* 家庭聚餐邀请：餐盘、筷子和日期成为主体，不复用票券矩形。 */
    .card-invitation-dinner.no-media { background: linear-gradient(90deg,${theme.bg} 0 61%,${theme.accent} 61% 100%); }
    .card-invitation-dinner.no-media::before { content: ""; position: absolute; z-index: 1; left: 0; right: 39%; bottom: 0; height: 34%; background: ${theme.soft}; clip-path: polygon(0 52%,100% 0,100% 100%,0 100%); }
    .card-invitation-dinner .content { justify-content: flex-start; padding: ${brief.aspect_ratio === "9:16" ? "290px 110px" : "124px 96px"}; }
    .card-invitation-dinner .title { max-width: 52%; font-size: ${brief.aspect_ratio === "9:16" ? "138px" : "112px"}; line-height: .96; }
    .card-invitation-dinner .subtitle { max-width: 48%; margin-top: 42px; }
    .card-invitation-dinner .signature { padding: 13px 24px; color: #fff; background: ${theme.ink}; opacity: 1; }
    .card-invitation-dinner .invite-seal { right: 6.5%; top: 7%; color: ${theme.ink}; border-color: ${theme.ink}; background: ${theme.bg}; }
    .dinner-sun { position: absolute; z-index: 2; right: 7%; top: 8%; width: 220px; height: 220px; border-radius: 50%; background: ${theme.soft}; opacity: .45; }
    .dinner-plate { position: absolute; z-index: 9; right: -4%; bottom: ${brief.aspect_ratio === "9:16" ? "320px" : "76px"}; width: ${brief.aspect_ratio === "9:16" ? "700px" : "510px"}; height: ${brief.aspect_ratio === "9:16" ? "700px" : "510px"}; border: 34px solid ${theme.bg}; border-radius: 50%; background: ${theme.ink}; box-shadow: inset 0 0 0 28px ${theme.bg}, 0 34px 54px rgba(54,38,31,.2); }
    .dinner-plate > i { position: absolute; inset: 25%; border: 22px solid ${theme.accent}; border-radius: 50%; background: ${theme.bg}; }
    .dinner-plate > b { position: absolute; width: 28%; height: 28%; left: 36%; top: 36%; border-radius: 50%; background: ${theme.soft}; }
    .dinner-chopsticks { position: absolute; z-index: 13; right: 4%; bottom: ${brief.aspect_ratio === "9:16" ? "350px" : "100px"}; width: 420px; height: 560px; transform: rotate(16deg); }
    .dinner-chopsticks i { position: absolute; right: 30px; width: 20px; height: 100%; border-radius: 99px; background: ${theme.bg}; box-shadow: 0 7px 0 ${theme.ink}; }
    .dinner-chopsticks i + i { right: 78px; }
    .dinner-steam { position: absolute; z-index: 14; right: 13%; bottom: ${brief.aspect_ratio === "9:16" ? "980px" : "590px"}; display: flex; gap: 42px; }
    .dinner-steam i { width: 38px; height: 130px; border: 9px solid ${theme.bg}; border-color: transparent transparent transparent ${theme.bg}; border-radius: 50%; transform: rotate(16deg); }
    .invite-date { position: absolute; z-index: 14; left: ${brief.aspect_ratio === "9:16" ? "110px" : "96px"}; bottom: ${brief.aspect_ratio === "9:16" ? "190px" : "84px"}; color: ${theme.ink}; font: 950 ${brief.aspect_ratio === "9:16" ? "78px" : "66px"}/1 sans-serif; letter-spacing: .08em; }

    /* 加油：斜向速度线、完成标记和进度条，避免生日式装饰。 */
    .card-encouragement.no-media { color: #fff; background: linear-gradient(145deg,#0B1020 0 62%,${theme.accent} 62% 100%); }
    .card-encouragement .content { align-items: flex-start; text-align: left; }
    .card-encouragement .title { max-width: 82%; font-size: ${brief.aspect_ratio === "9:16" ? "150px" : "126px"}; }
    .card-encouragement .subtitle { max-width: 72%; }
    .card-encouragement .kicker { color: ${theme.accent}; }
    .speed-lines { position: absolute; inset: 0; z-index: 5; overflow: hidden; }
    .speed-line { position: absolute; right: -8%; width: 46%; height: 12px; border-radius: 99px; background: #ffffff88; transform: rotate(-28deg); }
    .speed-line-1{top:13%}.speed-line-2{top:22%;right:-16%}.speed-line-3{top:31%}.speed-line-4{top:69%}.speed-line-5{top:77%;right:-17%}.speed-line-6{top:85%}.speed-line-7{top:92%;right:-9%}
    .progress-track { position: absolute; z-index: 22; left: ${brief.aspect_ratio === "9:16" ? "86px" : "72px"}; right: 32%; bottom: ${brief.aspect_ratio === "9:16" ? "230px" : "110px"}; height: 18px; overflow: hidden; border-radius: 99px; background: #ffffff33; }
    .progress-fill { display: block; width: 0; height: 100%; border-radius: inherit; background: ${theme.accent}; }
    .encourage-mark { position: absolute; z-index: 8; right: 8%; bottom: 8%; color: #fff; -webkit-text-stroke: 18px #0B1020; paint-order: stroke fill; font: 900 ${brief.aspect_ratio === "9:16" ? "250px" : "190px"}/1 sans-serif; }

    /* 其他祝福/提醒：采用非对称海报构图，保留通用但不套中心矩形。 */
    .card-announcement.no-media { background: linear-gradient(90deg,${theme.bg} 0 74%,${theme.accent} 74% 100%); }
    .card-announcement .content { align-items: flex-start; text-align: left; padding-right: 28%; }
    .card-announcement .kicker { color: ${theme.accent}; }
    .announcement-orbit { position: absolute; z-index: 5; width: 420px; height: 420px; right: -120px; top: -100px; border: 22px solid ${theme.soft}; border-radius: 50%; }
    .announcement-star { position: absolute; z-index: 8; right: 5%; top: 39%; color: ${theme.ink}; font-size: 150px; }
    .announcement-block { position: absolute; z-index: 4; left: 8%; bottom: 8%; width: 190px; height: 38px; border-radius: 99px; background: ${theme.accent}; }
  </style>
</head>
<body>
  <main id="stage" class="${stageClasses}" data-composition-id="${brief.project_name}" data-start="0" data-duration="${brief.duration_seconds}" data-fps="30" data-width="${width}" data-height="${height}">
    <section id="scene-main" class="scene clip" data-start="0" data-duration="${brief.duration_seconds}" data-track-index="0">
      ${sceneMarkup}
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

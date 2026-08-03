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
const CREATIVE_ENGINE = "cn-context-router-v2";
const ROUTE_PALETTES = {
  "card-birthday-parent-warm-ceremonial": {
    background: "#241823",
    foreground: "#FFF4E6",
    accent: "#E8B16A",
    secondary: "#A6525A",
    muted: "#4A2A3A",
  },
  "card-invitation-dinner": {
    background: "#F3E8D8",
    foreground: "#2A1D19",
    accent: "#B94A36",
    secondary: "#E0B268",
    muted: "#D8B5A0",
  },
  "card-encouragement": {
    background: "#09121F",
    foreground: "#F6FAFF",
    accent: "#D9FF3F",
    secondary: "#FF6B3D",
    muted: "#20364C",
  },
  "text-work-reply": {
    background: "#120E0B",
    foreground: "#FFF4E6",
    accent: "#FF8A1E",
    secondary: "#5EE6A8",
    muted: "#5A3418",
  },
  "text-chat-state": {
    background: "#0B1020",
    foreground: "#F6F8FF",
    accent: "#6CFFB8",
    secondary: "#8E7CFF",
    muted: "#25345D",
  },
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

function dateToken(brief) {
  const text = [brief.message.title, brief.message.subtitle].filter(Boolean).join(" ");
  const match = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!match) return "";
  return `${String(match[1]).padStart(2, "0")} · ${String(match[2]).padStart(2, "0")}`;
}

function splitStickerText(title = "") {
  const source = String(title).trim();
  const explicit = source
    .split(/[，,、：:；;。！？!?]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (explicit.length >= 2) {
    return { eyebrow: explicit[0], hero: explicit.slice(1).join("，") };
  }
  if (/^(已读|收到|好的|明白|安排|可以|在看|在办)/.test(source) && source.length >= 5) {
    const prefix = source.match(/^(已读|收到|好的|明白|安排|可以|在看|在办)/)?.[0] || "";
    return { eyebrow: prefix, hero: source.slice(prefix.length) || source };
  }
  return { eyebrow: "", hero: source };
}

function splitCardText(brief, variant, context) {
  const source = String(brief.message.title || "").trim();
  if (variant === "birthday" && ["mom", "dad"].includes(context)) {
    const match = source.match(context === "mom" ? /^(妈妈|母亲|老妈)/ : /^(爸爸|父亲|老爸)/);
    if (match && source.slice(match[0].length)) {
      return { eyebrow: match[0], hero: source.slice(match[0].length) };
    }
  }
  if (variant === "encouragement") {
    const match = source.match(/^(考试|高考|中考)(.+)$/);
    if (match) return { eyebrow: match[1], hero: match[2] };
  }
  if (variant === "invitation" && context === "dinner") {
    const match = source.match(/^(周末|周[一二三四五六日天]|星期[一二三四五六日天])(.+)$/);
    if (match) return { eyebrow: match[1], hero: match[2] };
  }
  return { eyebrow: "", hero: source };
}

function creativeRoute(brief, assets, variant, context) {
  if (brief.function === "photo-story") return "photo-story-editorial";
  if (brief.function === "sticker" && assets.length) return "photo-reaction";
  if (brief.function === "sticker") {
    const text = [brief.message.title, brief.use_case].filter(Boolean).join(" ");
    if (/工作群|办公|职场|收到|马上|已阅|安排|在办|已处理/.test(text)) return "text-work-reply";
    if (/已读|不回|在线|潜水|摸鱼|忙|撤回|输入中/.test(text)) return "text-chat-state";
    return "text-reaction";
  }
  if (assets.length) return "photo-card";
  if (variant === "birthday" && ["mom", "dad"].includes(context)) {
    return "card-birthday-parent-warm-ceremonial";
  }
  if (variant === "birthday" && context === "child") return "card-birthday-child-playful";
  if (variant === "birthday") return "card-birthday-celebration";
  if (variant === "invitation") return `card-invitation-${context}`;
  if (variant === "encouragement") return "card-encouragement";
  return "card-announcement";
}

function creativeProfile(route, brief, split, theme, textOnly) {
  const base = {
    audience: "普通聊天用户",
    tone: "清晰、克制、可直接分享",
    composition_mode: textOnly ? "非对称视频海报" : "真实素材全屏叙事",
    visual_metaphor: textOnly ? "结构线与信息节点" : "原图就是主体",
    decorative_budget: textOnly ? 5 : 2,
    palette: {
      background: theme.bg,
      foreground: theme.ink,
      accent: theme.accent,
      secondary: theme.soft,
      muted: theme.soft,
    },
    typography_register: "中文信息优先、强层级、手机端可读",
    type_pairing: "Yuanbao Sans；依靠字号与字重而非额外文案建立层级",
    concept: textOnly
      ? "用一个与语义相关的结构隐喻承接主句，让文字不再漂在空画布上。"
      : "让真实素材承担主体，文字和图形只负责可读性、节奏与叙事提示。",
    layer_purposes: textOnly
      ? ["有色氛围与低对比纹理", "单一语义隐喻和结构轨道", "用户原文与必要强调"]
      : ["用户授权真实图片", "必要的文字和可读性遮罩"],
    second_focus: textOnly ? "semantic-structure" : "authorized-user-media",
    motion_roles: [
      { role: "structure", action: "先建立第二焦点", timing: "build", easing: "sine-out" },
      { role: "hero", action: "主信息后入场并承担最强动作", timing: "build", easing: "expo-out" },
      { role: "ambient", action: "只保留一种低幅环境运动", timing: "breathe", easing: "sine-in-out" },
      { role: "final", action: brief.loop ? "统一回到首帧" : "停止环境运动并稳定停留", timing: "resolve", easing: "sine-in-out" },
    ],
    motion_beats: [
      { phase: "build", direction: "先建立第二焦点，再让主标题以更强动作进入" },
      { phase: "breathe", direction: "背景只做低幅持续运动，保持主信息可读" },
      { phase: "resolve", direction: brief.loop ? "所有焦点共同回到首帧状态" : "最后停止环境运动，稳定停留供截图" },
    ],
  };

  if (route === "card-birthday-parent-warm-ceremonial") {
    return {
      ...base,
      audience: "成年子女向妈妈或爸爸表达祝福",
      tone: "温暖、成熟、亲密而不幼稚",
      composition_mode: "中心仪式轴与大幅留白",
      visual_metaphor: "一束被点亮的生日暖光",
      decorative_budget: 5,
      palette: ROUTE_PALETTES[route],
      typography_register: "亲密称谓轻、生日主句大、祝福副句安静",
      type_pairing: "Yuanbao Serif 承担主祝福，Yuanbao Sans 承担称谓与副句",
      concept: "观众先感到一束被点亮的暖光，再读到给父母的完整生日祝福。",
      layer_purposes: ["深梅底色、细颗粒与局部暖光", "金色光环、烛光和少量星点", "用户原文的中文仪式排版"],
      second_focus: "candle-halo",
      motion_roles: [
        { role: "halo", action: "光环由小到大建立仪式轴", timing: "0.12—0.88s", easing: "sine-out" },
        { role: "candle", action: "烛光在光环内点亮", timing: "0.36—0.96s", easing: "back-out" },
        { role: "hero", action: "称谓轻入，生日主句以裁切上升显现", timing: "0.58—1.28s", easing: "expo-out" },
        { role: "support", action: "副祝福在细线展开后出现", timing: "1.05—1.68s", easing: "sine-out" },
        { role: "ambient", action: "只保留光晕呼吸和少量星点", timing: "1.68s—72%", easing: "sine-in-out" },
        { role: "final", action: "停止呼吸，末帧完全稳定", timing: "72%—100%", easing: "sine-in-out" },
      ],
      motion_beats: [
        { phase: "build", direction: "先画出暖光仪式轴，再依次点亮烛光、称谓、主祝福与副祝福" },
        { phase: "breathe", direction: "主文字完全静止，只让光晕与星点低幅呼吸" },
        { phase: "resolve", direction: "最后一段关闭呼吸，保留可直接截图的完整祝福" },
      ],
    };
  }
  if (route === "card-invitation-dinner") {
    return {
      ...base,
      audience: "家庭群里负责发起聚餐的组织者",
      tone: "热络、清楚、有家宴感",
      composition_mode: "左侧信息区与右侧餐桌主体的分栏海报",
      visual_metaphor: "桌面上预留的一个位置",
      decorative_budget: 6,
      palette: ROUTE_PALETTES[route],
      typography_register: "标题有家宴温度，时间地点像请柬信息一样稳定",
      type_pairing: "Yuanbao Serif 承担聚餐标题，Yuanbao Sans 承担时间、地点与落款",
      concept: "先看到一个已经摆好的家宴座位，再清楚读到聚餐时间、地点和落款。",
      layer_purposes: ["暖米纸张质感与分区色场", "餐盘、筷子、日期环与热气", "逐字保真的邀请信息"],
      second_focus: "place-setting-and-date",
    };
  }
  if (route === "card-encouragement") {
    return {
      ...base,
      audience: "给孩子或家人发送考前鼓励的用户",
      tone: "稳、有力、不制造额外焦虑",
      composition_mode: "斜向推进的目标海报",
      visual_metaphor: "从准备区向完成线稳定推进",
      decorative_budget: 6,
      palette: ROUTE_PALETTES[route],
      typography_register: "提示词紧凑，主加油词极重，作答建议和落款稳定",
      type_pairing: "Yuanbao Sans 的窄宽与极端字重对比",
      concept: "先建立一条可控的进度路径，再让‘加油’成为明确而不焦躁的行动口令。",
      layer_purposes: ["深墨底色与低对比网格", "方向线、进度轨与完成标记", "考试主句、作答建议与落款"],
      second_focus: "progress-to-completion",
    };
  }
  if (route === "text-work-reply") {
    return {
      ...base,
      audience: "需要快速回复工作群的用户",
      tone: "果断、紧凑、有执行感",
      composition_mode: "上下两级状态信号",
      visual_metaphor: "确认信号转入执行通道",
      decorative_budget: 5,
      palette: ROUTE_PALETTES[route],
      typography_register: "确认词紧凑，执行词极重且占主要宽度",
      concept: "把确认与执行拆成上下两级，使用状态标记和向前动势表达利落响应。",
      layer_purposes: ["暖墨底色与低对比执行通道", "状态灯、轨道与扫过的强调线", "确认词和执行主句"],
      second_focus: split.eyebrow || "confirmation-mark",
    };
  }
  if (route === "text-chat-state") {
    return {
      ...base,
      audience: "高频群聊用户",
      tone: "有梗、克制、像即时状态",
      composition_mode: "状态灯与轨道包围的聊天信号",
      visual_metaphor: "系统正在输入但尚未回复",
      decorative_budget: 5,
      palette: ROUTE_PALETTES[route],
      typography_register: "主状态大字优先，圆点和轨道只做第二焦点",
      concept: "把一句群聊状态做成正在运行的即时信号，主句在前，输入节奏在后。",
      layer_purposes: ["深蓝黑底色与低对比扫描光", "圆点、状态环和输入轨道", "用户原始状态文字"],
      second_focus: "typing-status-signal",
    };
  }
  if (route === "photo-story-editorial") {
    return {
      ...base,
      audience: "想把手机照片快速发给家人的生活记录用户",
      tone: "真实、安静、不虚构故事",
      composition_mode: "照片全屏与统一的编辑标题层",
      visual_metaphor: "翻阅一小段家庭影集",
      decorative_budget: 2,
      typography_register: "标题像影集题签，不压过照片主体",
      concept: "依原顺序翻阅一小段家庭影集，不为照片补造地点、关系或经历。",
      layer_purposes: ["用户授权的全屏照片序列", "为转场服务的轻遮罩与可选标题"],
      second_focus: brief.message.title ? "editorial-title" : "next-photo-transition",
    };
  }
  if (route === "photo-reaction") {
    return {
      ...base,
      audience: "想立刻得到群聊表情包的用户",
      tone: "直接、有情绪、不遮住原图主体",
      composition_mode: "原图全屏与底部反应大字",
      visual_metaphor: "照片本身就是表情反应",
      decorative_budget: 1,
      typography_register: "大字、高对比、聊天气泡尺寸也能读",
      concept: "让用户授权的照片直接承担表情主体，文字只做一次清晰的情绪强调。",
      layer_purposes: ["用户授权原图全屏展示", "底部可读遮罩和主反应文字"],
      second_focus: "authorized-user-media",
    };
  }
  return base;
}

function createCreativePlan(brief, assets) {
  const theme = THEMES[brief.style];
  const variant = brief.function === "card" ? cardVariant(brief) : null;
  const context = variant ? cardContext(brief, variant) : null;
  const route = creativeRoute(brief, assets, variant, context);
  const split = brief.function === "sticker" && assets.length === 0
    ? splitStickerText(brief.message.title)
    : brief.function === "card" && assets.length === 0
      ? splitCardText(brief, variant, context)
      : { eyebrow: "", hero: brief.message.title };
  const textOnly = assets.length === 0 && (brief.function === "sticker" || brief.function === "card");
  const profile = creativeProfile(route, brief, split, theme, textOnly);
  return {
    version: 1,
    source: "create-animation-cn-creative",
    function: brief.function,
    route,
    concept: profile.concept,
    creative_director: {
      engine: CREATIVE_ENGINE,
      auto_applied: true,
      signals: [brief.function, brief.style, brief.use_case, variant, context].filter(Boolean),
      decision: {
        audience: profile.audience,
        tone: profile.tone,
        composition_mode: profile.composition_mode,
        visual_metaphor: profile.visual_metaphor,
        copy_policy: "source-only",
        decorative_budget: profile.decorative_budget,
      },
    },
    content: {
      source_title: brief.message.title,
      source_subtitle: brief.message.subtitle || "",
      source_signature: brief.message.signature || "",
      eyebrow: split.eyebrow,
      hero: split.hero,
    },
    palette: profile.palette,
    typography: {
      register: profile.typography_register,
      hero_role: "承担第一焦点，占主要可视宽度",
      support_role: "只承载用户原文或无事实含义的状态符号",
      pairing: profile.type_pairing,
      local_only: true,
    },
    layers: textOnly
      ? ["background", "midground", "foreground"].map((role, index) => ({
          role,
          purpose: profile.layer_purposes[index],
        }))
      : ["background", "foreground"].map((role, index) => ({
          role,
          purpose: profile.layer_purposes[index],
        })),
    focal_points:
      textOnly
        ? [
            { order: 1, role: "hero", content: split.hero || brief.message.title },
            { order: 2, role: split.eyebrow ? "eyebrow" : "semantic-mark", content: split.eyebrow || profile.second_focus },
          ]
        : [{ order: 1, role: "media", content: "authorized-user-media" }],
    motion_roles: profile.motion_roles,
    motion_beats: profile.motion_beats,
    guardrails: [
      "不添加用户未提供的姓名、日期、地点、关系或承诺",
      "不把网页卡片布局当作视频构图",
      "不依赖远程字体、图片、脚本或网络请求",
      "装饰必须服务语义、层级或可读性",
    ],
  };
}

function cardDecorationMarkup(brief, variant, context, creativePlan) {
  if (creativePlan.route === "card-birthday-parent-warm-ceremonial") {
    return `
      <div class="birthday-parent-scene" aria-hidden="true">
        <div class="birthday-grain"></div>
        <div class="birthday-glow"></div>
        <div class="birthday-halo"></div>
        <div class="birthday-candle">
          <i class="parent-flame"></i>
          <i class="parent-wick"></i>
          <i class="parent-candle-body"></i>
        </div>
        <div class="birthday-sparks">
          ${Array.from({ length: 7 }, (_, index) => `<i class="birthday-spark birthday-spark-${index + 1}"></i>`).join("")}
        </div>
      </div>`;
  }
  if (variant === "birthday") {
    return `
      <div class="birthday-confetti" aria-hidden="true">
        ${Array.from({ length: 8 }, (_, index) => `<i class="confetti confetti-${index + 1} decor-piece"></i>`).join("")}
      </div>
      <div class="birthday-cake decor-piece" aria-hidden="true"><i class="cake-icing"></i><i class="cake-shadow"></i></div>
      <div class="birthday-candles" aria-hidden="true">
        <i class="candle"><b class="flame"></b></i>
        <i class="candle"><b class="flame"></b></i>
        <i class="candle"><b class="flame"></b></i>
      </div>`;
  }
  if (variant === "invitation") {
    if (context === "dinner") {
      return `
        <div class="dinner-sun" aria-hidden="true"></div>
        <div class="dinner-plate decor-piece" aria-hidden="true"><i></i><b></b></div>
        <div class="dinner-chopsticks" aria-hidden="true"><i></i><i></i></div>
        <div class="dinner-steam" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="invite-date">${escapeHtml(dateToken(brief))}</div>`;
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

function frameScript(brief, assetCount, creativePlan) {
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
const backOut = (x) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const q = clamp(x) - 1;
  return 1 + c3*q*q*q + c1*q*q;
};
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
const textSticker = document.querySelector(".text-sticker");
const textEyebrow = document.querySelector(".text-eyebrow");
const textUnderline = document.querySelector(".text-underline");
const textStatus = document.querySelector(".text-status");
const textGhost = document.querySelector(".text-ghost");
const textBeam = document.querySelector(".text-beam");
const textRings = [...document.querySelectorAll(".text-ring")];
const kicker = document.querySelector(".kicker");
const parentBirthday = document.querySelector(".birthday-parent-scene");
const parentHalo = document.querySelector(".birthday-halo");
const parentGlow = document.querySelector(".birthday-glow");
const parentCandle = document.querySelector(".birthday-candle");
const parentFlame = document.querySelector(".parent-flame");
const parentSparks = [...document.querySelectorAll(".birthday-spark")];
const windows = ${JSON.stringify(photoWindows)};

function applyFrame(seconds) {
  current = clamp(Number(seconds) || 0, 0, duration);
  const p = current / duration;
  const enter = easeOut(clamp(current / Math.min(1.1, duration * .22)));
  const exit = ${brief.loop ? "1 - easeInOut(clamp((current - duration * .78) / (duration * .22)))" : "1"};
  const settle = ${brief.loop ? "exit" : "1"};
  const pulse = Math.sin(p * Math.PI * 2);
  if (parentBirthday) {
    const resolveMotion = 1 - easeInOut(clamp((current - duration * .70) / (duration * .12)));
    const haloEnter = easeOut(clamp((current - .12) / .76));
    const candleEnter = backOut(clamp((current - .36) / .60));
    const eyebrowEnter = easeOut(clamp((current - .58) / .46));
    const heroEnter = easeOut(clamp((current - .72) / .58));
    const supportEnter = easeOut(clamp((current - 1.08) / .62));
    const ambient = Math.sin(Math.max(0, current - 1.4) * 1.45) * resolveMotion;
    if (parentGlow) {
      parentGlow.style.opacity = String(.52 * haloEnter);
      parentGlow.style.transform = \`translate(-50%,-50%) scale(\${.78 + haloEnter*.22 + ambient*.018})\`;
    }
    if (parentHalo) {
      parentHalo.style.opacity = String(haloEnter);
      parentHalo.style.transform = \`translate(-50%,-50%) scale(\${.72 + haloEnter*.28 + ambient*.01}) rotate(\${ambient*.45}deg)\`;
    }
    if (parentCandle) {
      parentCandle.style.opacity = String(clamp(candleEnter));
      parentCandle.style.transform = \`translateX(-50%) translateY(\${(1-clamp(candleEnter))*28}px) scale(\${.72 + clamp(candleEnter)*.28})\`;
    }
    if (parentFlame) {
      parentFlame.style.transform = \`scaleY(\${1 + ambient*.055}) rotate(\${ambient*1.8}deg)\`;
    }
    if (kicker) {
      kicker.style.opacity = String(eyebrowEnter);
      kicker.style.transform = \`translateY(\${(1-eyebrowEnter)*22}px)\`;
    }
    title.style.opacity = String(heroEnter);
    title.style.transform = \`translateY(\${(1-heroEnter)*48}px) scale(\${.94 + heroEnter*.06})\`;
    if (subtitle) {
      subtitle.style.opacity = String(supportEnter);
      subtitle.style.transform = \`translateY(\${(1-supportEnter)*22}px)\`;
    }
    if (signature) signature.style.opacity = String(supportEnter);
    if (content) content.style.transform = "translateY(0)";
    parentSparks.forEach((spark, i) => {
      const sparkEnter = easeOut(clamp((current - .44 - i*.055) / .42));
      const sparkle = .45 + .28*Math.sin(Math.max(0,current-1.2)*1.7 + i*1.13)*resolveMotion;
      spark.style.opacity = String(sparkEnter * sparkle);
      spark.style.transform = \`scale(\${.62 + sparkEnter*.38 + ambient*.04})\`;
    });
  } else if (textSticker) {
    const eyebrowEnter = easeOut(clamp((current - .08) / .46));
    const heroEnter = backOut(clamp((current - .24) / .58));
    const underlineEnter = easeOut(clamp((current - .62) / .42));
    const statusEnter = backOut(clamp((current - .48) / .42));
    title.style.opacity = String(clamp(heroEnter) * exit);
    title.style.transform = \`translate3d(\${(1-clamp(heroEnter))*-150}px,\${(1-clamp(heroEnter))*42}px,0) scale(\${.72 + clamp(heroEnter)*.28})\`;
    if (textEyebrow) {
      textEyebrow.style.opacity = String(eyebrowEnter * exit);
      textEyebrow.style.transform = \`translateY(\${(1-eyebrowEnter)*-54}px)\`;
    }
    if (textUnderline) {
      textUnderline.style.opacity = String(underlineEnter * exit);
      textUnderline.style.transform = \`scaleX(\${underlineEnter}) skewX(-18deg)\`;
    }
    if (textStatus) {
      const statusVisibility = clamp(statusEnter) * exit;
      textStatus.style.opacity = String(statusVisibility);
      textStatus.style.visibility = statusVisibility < .22 ? "hidden" : "visible";
      textStatus.style.transform = \`scale(\${.45 + clamp(statusEnter)*.55}) rotate(\${(1-clamp(statusEnter))*-18}deg)\`;
    }
    if (textGhost) {
      textGhost.style.opacity = String((.08 + .055*(1+pulse)) * settle);
      textGhost.style.transform = \`translate(-50%,-50%) scale(\${.96 + .025*pulse})\`;
    }
    if (textBeam) {
      textBeam.style.opacity = String((.62 + .12*pulse) * settle);
      textBeam.style.transform = \`translate3d(\${p*28}px,\${p*-16}px,0) rotate(-18deg)\`;
    }
    textRings.forEach((ring, i) => {
      ring.style.opacity = String((.24 - i*.045) * settle);
      ring.style.transform = \`translate(-50%,-50%) rotate(\${p*(i%2 ? -24 : 28) + i*9}deg) scale(\${1 + pulse*.012*(i+1)})\`;
    });
  } else {
    title.style.opacity = String(enter * exit);
    title.style.transform = \`translateY(\${(1-enter)*76}px) scale(\${.84 + enter*.16 + Math.max(0,pulse)*.012*settle})\`;
    if (subtitle) subtitle.style.opacity = String(clamp((current - .45) / .65) * exit);
    if (signature) signature.style.opacity = String(clamp((current - .8) / .7) * exit);
    if (kicker) kicker.style.opacity = String(clamp((current - .16) / .46) * exit);
    if (content) content.style.transform = \`translateY(\${(1-enter)*24}px)\`;
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
  if (progressFill) progressFill.style.transform = \`scaleX(\${enter})\`;
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

function compositionHtml(brief, assets, creativePlan) {
  const [width, height] = DIMS[brief.aspect_ratio];
  const theme = THEMES[brief.style];
  const palette = creativePlan.palette;
  const hasMedia = assets.length > 0;
  const variant = brief.function === "card" ? cardVariant(brief) : null;
  const context = variant ? cardContext(brief, variant) : null;
  const stageClasses = [
    brief.function,
    hasMedia ? "has-media" : "no-media",
    variant ? `card-${variant}` : "",
    variant && context ? `card-${variant}-${context}` : "",
    `creative-${creativePlan.route}`,
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
    sceneMarkup = hasMedia
      ? `
      <div class="sticker-media">${mediaMarkup(brief, assets)}</div>
      <div class="content">
        <div class="title">${escapeHtml(brief.message.title)}</div>
        <div class="subtitle">${escapeHtml(brief.message.subtitle || "")}</div>
        <div class="signature">${escapeHtml(brief.message.signature || "")}</div>
      </div>`
      : `
      <div class="text-sticker" aria-hidden="true">
        <div class="text-beam"></div>
        <div class="text-ring text-ring-1" data-layout-allow-overflow></div>
        <div class="text-ring text-ring-2" data-layout-allow-overflow></div>
        <div class="text-ring text-ring-3" data-layout-allow-overflow></div>
        <div class="text-ghost" data-layout-allow-occlusion>${creativePlan.route === "text-work-reply" ? "✓" : "•••"}</div>
      </div>
      <div class="content text-sticker-content">
        ${creativePlan.content.eyebrow ? `<div class="text-eyebrow">${escapeHtml(creativePlan.content.eyebrow)}${creativePlan.route === "text-work-reply" ? '<span class="text-status">✓</span>' : ""}</div>` : ""}
        <div class="title">${escapeHtml(creativePlan.content.hero)}</div>
        <div class="text-underline" aria-hidden="true"></div>
      </div>`;
  } else {
    sceneMarkup = `
      ${hasMedia ? `<div class="card-media">${mediaMarkup(brief, assets)}</div><div class="card-shade" aria-hidden="true"></div>` : ""}
      ${cardDecorationMarkup(brief, variant, context, creativePlan)}
      <div class="content">
        ${creativePlan.content.eyebrow ? `<div class="kicker">${escapeHtml(creativePlan.content.eyebrow)}</div>` : ""}
        <div class="title">${escapeHtml(creativePlan.content.hero || brief.message.title)}</div>
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
      font-family: "Yuanbao Sans";
      src: local("PingFang SC"), local("Heiti SC Medium"), local("Microsoft YaHei"), local("Noto Sans CJK SC"), local("Source Han Sans SC");
      font-style: normal;
      font-weight: 400;
    }
    @font-face {
      font-family: "Yuanbao Serif";
      src: local("Songti SC"), local("STSong"), local("SimSun"), local("Noto Serif CJK SC"), local("Source Han Serif SC");
      font-style: normal;
      font-weight: 700;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: ${palette.background}; }
    body { font-family: "Yuanbao Sans", sans-serif; }
    #stage { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; color: ${palette.foreground}; background: ${palette.background}; }
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
    .sticker.no-media { background: ${palette.background}; }
    .sticker.no-media .title { color: ${palette.accent}; }
    .text-sticker { position: absolute; inset: 0; z-index: 2; overflow: hidden; }
    .text-sticker-content { align-items: flex-start; justify-content: center; text-align: left; padding: ${brief.aspect_ratio === "9:16" ? "250px 82px" : "150px 78px"}; }
    .text-sticker-content .title { position: relative; z-index: 4; width: 100%; max-width: 94%; font-size: ${brief.aspect_ratio === "9:16" ? "230px" : "204px"}; line-height: .86; letter-spacing: -.075em; text-wrap: nowrap; transform-origin: 0 70%; }
    .text-eyebrow { position: relative; z-index: 5; display: flex; align-items: center; gap: 24px; margin: 0 0 44px 5px; color: ${palette.foreground}; font-size: ${brief.aspect_ratio === "9:16" ? "88px" : "78px"}; line-height: 1; font-weight: 900; letter-spacing: .04em; }
    .text-status { display: inline-grid; width: 74px; height: 74px; place-items: center; border-radius: 50%; color: ${palette.background}; background: ${palette.secondary}; font: 950 48px/1 sans-serif; transform-origin: center; }
    .text-underline { position: relative; z-index: 5; width: 74%; height: 22px; margin: 48px 0 0 5px; border-radius: 99px; background: ${palette.accent}; transform-origin: left center; }
    .text-ghost { position: absolute; z-index: 1; left: 69%; top: 47%; color: ${palette.accent}; font: 950 ${brief.aspect_ratio === "9:16" ? "690px" : "610px"}/1 sans-serif; transform: translate(-50%,-50%); }
    .text-ring { position: absolute; z-index: 2; left: 72%; top: 48%; border: 8px solid ${palette.accent}; border-radius: 50%; transform: translate(-50%,-50%); }
    .text-ring-1 { width: 600px; height: 600px; }
    .text-ring-2 { width: 760px; height: 530px; border-width: 5px; }
    .text-ring-3 { width: 900px; height: 420px; border-width: 3px; }
    .text-beam { position: absolute; z-index: 1; right: -18%; top: 8%; width: 76%; height: 104%; background: ${palette.muted}; clip-path: polygon(54% 0,100% 0,44% 100%,0 100%); transform: rotate(-18deg); opacity: .7; }
    .creative-text-chat-state .text-sticker-content .title { color: ${palette.foreground}; font-size: ${brief.aspect_ratio === "9:16" ? "196px" : "174px"}; text-wrap: balance; }
    .creative-text-chat-state .text-ghost { color: ${palette.secondary}; letter-spacing: .08em; }
    .creative-text-reaction .text-sticker-content { align-items: center; text-align: center; }
    .creative-text-reaction .text-sticker-content .title { color: ${palette.foreground}; text-wrap: balance; }
    .creative-text-reaction .text-underline { width: 58%; }

    /* 有照片的卡片：全屏照片 + 信息层，避免“矩形卡套在背景上”。 */
    .card-media { position: absolute; inset: 0; transform-origin: center; }
    .card-shade { position: absolute; inset: 0; z-index: 10; background: linear-gradient(180deg,rgba(0,0,0,.08),rgba(0,0,0,.12) 42%,rgba(0,0,0,.74)); }
    .card.has-media .content { justify-content: flex-end; align-items: flex-start; text-align: left; color: #fff; text-shadow: 0 3px 22px rgba(0,0,0,.45); }
    .card.has-media .title, .card.has-media .subtitle { max-width: 88%; }
    .card.has-media .kicker { color: #fff; }

    /* 通用生日场景：只在儿童或明确热闹语气时使用蛋糕和纸屑。 */
    .card-birthday.no-media { background: radial-gradient(circle at 82% 12%, ${palette.secondary} 0 8%, transparent 25%), radial-gradient(circle at 15% 88%, ${palette.accent}22 0 12%, transparent 31%), ${palette.background}; }
    .card-birthday.no-media::before { content: ""; position: absolute; z-index: 1; width: 74%; height: 74%; right: -24%; top: -34%; border: 120px solid ${palette.secondary}; border-radius: 50%; opacity: .72; }
    .card-birthday.no-media .content { justify-content: flex-start; align-items: flex-start; text-align: left; padding: ${brief.aspect_ratio === "9:16" ? "330px 110px 720px" : "132px 96px 420px"}; }
    .card-birthday.no-media .title { max-width: ${brief.aspect_ratio === "9:16" ? "86%" : "68%"}; font-size: ${brief.aspect_ratio === "9:16" ? "152px" : "128px"}; line-height: .94; }
    .card-birthday.no-media .subtitle { max-width: 62%; }
    .card-birthday .kicker { color: ${palette.accent}; }
    .birthday-confetti { position: absolute; inset: 0; z-index: 5; }
    .confetti { position: absolute; width: 18px; height: 58px; border-radius: 9px; background: ${palette.accent}; }
    .confetti:nth-child(3n) { background: ${palette.secondary}; transform: rotate(45deg); }
    .confetti:nth-child(2n) { width: 28px; height: 28px; border-radius: 50%; background: ${palette.foreground}; }
    .confetti-1{left:5%;top:8%}.confetti-2{left:28%;top:6%}.confetti-3{left:73%;top:10%}.confetti-4{left:91%;top:21%}
    .confetti-5{left:8%;top:45%}.confetti-6{left:88%;top:43%}.confetti-7{left:16%;top:73%}.confetti-8{left:79%;top:68%}
    .confetti-9{left:5%;top:89%}.confetti-10{left:94%;top:85%}.confetti-11{left:38%;top:92%}.confetti-12{left:62%;top:88%}
    .confetti-13{left:49%;top:7%}.confetti-14{left:67%;top:51%}.confetti-15{left:27%;top:58%}.confetti-16{left:87%;top:93%}
    .birthday-cake { position: absolute; z-index: 10; right: ${brief.aspect_ratio === "9:16" ? "84px" : "76px"}; bottom: ${brief.aspect_ratio === "9:16" ? "280px" : "86px"}; width: ${brief.aspect_ratio === "9:16" ? "720px" : "500px"}; height: ${brief.aspect_ratio === "9:16" ? "330px" : "226px"}; border-radius: 34px 34px 62px 62px; background: linear-gradient(90deg,${palette.accent},#EF8E72 48%,${palette.accent}); box-shadow: 0 28px 0 ${palette.foreground}, 0 46px 42px rgba(54,38,31,.18); }
    .cake-icing { position: absolute; inset: -2px -2px auto; height: 74px; border-radius: 34px 34px 44% 40%; background: #fff; }
    .cake-icing::before, .cake-icing::after { content: ""; position: absolute; top: 46px; width: 72px; height: 58px; border-radius: 0 0 40px 40px; background: #fff; }
    .cake-icing::before { left: 18%; } .cake-icing::after { right: 25%; height: 82px; }
    .cake-shadow { position: absolute; left: 9%; right: 9%; bottom: 44px; height: 14px; border-radius: 99px; background: ${palette.foreground}22; }
    .birthday-candles { position: absolute; z-index: 12; right: ${brief.aspect_ratio === "9:16" ? "270px" : "220px"}; bottom: ${brief.aspect_ratio === "9:16" ? "604px" : "304px"}; display: flex; gap: 42px; }
    .candle { position: relative; width: 30px; height: 126px; border-radius: 12px; background: repeating-linear-gradient(-45deg,#fff 0 13px,${palette.accent} 13px 26px); box-shadow: 0 12px 24px rgba(0,0,0,.12); }
    .flame { position: absolute; left: 50%; top: -64px; width: 36px; height: 56px; border-radius: 52% 48% 50% 50% / 62% 62% 38% 38%; background: #FFB020; transform: translateX(-50%); transform-origin: 50% 100%; box-shadow: 0 0 28px #FFB02088; }

    /* 成年长辈生日：单一暖光隐喻，中文原文就是画面主体。 */
    .creative-card-birthday-parent-warm-ceremonial { background: ${palette.background}; }
    .creative-card-birthday-parent-warm-ceremonial::before { inset: 0; width: auto; height: auto; right: auto; top: auto; border: 0; border-radius: 0; opacity: 1; background: radial-gradient(circle at 50% 39%, ${palette.secondary}66 0 9%, ${palette.secondary}20 28%, transparent 56%); }
    .birthday-parent-scene { position: absolute; inset: 0; z-index: 2; overflow: hidden; }
    .birthday-grain { position: absolute; inset: 0; opacity: .16; background-image: repeating-radial-gradient(circle at 20% 30%, rgba(255,255,255,.24) 0 1px, transparent 1px 4px); background-size: 7px 7px; mix-blend-mode: soft-light; }
    .birthday-glow { position: absolute; left: 50%; top: ${brief.aspect_ratio === "9:16" ? "39%" : "41%"}; width: ${brief.aspect_ratio === "9:16" ? "820px" : "700px"}; height: ${brief.aspect_ratio === "9:16" ? "820px" : "700px"}; border-radius: 50%; background: radial-gradient(circle, ${palette.accent}38 0 8%, ${palette.secondary}1F 33%, transparent 68%); transform: translate(-50%,-50%); }
    .birthday-halo { position: absolute; left: 50%; top: ${brief.aspect_ratio === "9:16" ? "39%" : "41%"}; width: ${brief.aspect_ratio === "9:16" ? "660px" : "560px"}; height: ${brief.aspect_ratio === "9:16" ? "660px" : "560px"}; border: 3px solid ${palette.accent}B8; border-radius: 50%; box-shadow: 0 0 44px ${palette.accent}2C, inset 0 0 44px ${palette.accent}16; transform: translate(-50%,-50%); }
    .birthday-halo::after { content: ""; position: absolute; inset: 34px; border: 1px solid ${palette.accent}4D; border-radius: 50%; }
    .birthday-candle { position: absolute; z-index: 4; left: 50%; top: ${brief.aspect_ratio === "9:16" ? "25%" : "24%"}; width: 62px; height: 126px; transform: translateX(-50%); }
    .parent-candle-body { position: absolute; left: 17px; top: 48px; width: 28px; height: 76px; border-radius: 4px 4px 10px 10px; background: linear-gradient(90deg,${palette.foreground},#F0CAA2 56%,${palette.accent}); box-shadow: 0 16px 28px rgba(0,0,0,.28); }
    .parent-wick { position: absolute; left: 29px; top: 35px; width: 4px; height: 18px; border-radius: 99px; background: ${palette.foreground}; }
    .parent-flame { position: absolute; left: 16px; top: -6px; width: 31px; height: 46px; border-radius: 58% 42% 56% 44% / 72% 70% 30% 28%; background: #FFD27A; box-shadow: 0 0 24px #FFD27A99, 0 0 58px ${palette.accent}88; transform-origin: 50% 100%; }
    .birthday-spark { position: absolute; width: 7px; height: 7px; border-radius: 50%; background: ${palette.accent}; box-shadow: 0 0 14px ${palette.accent}; }
    .birthday-spark-1{left:22%;top:21%}.birthday-spark-2{left:76%;top:24%}.birthday-spark-3{left:17%;top:52%}.birthday-spark-4{left:84%;top:56%}.birthday-spark-5{left:31%;top:73%}.birthday-spark-6{left:70%;top:77%}.birthday-spark-7{left:50%;top:15%}
    .creative-card-birthday-parent-warm-ceremonial .content { z-index: 20; justify-content: center; align-items: center; text-align: center; padding: ${brief.aspect_ratio === "9:16" ? "640px 90px 300px" : "360px 70px 120px"}; }
    .creative-card-birthday-parent-warm-ceremonial .kicker { margin-bottom: 22px; color: ${palette.foreground}; font: 500 ${brief.aspect_ratio === "9:16" ? "48px" : "42px"}/1 "Yuanbao Sans", sans-serif; letter-spacing: .26em; }
    .creative-card-birthday-parent-warm-ceremonial .title { max-width: 92%; color: #F6CE8E; font-family: "Yuanbao Serif", serif; font-size: ${brief.aspect_ratio === "9:16" ? "170px" : "150px"}; font-weight: 700; letter-spacing: -.035em; line-height: .98; text-shadow: 0 6px 34px ${palette.accent}30; text-wrap: nowrap; }
    .creative-card-birthday-parent-warm-ceremonial .subtitle { max-width: 82%; margin-top: 34px; padding-top: 28px; border-top: 1px solid ${palette.accent}8F; color: ${palette.foreground}; font-size: ${brief.aspect_ratio === "9:16" ? "48px" : "40px"}; font-weight: 400; letter-spacing: .05em; line-height: 1.5; }
    .creative-card-birthday-parent-warm-ceremonial .signature:empty { display: none; }

    /* 邀请：使用票券边界、竖向信息轨和印章语义，内容左对齐。 */
    .card-invitation.no-media { background: linear-gradient(135deg,${theme.bg} 0 68%,${theme.soft} 68% 100%); }
    .card-invitation.no-media::before { content: ""; position: absolute; right: -5%; bottom: -14%; width: 42%; height: 64%; border: 42px solid ${theme.ink}0D; border-radius: 50%; transform: rotate(-12deg); }
    .card-invitation .content { align-items: flex-start; text-align: left; padding-left: ${brief.aspect_ratio === "9:16" ? "150px" : "130px"}; }
    .card-invitation .title, .card-invitation .subtitle { max-width: 76%; }
    .card-invitation .kicker { color: ${theme.accent}; }
    .invite-frame { position: absolute; z-index: 4; inset: ${brief.aspect_ratio === "9:16" ? "110px 80px" : "64px"}; border: 4px solid ${theme.ink}; border-radius: 42px; }
    .invite-rail { position: absolute; z-index: 5; left: ${brief.aspect_ratio === "9:16" ? "112px" : "92px"}; top: 20%; bottom: 20%; width: 12px; border-radius: 999px; background: ${theme.accent}; }
    .invite-seal { position: absolute; z-index: 8; right: 11%; top: 12%; width: 132px; height: 132px; display: grid; place-items: center; border: 5px solid ${theme.accent}; border-radius: 50%; color: ${theme.accent}; font-size: 54px; font-weight: 900; transform: rotate(10deg); }

    /* 家庭聚餐邀请：餐盘、筷子和日期成为主体，不复用票券矩形。 */
    .card-invitation-dinner.no-media { background: linear-gradient(90deg,${palette.background} 0 61%,${palette.accent} 61% 100%); }
    .card-invitation-dinner.no-media::before { content: ""; position: absolute; z-index: 1; left: 0; right: 39%; bottom: 0; height: 34%; background: ${palette.muted}; clip-path: polygon(0 52%,100% 0,100% 100%,0 100%); }
    .card-invitation-dinner .content { justify-content: flex-start; padding: ${brief.aspect_ratio === "9:16" ? "290px 110px" : "124px 96px"}; }
    .card-invitation-dinner .kicker { margin-bottom: 24px; color: ${palette.accent}; font-size: ${brief.aspect_ratio === "9:16" ? "54px" : "44px"}; font-weight: 800; letter-spacing: .16em; }
    .card-invitation-dinner .title { max-width: 53%; color: ${palette.foreground}; font-family: "Yuanbao Serif", serif; font-size: ${brief.aspect_ratio === "9:16" ? "146px" : "120px"}; letter-spacing: -.04em; line-height: .98; }
    .card-invitation-dinner .subtitle { max-width: 49%; margin-top: 42px; color: ${palette.foreground}; font-size: ${brief.aspect_ratio === "9:16" ? "46px" : "39px"}; font-weight: 500; line-height: 1.55; }
    .card-invitation-dinner .signature { margin-top: 34px; padding: 13px 24px; color: ${palette.background}; background: ${palette.foreground}; opacity: 1; }
    .dinner-sun { position: absolute; z-index: 2; right: 7%; top: 8%; width: 220px; height: 220px; border-radius: 50%; background: ${palette.secondary}; opacity: .58; }
    .dinner-plate { position: absolute; z-index: 9; right: -4%; bottom: ${brief.aspect_ratio === "9:16" ? "320px" : "76px"}; width: ${brief.aspect_ratio === "9:16" ? "700px" : "510px"}; height: ${brief.aspect_ratio === "9:16" ? "700px" : "510px"}; border: 34px solid ${palette.background}; border-radius: 50%; background: ${palette.foreground}; box-shadow: inset 0 0 0 28px ${palette.background}, 0 34px 54px rgba(42,29,25,.22); }
    .dinner-plate > i { position: absolute; inset: 25%; border: 22px solid ${palette.accent}; border-radius: 50%; background: ${palette.background}; }
    .dinner-plate > b { position: absolute; width: 28%; height: 28%; left: 36%; top: 36%; border-radius: 50%; background: ${palette.secondary}; }
    .dinner-chopsticks { position: absolute; z-index: 13; right: 4%; bottom: ${brief.aspect_ratio === "9:16" ? "350px" : "100px"}; width: 420px; height: 560px; transform: rotate(16deg); }
    .dinner-chopsticks i { position: absolute; right: 30px; width: 20px; height: 100%; border-radius: 99px; background: ${palette.background}; box-shadow: 0 7px 0 ${palette.foreground}; }
    .dinner-chopsticks i + i { right: 78px; }
    .dinner-steam { position: absolute; z-index: 14; right: 13%; bottom: ${brief.aspect_ratio === "9:16" ? "980px" : "590px"}; display: flex; gap: 42px; }
    .dinner-steam i { width: 38px; height: 130px; border: 9px solid ${palette.background}; border-color: transparent transparent transparent ${palette.background}; border-radius: 50%; transform: rotate(16deg); }
    .invite-date { position: absolute; z-index: 14; left: ${brief.aspect_ratio === "9:16" ? "110px" : "96px"}; bottom: ${brief.aspect_ratio === "9:16" ? "190px" : "84px"}; color: ${palette.foreground}; font: 800 ${brief.aspect_ratio === "9:16" ? "78px" : "66px"}/1 "Yuanbao Sans", sans-serif; letter-spacing: .08em; }

    /* 加油：斜向速度线、完成标记和进度条，避免生日式装饰。 */
    .card-encouragement.no-media { color: ${palette.foreground}; background: linear-gradient(90deg,rgba(255,255,255,.045) 1px,transparent 1px) 0 0/72px 72px, linear-gradient(0deg,rgba(255,255,255,.035) 1px,transparent 1px) 0 0/72px 72px, linear-gradient(145deg,${palette.background} 0 68%,${palette.accent} 68% 100%); }
    .card-encouragement .content { align-items: flex-start; text-align: left; padding-left: ${brief.aspect_ratio === "9:16" ? "100px" : "86px"}; }
    .card-encouragement .title { max-width: 78%; color: ${palette.foreground}; font-size: ${brief.aspect_ratio === "9:16" ? "260px" : "220px"}; line-height: .82; letter-spacing: -.08em; }
    .card-encouragement .subtitle { max-width: 68%; margin-top: 50px; color: ${palette.foreground}; font-size: ${brief.aspect_ratio === "9:16" ? "48px" : "42px"}; font-weight: 500; }
    .card-encouragement .kicker { margin-bottom: 34px; color: ${palette.accent}; font-size: ${brief.aspect_ratio === "9:16" ? "58px" : "50px"}; letter-spacing: .14em; }
    .card-encouragement .signature { margin-top: 28px; color: ${palette.foreground}; font-size: 30px; opacity: .72; }
    .speed-lines { position: absolute; inset: 0; z-index: 5; overflow: hidden; }
    .speed-line { position: absolute; right: -8%; width: 46%; height: 12px; border-radius: 99px; background: #ffffff88; transform: rotate(-28deg); }
    .speed-line-1{top:13%}.speed-line-2{top:22%;right:-16%}.speed-line-3{top:31%}.speed-line-4{top:69%}.speed-line-5{top:77%;right:-17%}.speed-line-6{top:85%}.speed-line-7{top:92%;right:-9%}
    .progress-track { position: absolute; z-index: 22; left: ${brief.aspect_ratio === "9:16" ? "86px" : "72px"}; right: 32%; bottom: ${brief.aspect_ratio === "9:16" ? "230px" : "110px"}; height: 18px; overflow: hidden; border-radius: 99px; background: #ffffff33; }
    .progress-fill { display: block; width: 100%; height: 100%; border-radius: inherit; background: ${palette.accent}; transform: scaleX(0); transform-origin: left center; }
    .encourage-mark { position: absolute; z-index: 8; right: 7%; bottom: 7%; color: ${palette.foreground}; -webkit-text-stroke: 18px ${palette.background}; paint-order: stroke fill; font: 900 ${brief.aspect_ratio === "9:16" ? "250px" : "210px"}/1 sans-serif; }

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
  <main id="stage" class="${stageClasses}" data-creative-route="${creativePlan.route}" data-creative-engine="${CREATIVE_ENGINE}" data-composition-id="${brief.project_name}" data-start="0" data-duration="${brief.duration_seconds}" data-fps="30" data-width="${width}" data-height="${height}">
    <section id="scene-main" class="scene clip" data-start="0" data-duration="${brief.duration_seconds}" data-track-index="0">
      ${sceneMarkup}
    </section>
  </main>
  <script>${frameScript(brief, assets.length, creativePlan)}</script>
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
    const creativePlan = createCreativePlan(brief, assets);
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
      creative_contract_version: 1,
      creative_engine_version: 2,
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
      ["creative-plan.json", `${JSON.stringify(creativePlan, null, 2)}\n`],
      ["animation-plan.json", `${JSON.stringify(plan, null, 2)}\n`],
      ["asset-manifest.json", `${JSON.stringify(assets, null, 2)}\n`],
      ["hyperframes.json", `${JSON.stringify(hyperframes, null, 2)}\n`],
      ["index.html", compositionHtml(brief, assets, creativePlan)],
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

#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const LIMITS = {
  sticker: { duration: [2, 6], media: [0, 1], title: 16 },
  card: { duration: [4, 10], media: [0, 1], title: 16 },
  "photo-story": { duration: [6, 30], media: [3, 12], title: 20 },
};
const RATIOS = new Set(["1:1", "9:16", "16:9"]);
const FORMATS = new Set(["mp4", "gif"]);
const STYLES = new Set(["warm", "playful", "clean", "energetic"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png"]);
const PRIVACY_STATUSES = new Set([
  "reviewed-no-sensitive-content",
  "user-confirmed-keep",
  "source-already-redacted",
]);
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_TOTAL_ASSET_BYTES = 300 * 1024 * 1024;
const MAX_DECODED_IMAGE_BYTES = 200 * 1024 * 1024;
const MAX_SOURCE_BRIEF_BYTES = 256 * 1024;
const MAX_APPROVED_MEDIA_ROOTS = 12;
const BROAD_MEDIA_ROOTS = new Set([
  "/Users",
  "/home",
  "/private",
  "/private/tmp",
  "/private/var",
  "/tmp",
  "/var",
  "/Volumes",
  "/mnt",
  "/opt",
]);

const CRC_TABLE = Array.from({ length: 256 }, (_, initial) => {
  let value = initial;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

export async function loadBrief(inputPath) {
  const handle = await open(inputPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("source brief 不是普通文件");
    if (info.size > MAX_SOURCE_BRIEF_BYTES) {
      throw new Error("source brief 超过256KB上限");
    }
    const bounded = Buffer.alloc(MAX_SOURCE_BRIEF_BYTES + 1);
    const { bytesRead } = await handle.read(bounded, 0, bounded.length, 0);
    if (bytesRead > MAX_SOURCE_BRIEF_BYTES) throw new Error("source brief 超过256KB上限");
    const after = await handle.stat();
    if (
      bytesRead !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    ) {
      throw new Error("source brief 在读取期间发生变化");
    }
    const raw = bounded.subarray(0, bytesRead).toString("utf8");
    const brief = JSON.parse(raw);
    if (!brief || Array.isArray(brief) || typeof brief !== "object") {
      throw new Error("source brief 顶层必须是对象");
    }
    return brief;
  } finally {
    await handle.close();
  }
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function readPngMetadata(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(signature)) return null;
  let hasExif = false;
  let animated = false;
  let width = null;
  let height = null;
  let bitDepth = null;
  let colorType = null;
  let interlace = null;
  let sawIhdr = false;
  let sawPlte = false;
  let sawIdat = false;
  let sawIend = false;
  const idatParts = [];
  const errors = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) {
      errors.push("chunk 长度越界");
      break;
    }
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(buffer.subarray(offset + 4, offset + 8 + length));
    if (actualCrc !== expectedCrc) errors.push(`${type} CRC 无效`);
    if (!sawIhdr && type !== "IHDR") errors.push("首个 chunk 必须是 IHDR");
    if (type === "IHDR") {
      if (sawIhdr || length !== 13) {
        errors.push("IHDR 必须唯一且长度为13");
      } else {
        sawIhdr = true;
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        bitDepth = data[8];
        colorType = data[9];
        if (data[10] !== 0 || data[11] !== 0) errors.push("PNG 压缩或过滤方法无效");
        interlace = data[12];
        if (interlace !== 0) errors.push("首版只接受非交错静态 PNG");
      }
    } else if (type === "PLTE") {
      sawPlte = true;
    } else if (type === "IDAT") {
      sawIdat = true;
      idatParts.push(data);
    } else if (type === "IEND") {
      if (length !== 0) errors.push("IEND 长度必须为0");
      sawIend = true;
      offset = end;
      break;
    }
    if (type === "eXIf") hasExif = true;
    if (["acTL", "fcTL", "fdAT"].includes(type)) animated = true;
    if (/^[A-Z]/.test(type) && !["IHDR", "PLTE", "IDAT", "IEND"].includes(type)) {
      errors.push(`未知关键 chunk：${type}`);
    }
    offset = end;
  }
  if (!sawIhdr) errors.push("缺少 IHDR");
  if (!sawIdat) errors.push("缺少 IDAT 像素流");
  if (!sawIend) errors.push("缺少 IEND");
  if (sawIend && offset !== buffer.length) errors.push("IEND 后含多余数据");
  if (animated) errors.push("检测到 APNG 动画 chunk");
  if (colorType === 3 && !sawPlte) errors.push("索引色 PNG 缺少 PLTE");

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const validDepths = {
    0: new Set([1, 2, 4, 8, 16]),
    2: new Set([8, 16]),
    3: new Set([1, 2, 4, 8]),
    4: new Set([8, 16]),
    6: new Set([8, 16]),
  };
  if (!channels || !validDepths[colorType]?.has(bitDepth)) errors.push("PNG 色彩类型或位深组合无效");
  if (!width || !height) errors.push("PNG 像素尺寸无效");

  if (errors.length === 0) {
    const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
    const expectedDecodedBytes = (rowBytes + 1) * height;
    if (expectedDecodedBytes > MAX_DECODED_IMAGE_BYTES) {
      errors.push("PNG 解压后数据超过200MB上限");
    } else {
      try {
        const decoded = inflateSync(Buffer.concat(idatParts), {
          maxOutputLength: expectedDecodedBytes + 1,
        });
        if (decoded.length !== expectedDecodedBytes) {
          errors.push("PNG 解压像素长度与 IHDR 不一致");
        } else {
          for (let row = 0; row < height; row += 1) {
            if (decoded[row * (rowBytes + 1)] > 4) {
              errors.push(`PNG 第${row + 1}行过滤器无效`);
              break;
            }
          }
        }
      } catch {
        errors.push("PNG IDAT 像素流无法解压");
      }
    }
  }

  return {
    type: "png",
    width,
    height,
    hasExif,
    animated,
    valid: errors.length === 0,
    validationErrors: errors,
  };
}

function readJpegMetadata(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const sizeMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (sizeMarkers.has(marker) && length >= 7) {
      const sawSos = buffer.includes(Buffer.from([0xff, 0xda]));
      const sawEoi = buffer.length >= 2 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
      return {
        type: "jpeg",
        width: buffer.readUInt16BE(offset + 5),
        height: buffer.readUInt16BE(offset + 3),
        valid: sawSos && sawEoi,
        validationErrors: sawSos && sawEoi ? [] : ["JPEG 缺少 SOS 像素扫描或末尾 EOI"],
      };
    }
    offset += length;
  }
  return { type: "jpeg", width: null, height: null, valid: false, validationErrors: ["JPEG 缺少可识别 SOF"] };
}

export function inspectImageBuffer(buffer) {
  return readPngMetadata(buffer) ?? readJpegMetadata(buffer);
}

export function decodeJpegBuffer(buffer) {
  const executable = process.env.FFMPEG_PATH || "ffmpeg";
  const result = spawnSync(
    executable,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-xerror",
      "-err_detect",
      "explode",
      "-f",
      "image2pipe",
      "-c:v",
      "mjpeg",
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-f",
      "null",
      "-",
    ],
    {
      input: buffer,
      encoding: "buffer",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.error?.code === "ENOENT") {
    return {
      ok: false,
      error: "缺少预装 ffmpeg，不能对 JPEG 做真实像素解码；含 JPEG 的任务不得降级为仅结构校验",
    };
  }
  if (result.error) {
    return { ok: false, error: "JPEG 解码进程无法可靠完成" };
  }
  if (result.status !== 0) {
    return { ok: false, error: "JPEG 无法被 ffmpeg 完整解码" };
  }
  return { ok: true, error: null };
}

function expectedType(extension) {
  return extension === ".png" ? "png" : "jpeg";
}

export async function validateBrief(brief, options = {}) {
  const errors = [];
  const warnings = [];

  if (brief.schema_kind !== "source" || brief.schema_version !== 2) {
    errors.push('输入必须声明 schema_kind: "source" 和 schema_version: 2');
  }
  if ("privacy_actions" in brief) {
    errors.push("privacy_actions 是旧字段且无法证明已执行；请改用 privacy_review");
  }

  const name = String(brief.project_name ?? "");
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(name)) {
    errors.push("project_name 必须是1—48位英文小写、数字或短横线，且以字母或数字开头");
  }

  const rule = LIMITS[brief.function];
  if (!rule) errors.push("function 必须是 sticker、card 或 photo-story");

  const message = brief.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    errors.push("message 必须是对象");
  } else {
    const unknownMessageFields = Object.keys(message).filter(
      (field) => !["title", "subtitle", "signature"].includes(field),
    );
    if (unknownMessageFields.length) {
      errors.push(`message 含未知字段：${unknownMessageFields.join("、")}`);
    }
    const hasTitle = Object.prototype.hasOwnProperty.call(message, "title");
    if (hasTitle && typeof message.title !== "string") {
      errors.push("message.title 必须是字符串；photo-story 无标题时请省略或使用空字符串");
    }
    const title = typeof message.title === "string" ? message.title.trim() : "";
    if (brief.function !== "photo-story" && !title) {
      errors.push("sticker 和 card 的 message.title 不能为空");
    } else if (rule && [...title].length > rule.title) {
      errors.push(`${brief.function} 的标题最多 ${rule.title} 个字符`);
    }
    for (const [field, maximum] of [
      ["subtitle", 30],
      ["signature", 16],
    ]) {
      if (
        Object.prototype.hasOwnProperty.call(message, field) &&
        (typeof message[field] !== "string" || [...message[field]].length > maximum)
      ) {
        errors.push(`message.${field} 必须是最多${maximum}个字符的字符串`);
      }
    }
  }

  const privacy = brief.privacy_review;
  if (!privacy || typeof privacy !== "object" || Array.isArray(privacy)) {
    errors.push("privacy_review 必须是对象；未完成隐私检查不得生成工程");
  } else {
    if (!PRIVACY_STATUSES.has(privacy.status)) {
      errors.push(
        "privacy_review.status 必须是 reviewed-no-sensitive-content、user-confirmed-keep 或 source-already-redacted",
      );
    }
    if (!nonempty(privacy.confirmation)) {
      errors.push("privacy_review.confirmation 必须记录检查或用户确认依据");
    } else if ([...privacy.confirmation.trim()].length > 200) {
      errors.push("privacy_review.confirmation 最多200个字符");
    }
    if (!Array.isArray(privacy.actions)) {
      errors.push("privacy_review.actions 必须是数组");
    } else {
      if (privacy.actions.length > 10) errors.push("privacy_review.actions 最多10项");
      if (privacy.actions.some((item) => !nonempty(item))) {
        errors.push("privacy_review.actions 中每项都必须是非空文字");
      }
      if (privacy.actions.some((item) => nonempty(item) && [...item.trim()].length > 100)) {
        errors.push("privacy_review.actions 每项最多100个字符");
      }
      if (privacy.status === "source-already-redacted" && privacy.actions.length === 0) {
        errors.push("source-already-redacted 必须逐项记录素材在进入本 Skill 前已完成的脱敏动作");
      }
      if (privacy.status !== "source-already-redacted" && privacy.actions.length > 0) {
        errors.push("只有 source-already-redacted 可以记录 actions；本 Skill 不会自动遮挡或修图");
      }
    }
  }

  const media = Array.isArray(brief.media) ? brief.media : null;
  const approvedRoots = Array.isArray(brief.approved_media_roots) ? brief.approved_media_roots : null;
  if (!approvedRoots) errors.push("approved_media_roots 必须是数组");
  const resolvedRoots = [];
  let homePath = os.homedir();
  try {
    homePath = await realpath(homePath);
  } catch {
    // Keep the platform-provided home path for the broad-root guard.
  }
  if (approvedRoots) {
    if (approvedRoots.length > MAX_APPROVED_MEDIA_ROOTS) {
      errors.push(`approved_media_roots 最多 ${MAX_APPROVED_MEDIA_ROOTS} 项`);
    }
    for (const [index, root] of approvedRoots.slice(0, MAX_APPROVED_MEDIA_ROOTS).entries()) {
      if (!nonempty(root) || !path.isAbsolute(root)) {
        errors.push(`approved_media_roots[${index}] 必须是绝对路径`);
        continue;
      }
      try {
        const linkInfo = await lstat(root);
        if (linkInfo.isSymbolicLink()) {
          errors.push(`approved_media_roots[${index}] 不得是符号链接`);
          continue;
        }
        const info = await stat(root);
        if (!info.isDirectory()) {
          errors.push(`approved_media_roots[${index}] 不是目录`);
          continue;
        }
        const resolvedRoot = await realpath(root);
        const rootRelative = path.relative(path.parse(resolvedRoot).root, resolvedRoot);
        const rootSegments = rootRelative.split(path.sep).filter(Boolean);
        if (
          resolvedRoot === path.parse(resolvedRoot).root ||
          resolvedRoot === homePath ||
          BROAD_MEDIA_ROOTS.has(resolvedRoot) ||
          rootSegments.length <= 1
        ) {
          errors.push(
            `approved_media_roots[${index}] 范围过宽；不得授权系统根、用户主目录、单层顶级目录或公共系统父目录`,
          );
          continue;
        }
        resolvedRoots.push(resolvedRoot);
      } catch {
        errors.push(`approved_media_roots[${index}] 不存在`);
      }
    }
  }

  if (!media) {
    errors.push("media 必须是数组");
  } else if (rule && (media.length < rule.media[0] || media.length > rule.media[1])) {
    errors.push(`${brief.function} 需要 ${rule.media[0]}—${rule.media[1]} 个图片素材`);
  } else {
    const sourceIds = new Set();
    let totalMediaBytes = 0;
    for (const [index, item] of media.entries()) {
      const itemErrorStart = errors.length;
      const itemPath = item?.path;
      if (!nonempty(item?.source_id)) {
        errors.push(`media[${index}].source_id 不能为空`);
      } else if ([...item.source_id.trim()].length > 80) {
        errors.push(`media[${index}].source_id 最多80个字符`);
      } else if (sourceIds.has(item.source_id)) {
        errors.push(`media[${index}].source_id 重复：${item.source_id}`);
      } else {
        sourceIds.add(item.source_id);
      }
      if (item?.authorized !== true) {
        errors.push(`media[${index}] 必须显式设置 authorized: true`);
        // Authorization is a read gate, not merely a validation warning. Do
        // not touch the filesystem for an item the user did not authorize.
        continue;
      }
      if (item?.alt && [...String(item.alt)].length > 80) errors.push(`media[${index}].alt 最多80个字符`);
      if (!nonempty(itemPath) || !path.isAbsolute(itemPath)) {
        errors.push(`media[${index}].path 必须是绝对路径`);
        continue;
      }
      const extension = path.extname(itemPath).toLowerCase();
      if (!IMAGE_EXTS.has(extension)) {
        errors.push(`media[${index}] 只支持静态 JPEG/PNG；GIF、WebP、AVIF 等可能含动画或不可控元数据`);
        continue;
      }
      let mediaHandle = null;
      try {
        const linkInfo = await lstat(itemPath);
        if (linkInfo.isSymbolicLink()) {
          errors.push(`media[${index}] 不得是符号链接`);
          continue;
        }
        const resolved = await realpath(itemPath);
        const insideApprovedRoot = resolvedRoots.some((root) => {
          const relative = path.relative(root, resolved);
          return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
        });
        if (!insideApprovedRoot) {
          errors.push(`media[${index}] 不在 approved_media_roots 内`);
          // Never open or decode a path outside the explicitly approved roots.
          continue;
        }
        mediaHandle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const info = await mediaHandle.stat();
        if (info.dev !== linkInfo.dev || info.ino !== linkInfo.ino) {
          errors.push(`media[${index}] 在授权检查与打开之间被替换`);
          continue;
        }
        if (!info.isFile()) {
          errors.push(`media[${index}] 不是文件`);
          continue;
        }
        if (info.size > MAX_IMAGE_BYTES) {
          errors.push(`media[${index}] 超过25MB上限`);
          continue;
        }
        totalMediaBytes += info.size;
        if (totalMediaBytes > MAX_TOTAL_ASSET_BYTES) {
          errors.push("素材总大小超过300MB上限");
          continue;
        }
        const bounded = Buffer.alloc(info.size + 1);
        let bytesRead = 0;
        while (bytesRead < bounded.length) {
          const chunk = await mediaHandle.read(
            bounded,
            bytesRead,
            bounded.length - bytesRead,
            bytesRead,
          );
          if (!chunk.bytesRead) break;
          bytesRead += chunk.bytesRead;
        }
        if (bytesRead !== info.size) {
          errors.push(`media[${index}] 在有界读取期间发生变化`);
          continue;
        }
        const buffer = bounded.subarray(0, bytesRead);
        const after = await mediaHandle.stat();
        if (
          after.size !== info.size ||
          after.mtimeMs !== info.mtimeMs ||
          after.ctimeMs !== info.ctimeMs
        ) {
          errors.push(`media[${index}] 在读取期间发生变化`);
          continue;
        }
        const metadata = inspectImageBuffer(buffer);
        if (!metadata || metadata.type !== expectedType(extension)) {
          errors.push(`media[${index}] 扩展名与真实 JPEG/PNG 魔数不符`);
        } else if (metadata.valid === false) {
          errors.push(`media[${index}] 图片结构或像素流无效：${metadata.validationErrors.join("、")}`);
        } else if (!metadata.width || !metadata.height) {
          errors.push(`media[${index}] 无法读取像素尺寸`);
        } else {
          const dimensionsAllowed =
            metadata.width >= 64 &&
            metadata.height >= 64 &&
            metadata.width * metadata.height <= MAX_IMAGE_PIXELS;
          if (metadata.width < 64 || metadata.height < 64) errors.push(`media[${index}] 小于64×64像素`);
          if (metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
            errors.push(`media[${index}] 超过4000万像素上限`);
          }
          if (metadata.type === "jpeg" && dimensionsAllowed) {
            const decoded = decodeJpegBuffer(buffer);
            if (!decoded.ok) errors.push(`media[${index}] ${decoded.error}`);
          }
          if (metadata.type === "png" && metadata.hasExif) {
            errors.push(`media[${index}] 的 PNG 含 eXIf；请先导出为已扁平化 PNG，避免清除元数据后方向变化`);
          }
          if (errors.length === itemErrorStart && typeof options.onValidatedMedia === "function") {
            await options.onValidatedMedia({
              index,
              item,
              resolvedPath: resolved,
              extension,
              buffer,
              metadata,
            });
          }
        }
      } catch (error) {
        errors.push(`media[${index}] 文件不存在、无法读取或无法安全处理：${error.message}`);
      } finally {
        await mediaHandle?.close().catch(() => {});
      }
    }
  }

  const duration = Number(brief.duration_seconds);
  if (!Number.isFinite(duration) || (rule && (duration < rule.duration[0] || duration > rule.duration[1]))) {
    errors.push(rule ? `${brief.function} 时长必须在 ${rule.duration[0]}—${rule.duration[1]} 秒` : "duration_seconds 无效");
  }
  if (brief.function === "photo-story" && media && Number.isFinite(duration) && duration < media.length * 1.2) {
    errors.push(`photo-story 每张图片至少停留1.2秒；${media.length}张图片需要至少 ${(media.length * 1.2).toFixed(1)} 秒`);
  }
  if (!RATIOS.has(brief.aspect_ratio)) errors.push("aspect_ratio 必须是 1:1、9:16 或 16:9");
  if (!FORMATS.has(brief.output_format)) errors.push("output_format 必须是 mp4 或 gif");
  if (!STYLES.has(brief.style)) errors.push("style 必须是 warm、playful、clean 或 energetic");
  if (typeof brief.loop !== "boolean") errors.push("loop 必须是布尔值");
  if (brief.function === "sticker" && brief.loop !== true) warnings.push("动态表情通常应设置 loop=true");
  if (!nonempty(brief.use_case)) errors.push("use_case 不能为空");
  else if ([...brief.use_case.trim()].length > 30) errors.push("use_case 最多30个字符");
  if (!Array.isArray(brief.facts_to_preserve)) {
    errors.push("facts_to_preserve 必须是数组");
  } else {
    if (brief.facts_to_preserve.length > 20) errors.push("facts_to_preserve 最多20项");
    if (brief.facts_to_preserve.some((item) => !nonempty(item) || [...item.trim()].length > 120)) {
      errors.push("facts_to_preserve 每项必须是1—120个字符");
    }
  }
  if (brief.output_format === "gif" && duration > 6) warnings.push("GIF 超过6秒可能过大，优先缩短或改用MP4");
  return { errors, warnings };
}

export async function main(argv = process.argv.slice(2)) {
  const input = argv[0];
  if (!input) {
    console.error("用法：node scripts/validate_brief.mjs <source-brief.json>");
    return 2;
  }
  try {
    const brief = await loadBrief(input);
    const { errors, warnings } = await validateBrief(brief);
    warnings.forEach((item) => console.log(`警告：${item}`));
    errors.forEach((item) => console.error(`错误：${item}`));
    if (errors.length) {
      console.error(`结果：不通过，共 ${errors.length} 个错误`);
      return 1;
    }
    console.log(`结果：通过（${brief.function}，${brief.duration_seconds}秒，${brief.aspect_ratio}）`);
    return 0;
  } catch (error) {
    console.error(`校验失败：${error.message}`);
    return 2;
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  process.exitCode = await main();
}

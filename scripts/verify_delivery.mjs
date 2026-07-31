#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateDeliveryBriefContract } from "./delivery_brief_contract.mjs";

const SUPPORTED_FORMATS = new Set([".mp4", ".gif"]);
const MAX_BRIEF_BYTES = 512 * 1024;
const MAX_MP4_BYTES = 512 * 1024 * 1024;
const MAX_GIF_BYTES = 64 * 1024 * 1024;
const ASPECT_RATIOS = { "1:1": 1, "9:16": 9 / 16, "16:9": 16 / 9 };
const MP4_DIMENSIONS = {
  "1:1": [1080, 1080],
  "9:16": [1080, 1920],
  "16:9": [1920, 1080],
};
const GIF_DIMENSIONS = {
  "1:1": [512, 512],
  "9:16": [512, 910],
  "16:9": [512, 288],
};
const PRIVACY_STATUSES = new Set([
  "reviewed-no-sensitive-content",
  "user-confirmed-keep",
  "source-already-redacted",
]);
const FUNCTION_LIMITS = {
  sticker: { duration: [2, 6], media: [0, 1] },
  card: { duration: [4, 10], media: [0, 1] },
  "photo-story": { duration: [6, 30], media: [3, 12] },
};

function requireFinitePositive(value, label, errors) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) errors.push(`${label} 必须是正数`);
  return number;
}

function parseFrameRate(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : NaN;
  if (typeof value !== "string" || !value.trim()) return NaN;
  const [numeratorText, denominatorText, ...rest] = value.trim().split("/");
  if (rest.length) return NaN;
  const numerator = Number(numeratorText);
  const denominator = denominatorText === undefined ? 1 : Number(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) {
    return NaN;
  }
  return numerator / denominator;
}

async function inspectGifLoop(filePath) {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let position = 0;
  const info = await handle.stat();
  const readExact = async (length) => {
    if (!Number.isInteger(length) || length < 0 || position + length > info.size) {
      throw new Error("GIF block 越界");
    }
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
      if (!bytesRead) throw new Error("GIF block 提前结束");
      filled += bytesRead;
    }
    position += length;
    return buffer;
  };
  const readByte = async () => (await readExact(1))[0];
  const skip = (length) => {
    if (!Number.isInteger(length) || length < 0 || position + length > info.size) {
      throw new Error("GIF block 越界");
    }
    position += length;
  };
  const skipSubBlocks = async () => {
    while (true) {
      const length = await readByte();
      if (length === 0) return;
      skip(length);
    }
  };
  try {
    const header = (await readExact(6)).toString("ascii");
    if (header !== "GIF87a" && header !== "GIF89a") throw new Error("GIF header 无效");
    const logicalScreen = await readExact(7);
    if (logicalScreen[4] & 0x80) {
      skip(3 * 2 ** ((logicalScreen[4] & 0x07) + 1));
    }
    while (true) {
      const introducer = await readByte();
      if (introducer === 0x3b) {
        if (position !== info.size) throw new Error("GIF trailer 后含多余数据");
        return { found: false, valid: true, count: null };
      }
      if (introducer === 0x2c) {
        const descriptor = await readExact(9);
        if (descriptor[8] & 0x80) {
          skip(3 * 2 ** ((descriptor[8] & 0x07) + 1));
        }
        await readByte();
        await skipSubBlocks();
        continue;
      }
      if (introducer !== 0x21) throw new Error(`GIF block introducer 无效：0x${introducer.toString(16)}`);
      const label = await readByte();
      if (label !== 0xff) {
        await skipSubBlocks();
        continue;
      }
      const identifierLength = await readByte();
      const identifier = (await readExact(identifierLength)).toString("ascii");
      if (identifierLength !== 11 || identifier !== "NETSCAPE2.0") {
        await skipSubBlocks();
        continue;
      }
      const loopBlockLength = await readByte();
      if (loopBlockLength === 0) return { found: true, valid: false, count: null };
      const loopBlock = await readExact(loopBlockLength);
      const valid = loopBlockLength === 3 && loopBlock[0] === 0x01;
      await skipSubBlocks();
      return {
        found: true,
        valid,
        count: valid ? loopBlock.readUInt16LE(1) : null,
      };
    }
  } finally {
    await handle.close();
  }
}

export async function verifyDelivery(artifact, briefPath, options = {}) {
  const errors = [];
  let info = null;
  let artifactPassedSizeGate = false;
  if (!artifact) errors.push("必须提供媒体产物路径");
  if (!briefPath) errors.push("必须提供 delivery-brief.json，不能只检查媒体文件");

  const ext = artifact ? path.extname(artifact).toLowerCase() : "";
  if (artifact) {
    try {
      info = await lstat(artifact);
      if (info.isSymbolicLink()) {
        errors.push("产物不得是符号链接");
      } else if (!info.isFile()) {
        errors.push("产物路径不是文件");
      } else {
        if (info.size < 1024) {
          errors.push("产物小于 1KB，疑似空文件");
        } else {
          const sizeLimit = ext === ".gif" ? MAX_GIF_BYTES : MAX_MP4_BYTES;
          if (info.size > sizeLimit) {
            errors.push(
              `产物超过${ext === ".gif" ? "64MB GIF" : "512MB MP4"}验收上限，拒绝交给 ffprobe 或结构解析器读取`,
            );
          } else {
            artifactPassedSizeGate = true;
          }
        }
      }
    } catch {
      errors.push(`产物不存在：${artifact}`);
    }
  }

  if (artifact && !SUPPORTED_FORMATS.has(ext)) {
    errors.push(`媒体交付只接受 MP4 或 GIF，不接受：${ext || "无扩展名"}`);
  }

  let brief = null;
  if (briefPath) {
    let briefHandle = null;
    try {
      briefHandle = await open(briefPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const briefInfo = await briefHandle.stat();
      if (!briefInfo.isFile()) throw new Error("不是普通文件");
      if (briefInfo.size > MAX_BRIEF_BYTES) {
        throw new Error("超过512KB上限，拒绝读取");
      }
      const bounded = Buffer.alloc(MAX_BRIEF_BYTES + 1);
      const { bytesRead } = await briefHandle.read(bounded, 0, bounded.length, 0);
      if (bytesRead > MAX_BRIEF_BYTES) throw new Error("读取期间增长并超过512KB上限");
      const after = await briefHandle.stat();
      if (
        bytesRead !== briefInfo.size ||
        after.size !== briefInfo.size ||
        after.mtimeMs !== briefInfo.mtimeMs ||
        after.ctimeMs !== briefInfo.ctimeMs
      ) {
        throw new Error("delivery brief 在读取期间发生变化");
      }
      brief = JSON.parse(bounded.subarray(0, bytesRead).toString("utf8"));
      if (!brief || typeof brief !== "object" || Array.isArray(brief)) {
        errors.push("delivery brief 根节点必须是对象");
        brief = null;
      }
    } catch (error) {
      errors.push(`无法读取 delivery brief：${error.message}`);
    } finally {
      await briefHandle?.close();
    }
  }

  let expectedDuration = NaN;
  if (brief) {
    errors.push(...validateDeliveryBriefContract(brief, { label: "delivery brief" }));
    if (brief.schema_kind !== "delivery" || brief.schema_version !== 2) {
      errors.push('delivery brief 必须声明 schema_kind: "delivery" 和 schema_version: 2');
    }
    const privacy = brief.privacy_review;
    if (!privacy || typeof privacy !== "object" || Array.isArray(privacy)) {
      errors.push("delivery brief.privacy_review 必须是对象");
    } else {
      if (!PRIVACY_STATUSES.has(privacy.status)) errors.push("delivery brief.privacy_review.status 无效");
      if (!Array.isArray(privacy.actions) || privacy.actions.some((item) => typeof item !== "string" || !item.trim())) {
        errors.push("delivery brief.privacy_review.actions 必须是非空文字组成的数组（可为空数组）");
      }
      if (privacy.image_metadata !== "sensitive-stripped-orientation-preserved") {
        errors.push(
          'delivery brief.privacy_review.image_metadata 必须是 "sensitive-stripped-orientation-preserved"',
        );
      }
      if (privacy.status === "source-already-redacted" && privacy.actions?.length === 0) {
        errors.push("source-already-redacted 必须记录已完成的脱敏动作");
      }
      if (privacy.status !== "source-already-redacted" && privacy.actions?.length > 0) {
        errors.push("只有 source-already-redacted 可以包含 privacy_review.actions");
      }
    }
    const functionRule = FUNCTION_LIMITS[brief.function];
    if (!functionRule) errors.push("delivery brief.function 必须是 sticker、card 或 photo-story");
    if (!Array.isArray(brief.media)) {
      errors.push("delivery brief.media 必须是数组");
    } else if (
      functionRule &&
      (brief.media.length < functionRule.media[0] || brief.media.length > functionRule.media[1])
    ) {
      errors.push(`${brief.function} 需要 ${functionRule.media[0]}—${functionRule.media[1]} 个图片素材`);
    }
    if (!["mp4", "gif"].includes(brief.output_format)) {
      errors.push("delivery brief 的 output_format 必须是 mp4 或 gif");
    } else if (ext && ext !== `.${brief.output_format}`) {
      errors.push(`产物扩展名 ${ext} 与 delivery brief 的 output_format ${brief.output_format} 不符`);
    }
    expectedDuration = requireFinitePositive(brief.duration_seconds, "delivery brief.duration_seconds", errors);
    if (
      functionRule &&
      Number.isFinite(expectedDuration) &&
      (expectedDuration < functionRule.duration[0] || expectedDuration > functionRule.duration[1])
    ) {
      errors.push(`${brief.function} 时长必须在 ${functionRule.duration[0]}—${functionRule.duration[1]} 秒`);
    }
    if (!(brief.aspect_ratio in ASPECT_RATIOS)) {
      errors.push("delivery brief.aspect_ratio 必须是 1:1、9:16 或 16:9");
    }
    if (typeof brief.loop !== "boolean") errors.push("delivery brief.loop 必须是布尔值");
  }

  if (SUPPORTED_FORMATS.has(ext) && info?.isFile() && artifactPassedSizeGate) {
    const probeCommand = options.ffprobeCommand || process.env.FFPROBE_PATH || "ffprobe";
    const run = options.spawnSync || spawnSync;
    const probe = run(
      probeCommand,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration,format_name:stream=index,codec_type,width,height,codec_name,pix_fmt,r_frame_rate,avg_frame_rate",
        "-of",
        "json",
        artifact,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    if (probe.error?.code === "ENOENT") {
      errors.push(`未找到 ffprobe（${probeCommand}）；媒体交付不能在缺少探测器时通过`);
    } else if (probe.error) {
      errors.push(`ffprobe 启动失败：${probe.error.message}`);
    } else if (probe.status !== 0) {
      errors.push(`ffprobe 读取失败：${(probe.stderr || "").trim() || `退出码 ${probe.status}`}`);
    } else {
      try {
        const data = JSON.parse(probe.stdout);
        const streams = Array.isArray(data.streams) ? data.streams : [];
        const stream = streams.length === 1 ? streams[0] : null;
        const duration = Number(data.format?.duration);
        if (streams.length !== 1) {
          const types = streams.map((item) => String(item?.codec_type || "unknown")).join("、") || "无";
          errors.push(`产物必须恰好包含一个 video stream；实际 ${streams.length} 个 stream（${types}）`);
        } else if (stream.codec_type !== "video") {
          errors.push(`唯一 stream 必须是 video，不能是 ${stream.codec_type || "unknown"}`);
        } else if (!Number.isInteger(Number(stream.width)) || !Number.isInteger(Number(stream.height))) {
          errors.push("唯一 video stream 缺少有效整数尺寸");
        } else {
          const formatNames = String(data.format?.format_name || "").split(",");
          const frameRate = parseFrameRate(stream.r_frame_rate);
          const averageFrameRate = parseFrameRate(stream.avg_frame_rate);
          if (ext === ".gif") {
            if (!formatNames.includes("gif")) errors.push("扩展名为 GIF，但探测到的容器不是 GIF");
            if (stream.codec_name !== "gif") errors.push("GIF 只接受 gif codec");
            if (!Number.isFinite(frameRate) || Math.abs(frameRate - 12) > 0.01) {
              errors.push(`GIF r_frame_rate 必须为12fps；实际 ${stream.r_frame_rate || "缺失"}`);
            }
            if (!Number.isFinite(averageFrameRate) || averageFrameRate < 11.5 || averageFrameRate > 12.5) {
              errors.push(`GIF 平均帧率必须在11.5–12.5fps；实际 ${stream.avg_frame_rate || "缺失"}`);
            }
          }
          if (ext === ".mp4") {
            if (!formatNames.includes("mp4")) errors.push("扩展名为 MP4，但探测到的容器不是 MP4");
            if (stream.codec_name !== "h264") errors.push(`MP4 只接受 h264 codec；实际 ${stream.codec_name || "缺失"}`);
            if (stream.pix_fmt !== "yuv420p") {
              errors.push(`MP4 只接受 yuv420p 像素格式；实际 ${stream.pix_fmt || "缺失"}`);
            }
            if (!Number.isFinite(frameRate) || Math.abs(frameRate - 30) > 0.01) {
              errors.push(`MP4 r_frame_rate 必须为30fps；实际 ${stream.r_frame_rate || "缺失"}`);
            }
            if (!Number.isFinite(averageFrameRate) || Math.abs(averageFrameRate - 30) > 0.01) {
              errors.push(`MP4 平均帧率必须为30fps；实际 ${stream.avg_frame_rate || "缺失"}`);
            }
          }
          if (brief?.aspect_ratio) {
            const expectedRatio = ASPECT_RATIOS[brief.aspect_ratio];
            if (expectedRatio && Math.abs(stream.width / stream.height - expectedRatio) > 0.02) {
              errors.push(`实际画幅 ${stream.width}×${stream.height} 与 delivery brief 的 ${brief.aspect_ratio} 不符`);
            }
            const expectedDimensions =
              ext === ".gif" ? GIF_DIMENSIONS[brief.aspect_ratio] : MP4_DIMENSIONS[brief.aspect_ratio];
            if (
              expectedDimensions &&
              (Number(stream.width) !== expectedDimensions[0] || Number(stream.height) !== expectedDimensions[1])
            ) {
              errors.push(
                `实际尺寸 ${stream.width}×${stream.height} 与 ${ext === ".gif" ? "GIF优化" : "MP4"}契约 ` +
                  `${expectedDimensions[0]}×${expectedDimensions[1]} 不符`,
              );
            }
          }
        }
        if (!Number.isFinite(duration) || duration <= 0) {
          errors.push("ffprobe 未返回有效时长");
        } else if (Number.isFinite(expectedDuration) && Math.abs(duration - expectedDuration) > 0.25) {
          errors.push(`实际时长 ${duration.toFixed(2)} 秒与 delivery brief 的 ${expectedDuration} 秒不符`);
        }
      } catch (error) {
        errors.push(`ffprobe 输出不是有效 JSON：${error.message}`);
      }
    }
  }

  if (
    ext === ".gif" &&
    typeof brief?.loop === "boolean" &&
    info?.isFile() &&
    artifactPassedSizeGate
  ) {
    try {
      const loop = await inspectGifLoop(artifact);
      if (brief.loop === true && (!loop.found || !loop.valid || loop.count !== 0)) {
        errors.push("delivery brief 要求循环，但 GIF 未声明无限循环");
      }
      if (brief.loop === false && loop.found) {
        errors.push("delivery brief 要求非循环，但 GIF 含循环扩展声明");
      }
    } catch (error) {
      errors.push(`无法检查 GIF 循环声明：${error.message}`);
    }
  }

  return { ok: errors.length === 0, errors, size: info?.size ?? 0 };
}

export async function runCli(argv = process.argv.slice(2)) {
  const [artifact, briefPath] = argv;
  if (!artifact || !briefPath) {
    console.error("用法：node scripts/verify_delivery.mjs <final.mp4|final.gif> <delivery-brief.json>");
    return 2;
  }
  const result = await verifyDelivery(artifact, briefPath);
  result.errors.forEach((item) => console.error(`错误：${item}`));
  if (!result.ok) {
    console.error(`结果：不通过，共 ${result.errors.length} 个错误`);
    return 1;
  }
  console.log(`结果：通过（${path.basename(artifact)}，${result.size} bytes）`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await runCli();

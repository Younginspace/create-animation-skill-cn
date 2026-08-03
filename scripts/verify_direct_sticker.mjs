#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectImageBuffer } from "./validate_brief.mjs";
import { inspectGifLoop } from "./verify_delivery.mjs";
import { probeMedia, readStableJson, sha256File } from "./direct_sticker_common.mjs";

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function parseRate(value) {
  if (typeof value !== "string") return null;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

function containsAbsolutePath(value) {
  if (typeof value !== "string") return false;
  if (/file:\/\//iu.test(value)) return true;
  const candidates = value.split(/[\s"'`=,，。；：！？、()（）\[\]【】{}<>]+/u);
  return candidates.some((candidate) => {
    const cleaned = candidate.replace(/[.:;!?]+$/u, "");
    return cleaned.length > 1 && (path.posix.isAbsolute(cleaned) || path.win32.isAbsolute(cleaned));
  });
}

function walkStrings(value, visit) {
  if (typeof value === "string") return visit(value);
  if (Array.isArray(value)) return value.forEach((item) => walkStrings(item, visit));
  if (value && typeof value === "object") Object.values(value).forEach((item) => walkStrings(item, visit));
}

async function stageArtifactForVerification(filePath, outputFormat) {
  const linkInfo = await lstat(filePath);
  if (linkInfo.isSymbolicLink()) throw new Error("产物不得是符号链接");
  const input = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let directory = null;
  let output = null;
  try {
    const info = await input.stat();
    if (info.dev !== linkInfo.dev || info.ino !== linkInfo.ino) throw new Error("产物在检查与打开之间被替换");
    if (!info.isFile() || info.size <= 0 || info.size > 64 * 1024 * 1024) throw new Error("产物大小无效");
    directory = await mkdtemp(path.join(os.tmpdir(), "create-animation-direct-verify-"));
    await chmod(directory, 0o700);
    const stagedPath = path.join(directory, `artifact.${outputFormat}`);
    output = await open(stagedPath, "wx", 0o600);
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < info.size) {
      const { bytesRead } = await input.read(chunk, 0, Math.min(chunk.length, info.size - offset), offset);
      if (!bytesRead) break;
      await output.write(chunk, 0, bytesRead, offset);
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    await output.sync();
    const after = await input.stat();
    if (
      offset !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs || after.dev !== info.dev || after.ino !== info.ino
    ) throw new Error("产物在复制期间发生变化");
    await output.close();
    output = null;
    return {
      stagedPath,
      size: info.size,
      sha256: hash.digest("hex"),
      cleanup: async () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await output?.close().catch(() => {});
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await input.close();
  }
}

function pngSensitiveChunks(buffer) {
  const found = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    if (["tEXt", "zTXt", "iTXt", "eXIf", "tIME"].includes(type)) found.push(type);
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return found;
}

async function verifyVisualApproval(approvalPath, deliveryBriefPath, brief, errors) {
  try {
    if (path.dirname(path.resolve(approvalPath)) !== path.dirname(path.resolve(deliveryBriefPath))) {
      throw new Error("visual approval 必须与 delivery brief 位于同一工程根目录");
    }
    const approval = await readStableJson(approvalPath, "visual approval", 64 * 1024);
    if (approval.schema_kind !== "direct-sticker-visual-approval" || approval.schema_version !== 1) {
      throw new Error("visual approval schema 无效");
    }
    if (approval.project_name !== brief.project_name || approval.output_sha256 !== brief.output?.sha256) {
      throw new Error("visual approval 未绑定当前工程与成品摘要");
    }
    const deliverySha256 = await sha256File(deliveryBriefPath, 256 * 1024);
    if (!/^[a-f0-9]{64}$/.test(approval.delivery_sha256 || "") || approval.delivery_sha256 !== deliverySha256) {
      throw new Error("visual approval 未绑定当前 delivery brief 摘要");
    }
    const expected = brief.output_format === "gif"
      ? ["previews/start.png", "previews/middle.png", "previews/end.png"]
      : ["previews/final.png"];
    if (!Array.isArray(approval.reviewed_checks) || approval.reviewed_checks.length < 4) {
      throw new Error("visual approval 缺少完整人工检查项");
    }
    for (const relative of expected) {
      const recorded = approval.preview_sha256?.[relative];
      if (!/^[a-f0-9]{64}$/.test(recorded || "")) throw new Error(`visual approval 缺少 ${relative} 摘要`);
      const actual = await sha256File(path.join(path.dirname(approvalPath), relative), 16 * 1024 * 1024);
      if (actual !== recorded) throw new Error(`${relative} 已在视觉批准后变化`);
    }
  } catch (error) {
    errors.push(`视觉批准无效：${error.message}`);
  }
}

export async function verifyDirectSticker(artifactPath, deliveryBriefPath, approvalPath = null) {
  const errors = [];
  let brief;
  try {
    brief = await readStableJson(deliveryBriefPath, "delivery brief", 256 * 1024);
  } catch (error) {
    return { ok: false, errors: [`delivery brief 无法读取：${error.message}`] };
  }
  if (brief.schema_kind !== "direct-sticker-delivery" || brief.schema_version !== 1) {
    errors.push('delivery brief 必须声明 schema_kind: "direct-sticker-delivery" 和 schema_version: 1');
  }
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(brief.project_name || "")) errors.push("project_name 无效");
  if (!new Set(["video", "image"]).has(brief.source?.kind)) errors.push("source.kind 无效");
  if (typeof brief.source?.source_id !== "string" || !brief.source.source_id.trim()) errors.push("source.source_id 无效");
  if (!/^[a-f0-9]{64}$/.test(brief.source?.sha256 || "")) errors.push("source.sha256 无效");
  if (typeof brief.message?.title !== "string" || !brief.message.title.trim()) errors.push("message.title 无效");
  if (brief.aspect_ratio !== "1:1") errors.push("aspect_ratio 必须是1:1");
  if (!new Set(["gif", "png"]).has(brief.output_format)) errors.push("output_format 必须是 gif 或 png");
  if (brief.output_format === "gif" && brief.loop !== true) errors.push("GIF 必须 loop: true");
  if (brief.output_format === "png" && brief.loop !== false) errors.push("PNG 必须 loop: false");
  if (!new Set(["top", "bottom"]).has(brief.text_position)) errors.push("text_position 无效");
  if (!new Set(["center", "top", "bottom", "left", "right"]).has(brief.crop_anchor)) errors.push("crop_anchor 无效");
  if (brief.clip?.mode === "visual-query" && !/^[a-f0-9]{64}$/.test(brief.clip.selection_index_sha256 || "")) {
    errors.push("visual-query delivery 缺少联系表摘要");
  }
  if (brief.clip?.mode === "visual-query") {
    if (brief.clip.selection_index_path !== "evidence/selection-index.json") {
      errors.push("visual-query delivery 联系表路径必须是 evidence/selection-index.json");
    } else {
      try {
        const selection = await readStableJson(
          path.join(path.dirname(deliveryBriefPath), brief.clip.selection_index_path),
          "交付联系表索引",
          256 * 1024,
        );
        const digest = createHash("sha256").update(JSON.stringify(selection)).digest("hex");
        if (digest !== brief.clip.selection_index_sha256) errors.push("交付联系表索引摘要与 delivery 不一致");
        if (!Array.isArray(selection.sheets) || selection.sheets.length < 1 || selection.sheets.length > 4) {
          errors.push("交付联系表索引缺少像素摘要");
        } else {
          for (let sheetIndex = 0; sheetIndex < selection.sheets.length; sheetIndex += 1) {
            const sheet = selection.sheets[sheetIndex];
            const expectedPath = `selection/sheet-${String(sheetIndex + 1).padStart(2, "0")}.jpg`;
            if (sheet?.path !== expectedPath || !/^[a-f0-9]{64}$/.test(sheet.sha256 || "")) {
              errors.push("交付联系表索引中的路径或摘要无效");
              continue;
            }
            try {
              const sheetPath = path.join(path.dirname(deliveryBriefPath), "evidence", sheet.path);
              const relative = path.relative(path.join(path.dirname(deliveryBriefPath), "evidence"), sheetPath);
              if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("联系表路径越界");
              const actual = await sha256File(sheetPath, 16 * 1024 * 1024);
              if (actual !== sheet.sha256) errors.push(`${sheet.path} 与交付索引摘要不一致`);
            } catch (error) {
              errors.push(`交付联系表像素无效：${error.message}`);
            }
          }
        }
      } catch (error) {
        errors.push(`交付联系表索引无效：${error.message}`);
      }
    }
  }
  if (!brief.privacy_review || typeof brief.privacy_review !== "object") errors.push("privacy_review 缺失");
  walkStrings(brief, (value) => {
    if (containsAbsolutePath(value)) errors.push("delivery brief 不得包含绝对路径");
  });

  const extension = path.extname(artifactPath).toLowerCase();
  if (extension !== `.${brief.output_format}`) errors.push("产物扩展名与 delivery brief 不一致");
  let staged = null;
  try {
    staged = await stageArtifactForVerification(artifactPath, brief.output_format);
  } catch (error) {
    errors.push(`产物无法读取：${error.message}`);
  }
  if (staged) {
    try {
      if (staged.sha256 !== brief.output?.sha256) errors.push("产物 SHA-256 与 delivery brief 不一致");
      const probe = probeMedia(staged.stagedPath);
      const streams = Array.isArray(probe.streams) ? probe.streams : [];
      const metadataEntries = [
        ...Object.entries(probe.format?.tags || {}),
        ...streams.flatMap((stream) => Object.entries(stream.tags || {})),
      ];
      const unexpectedMetadata = metadataEntries.filter(([key, value]) =>
        !(String(key).toLowerCase() === "comment" && value === "create-animation direct sticker") &&
        String(key).toLowerCase() !== "encoder");
      if (unexpectedMetadata.length) errors.push("产物包含未授权 metadata tags");
      if (streams.length !== 1 || streams[0]?.codec_type !== "video") {
        errors.push("产物必须恰好包含一个视频流且不得含音频、字幕、数据或附件流");
      } else {
        const stream = streams[0];
        if (Number(stream.width) !== 512 || Number(stream.height) !== 512) errors.push("产物必须是512×512");
        if (brief.output_format === "gif") {
          if (stream.codec_name !== "gif") errors.push("GIF 产物 codec 必须是 gif");
          const rate = parseRate(stream.avg_frame_rate) ?? parseRate(stream.r_frame_rate);
          if (!Number.isFinite(rate) || Math.abs(rate - 12) > 0.05) errors.push("GIF 必须是12fps");
          const duration = Number(probe.format?.duration ?? stream.duration);
          if (!Number.isFinite(duration) || Math.abs(duration - brief.duration_seconds) > 0.2) {
            errors.push("GIF 时长与 delivery brief 不一致");
          }
          const loop = await inspectGifLoop(staged.stagedPath);
          if (!loop.found || !loop.valid || loop.count !== 0) errors.push("GIF 缺少合法的无限循环扩展");
        } else {
          if (stream.codec_name !== "png") errors.push("PNG 产物 codec 必须是 png");
          const buffer = await readFile(staged.stagedPath);
          const metadata = inspectImageBuffer(buffer);
          if (!metadata || metadata.type !== "png" || metadata.valid === false) errors.push("PNG 像素流无效");
          const sensitiveChunks = pngSensitiveChunks(buffer);
          if (sensitiveChunks.length) errors.push(`PNG 不得包含敏感 ancillary chunks：${sensitiveChunks.join("、")}`);
        }
      }
    } catch (error) {
      errors.push(`产物探测失败：${error.message}`);
    } finally {
      await staged.cleanup();
    }
  }
  if (!finite(brief.duration_seconds)) errors.push("duration_seconds 必须是有限数字");
  if (approvalPath) await verifyVisualApproval(approvalPath, deliveryBriefPath, brief, errors);
  return { ok: errors.length === 0, errors };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3) {
    console.error("用法：node scripts/verify_direct_sticker.mjs <产物路径> <delivery-brief.json> <visual-approval.json>");
    process.exit(2);
  }
  const result = await verifyDirectSticker(path.resolve(argv[0]), path.resolve(argv[1]), path.resolve(argv[2]));
  if (!result.ok) {
    console.error(`验证失败：\n- ${result.errors.join("\n- ")}`);
    process.exit(1);
  }
  console.log("结果：通过（direct sticker 产物、尺寸、帧率、循环、隐私与摘要闭环）");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`验证失败：${error.message}`);
    process.exit(1);
  });
}

#!/usr/bin/env node
import { constants } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOutputProject,
  escapeFilterPath,
  inspectSourceProbe,
  probeMedia,
  readDirectBrief,
  requireDirectFfmpegFeatures,
  resolveFontPath,
  resolvedClipRange,
  runCommand,
  sha256File,
  stageAuthorizedSource,
  validateDirectBriefShape,
  verifySemanticSelectionEvidence,
  writeJsonExclusive,
} from "./direct_sticker_common.mjs";
import { verifyDirectSticker } from "./verify_direct_sticker.mjs";

const STYLE_TOKENS = {
  warm: { font: "0xFFF0D9", border: "0x54250D", box: "0x1A0B05@0.44" },
  playful: { font: "0xFFF45C", border: "0x111111", box: "0x111111@0.40" },
  clean: { font: "0xFFFFFF", border: "0x111111", box: "0x111111@0.34" },
  energetic: { font: "0xFFEA45", border: "0x090909", box: "0x090909@0.48" },
};

function titleLayout(text) {
  const characters = [...text];
  const lines = characters.length <= 8
    ? [characters.join("")]
    : [
        characters.slice(0, Math.ceil(characters.length / 2)).join(""),
        characters.slice(Math.ceil(characters.length / 2)).join(""),
      ];
  const maximum = Math.max(...lines.map((line) => [...line].length));
  const fontSize = maximum <= 4 ? 88 : maximum <= 6 ? 66 : 50;
  return { text: lines.join("\n"), fontSize };
}

function drawTextFilter(brief, fontPath, textFile, fontSize) {
  const tokens = STYLE_TOKENS[brief.style];
  const y = brief.text_position === "top" ? "54" : "h-text_h-58";
  return [
    `drawtext=fontfile='${escapeFilterPath(fontPath)}'`,
    `textfile='${escapeFilterPath(textFile)}'`,
    `fontcolor=${tokens.font}`,
    `fontsize=${fontSize}`,
    `borderw=${Math.max(4, Math.round(fontSize * 0.075))}`,
    `bordercolor=${tokens.border}`,
    "box=1",
    `boxcolor=${tokens.box}`,
    `boxborderw=${Math.max(16, Math.round(fontSize * 0.24))}`,
    `line_spacing=${Math.max(6, Math.round(fontSize * 0.15))}`,
    "x=(w-text_w)/2",
    `y=${y}`,
    "alpha='0.96+0.04*sin(2*PI*t)'",
  ].join(":");
}

function cropPosition(anchor) {
  const positions = {
    center: ["(iw-512)/2", "(ih-512)/2"],
    top: ["(iw-512)/2", "0"],
    bottom: ["(iw-512)/2", "ih-512"],
    left: ["0", "(ih-512)/2"],
    right: ["iw-512", "(ih-512)/2"],
  };
  return positions[anchor];
}

function baseVideoFilter(brief, fontPath, textFile, fontSize) {
  const [cropX, cropY] = cropPosition(brief.crop_anchor);
  const filters = [
    "scale=512:512:force_original_aspect_ratio=increase",
    `crop=512:512:${cropX}:${cropY}`,
    "setsar=1",
  ];
  if (brief.output_format === "gif") filters.push("fps=12");
  filters.push(drawTextFilter(brief, fontPath, textFile, fontSize));
  return filters.join(",");
}

function deliveryBrief(brief, staged, inspected, clip, outputSha256, selectionEvidence) {
  return {
    schema_kind: "direct-sticker-delivery",
    schema_version: 1,
    project_name: brief.project_name,
    renderer: "ffmpeg-direct-sticker-v1",
    source: {
      source_id: brief.source.source_id,
      kind: brief.source.kind,
      alt: brief.source.alt || "用户本轮授权的表情素材",
      sha256: staged.sourceSha256,
      bytes: staged.sourceBytes,
      original_codec: inspected.codec,
      original_width: inspected.width,
      original_height: inspected.height,
      audio_removed: inspected.hasAudio,
    },
    clip: clip
      ? {
          mode: brief.clip.mode,
          query: brief.clip.mode === "visual-query" ? brief.clip.query : undefined,
          evidence_samples:
            brief.clip.mode === "visual-query" ? brief.clip.evidence_samples : undefined,
          selection_index_sha256:
            brief.clip.mode === "visual-query" ? selectionEvidence?.digest : undefined,
          selection_index_path:
            brief.clip.mode === "visual-query" ? "evidence/selection-index.json" : undefined,
          start_seconds: clip.start,
          end_seconds: clip.end,
        }
      : undefined,
    message: { title: brief.message.title },
    use_case: brief.use_case,
    aspect_ratio: brief.aspect_ratio,
    duration_seconds: brief.duration_seconds,
    output_format: brief.output_format,
    style: brief.style,
    text_position: brief.text_position,
    crop_anchor: brief.crop_anchor,
    loop: brief.loop,
    facts_to_preserve: brief.facts_to_preserve,
    privacy_review: {
      status: brief.privacy_review.status,
      actions: brief.privacy_review.actions,
      source_metadata: "not-retained",
    },
    output: {
      path: `renders/final.${brief.output_format}`,
      width: 512,
      height: 512,
      fps: brief.output_format === "gif" ? 12 : 0,
      sha256: outputSha256,
    },
  };
}

async function extractPreviewFrames(ffmpeg, artifact, previewDirectory, duration) {
  const times = [0, duration / 2, Math.max(0, duration - 0.08)];
  const names = ["start.png", "middle.png", "end.png"];
  for (let index = 0; index < times.length; index += 1) {
    runCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(times[index]),
      "-i",
      artifact,
      "-frames:v",
      "1",
      "-vf",
      "scale=512:512",
      "-an",
      "-map_metadata",
      "-1",
      "-map_chapters",
      "-1",
      "-n",
      path.join(previewDirectory, names[index]),
    ]);
  }
}

export async function renderDirectSticker(briefPath, outputParent) {
  const brief = await readDirectBrief(briefPath);
  const shapeErrors = validateDirectBriefShape(brief);
  if (shapeErrors.length) throw new Error(shapeErrors.join("；"));
  const staged = await stageAuthorizedSource(brief);
  try {
    const inspected = inspectSourceProbe(brief, probeMedia(staged.stagedPath));
    const clip = brief.source.kind === "video" ? resolvedClipRange(brief, inspected.duration) : null;
    const selectionEvidence = brief.clip?.mode === "visual-query"
      ? await verifySemanticSelectionEvidence(brief, staged.sourceSha256)
      : null;
    const ffmpeg = requireDirectFfmpegFeatures(brief.output_format);
    const fontPath = resolveFontPath();
    const projectDirectory = await createOutputProject(outputParent, brief.project_name, ["renders", "previews", "evidence"]);
    if (selectionEvidence) {
      await writeJsonExclusive(path.join(projectDirectory, "evidence", "selection-index.json"), selectionEvidence.index);
      const targetDirectory = path.join(projectDirectory, "evidence", "selection");
      await mkdir(targetDirectory, { mode: 0o700 });
      for (const sheet of selectionEvidence.sheetFiles) {
        await copyFile(sheet.source, path.join(projectDirectory, "evidence", sheet.relative), constants.COPYFILE_EXCL);
      }
    }
    const artifact = path.join(projectDirectory, "renders", `final.${brief.output_format}`);
    const textFile = path.join(path.dirname(staged.stagedPath), "overlay.txt");
    const layout = titleLayout(brief.message.title);
    await writeFile(textFile, layout.text, { flag: "wx", mode: 0o600 });
    const base = baseVideoFilter(brief, fontPath, textFile, layout.fontSize);

    if (brief.output_format === "gif") {
      const filter = `[0:v]${base},split[v0][v1];[v0]palettegen=max_colors=128:stats_mode=diff[p];[v1][p]paletteuse=dither=bayer:bayer_scale=3[out]`;
      runCommand(ffmpeg, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        String(clip.start),
        "-t",
        String(clip.duration),
        "-i",
        staged.stagedPath,
        "-filter_complex",
        filter,
        "-map",
        "[out]",
        "-an",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-loop",
        "0",
        "-gifflags",
        "+transdiff",
        "-metadata",
        "comment=create-animation direct sticker",
        "-n",
        artifact,
      ]);
      await extractPreviewFrames(ffmpeg, artifact, path.join(projectDirectory, "previews"), clip.duration);
    } else {
      runCommand(ffmpeg, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        staged.stagedPath,
        "-vf",
        base,
        "-frames:v",
        "1",
        "-an",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-n",
        artifact,
      ]);
      await copyFile(artifact, path.join(projectDirectory, "previews", "final.png"), 1);
    }

    const outputSha256 = await sha256File(artifact);
    const delivery = deliveryBrief(brief, staged, inspected, clip, outputSha256, selectionEvidence);
    const deliveryPath = path.join(projectDirectory, "delivery-brief.json");
    await writeJsonExclusive(deliveryPath, delivery);
    const verification = await verifyDirectSticker(artifact, deliveryPath);
    if (!verification.ok) throw new Error(`成品验证失败：${verification.errors.join("；")}`);
    return { projectDirectory, artifact, deliveryPath };
  } finally {
    await staged.cleanup();
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) {
    console.error("用法：node scripts/render_direct_sticker.mjs <direct-sticker-brief.json> <输出父目录>");
    process.exit(2);
  }
  const result = await renderDirectSticker(path.resolve(argv[0]), path.resolve(argv[1]));
  console.log(`结果：通过\n工程：${result.projectDirectory}\n成品：${result.artifact}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`生成失败：${error.message}`);
    process.exit(1);
  });
}

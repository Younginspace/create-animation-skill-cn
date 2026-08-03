#!/usr/bin/env node
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  assertSemanticSearchRange,
  createOutputProject,
  escapeFilterPath,
  inspectSourceProbe,
  probeMedia,
  readDirectBrief,
  requireDirectFfmpegFeatures,
  resolveFontPath,
  runCommand,
  sha256File,
  stageAuthorizedSource,
  validateDirectBriefShape,
  writeJsonExclusive,
} from "./direct_sticker_common.mjs";

export async function prepareVideoSelection(briefPath, outputParent) {
  const brief = await readDirectBrief(briefPath);
  const errors = validateDirectBriefShape(brief);
  if (errors.length) throw new Error(errors.join("；"));
  if (brief.source.kind !== "video") throw new Error("联系表只用于视频输入");
  const staged = await stageAuthorizedSource(brief);
  try {
    const inspected = inspectSourceProbe(brief, probeMedia(staged.stagedPath));
    const search = assertSemanticSearchRange(brief, inspected.duration);
    const ffmpeg = requireDirectFfmpegFeatures("selection");
    const fontPath = resolveFontPath();
    const projectDirectory = await createOutputProject(outputParent, `${brief.project_name}-selection`, ["selection"]);
    const sheetCount = search.sampleCount / 12;
    const portrait = inspected.height > inspected.width;
    const cellWidth = portrait ? 240 : 300;
    const cellHeight = portrait ? 426 : 170;
    const sampleDirectory = path.join(path.dirname(staged.stagedPath), "samples");
    await mkdir(sampleDirectory, { mode: 0o700 });
    for (let index = 0; index < search.sampleCount; index += 1) {
      const seconds = search.start + index * search.interval;
      const filter = [
      `scale='if(gt(a,${cellWidth}/${cellHeight}),${cellWidth},-2)':'if(gt(a,${cellWidth}/${cellHeight}),-2,${cellHeight})'`,
      "setsar=1",
      `pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:color=0x101010`,
      [
        `drawtext=fontfile='${escapeFilterPath(fontPath)}'`,
          `text='${index + 1}'`,
        "fontcolor=0xFFFFFF",
        "fontsize=34",
        "borderw=3",
        "bordercolor=0x000000",
        "box=1",
        "boxcolor=0x000000@0.55",
        "boxborderw=8",
        "x=12",
        "y=12",
      ].join(":"),
      ].join(",");
      runCommand(ffmpeg, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        String(seconds),
        "-i",
        staged.stagedPath,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-an",
        "-sn",
        "-dn",
        "-vf",
        filter,
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-q:v",
        "4",
        "-n",
        path.join(sampleDirectory, `sample-${String(index + 1).padStart(3, "0")}.jpg`),
      ], { timeout: 30_000 });
    }
    for (let sheetIndex = 0; sheetIndex < sheetCount; sheetIndex += 1) {
      runCommand(ffmpeg, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-framerate",
        "1",
        "-start_number",
        String(sheetIndex * 12 + 1),
        "-i",
        path.join(sampleDirectory, "sample-%03d.jpg"),
        "-vf",
        "tile=4x3:nb_frames=12:padding=4:margin=4:color=0x171717",
        "-frames:v",
        "1",
        "-an",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-q:v",
        "3",
        "-n",
        path.join(projectDirectory, "selection", `sheet-${String(sheetIndex + 1).padStart(2, "0")}.jpg`),
      ], { timeout: 30_000 });
    }
    const samples = Array.from({ length: search.sampleCount }, (_, index) => ({
      sample: index + 1,
      sheet: Math.floor(index / 12) + 1,
      row: Math.floor((index % 12) / 4) + 1,
      column: (index % 4) + 1,
      seconds: Number((search.start + index * search.interval).toFixed(3)),
    }));
    const sheets = [];
    for (let sheetIndex = 0; sheetIndex < sheetCount; sheetIndex += 1) {
      const relative = `selection/sheet-${String(sheetIndex + 1).padStart(2, "0")}.jpg`;
      sheets.push({
        path: relative,
        sha256: await sha256File(path.join(projectDirectory, relative), 16 * 1024 * 1024),
      });
    }
    const selectionIndex = {
      schema_kind: "direct-sticker-selection",
      schema_version: 1,
      generator: "ffmpeg-random-seek-contact-sheet-v2",
      project_name: brief.project_name,
      source: {
        source_id: brief.source.source_id,
        sha256: staged.sourceSha256,
        duration_seconds: inspected.duration,
      },
      query: brief.clip.query,
      search_range: {
        start_seconds: search.start,
        end_seconds: search.end,
        interval_seconds: search.interval,
      },
      layout: {
        columns: 4,
        rows: 3,
        samples_per_sheet: 12,
        cell_width: cellWidth,
        cell_height: cellHeight,
      },
      sheets,
      samples,
      next_step: "查看全部联系表；根据画面证据把 resolved_start_seconds 和 resolved_end_seconds 写回原 brief，再运行 render_direct_sticker.mjs。定位不确定时让用户从候选片段中选择。",
    };
    await writeJsonExclusive(path.join(projectDirectory, "selection-index.json"), selectionIndex);
    return {
      projectDirectory,
      selectionDirectory: path.join(projectDirectory, "selection"),
      indexPath: path.join(projectDirectory, "selection-index.json"),
      sheetCount,
    };
  } finally {
    await staged.cleanup();
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) {
    console.error("用法：node scripts/prepare_video_selection.mjs <direct-sticker-brief.json> <输出父目录>");
    process.exit(2);
  }
  const result = await prepareVideoSelection(path.resolve(argv[0]), path.resolve(argv[1]));
  console.log(`结果：需要视觉定位\n联系表：${result.selectionDirectory}\n索引：${result.indexPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`准备失败：${error.message}`);
    process.exit(1);
  });
}

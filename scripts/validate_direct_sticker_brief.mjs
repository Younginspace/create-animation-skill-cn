#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSemanticSearchRange,
  inspectSourceProbe,
  probeMedia,
  readDirectBrief,
  resolvedClipRange,
  stageAuthorizedSource,
  validateDirectBriefShape,
} from "./direct_sticker_common.mjs";

export async function validateDirectStickerBrief(briefPath) {
  const brief = await readDirectBrief(briefPath);
  const errors = validateDirectBriefShape(brief);
  if (errors.length) throw new Error(errors.join("；"));
  const staged = await stageAuthorizedSource(brief);
  try {
    const inspected = inspectSourceProbe(brief, probeMedia(staged.stagedPath));
    let state = "render-ready";
    if (brief.source.kind === "video" && brief.clip.mode === "visual-query") {
      if (
        Number.isFinite(brief.clip.resolved_start_seconds) &&
        Number.isFinite(brief.clip.resolved_end_seconds)
      ) {
        resolvedClipRange(brief, inspected.duration);
      } else {
        assertSemanticSearchRange(brief, inspected.duration);
        state = "selection-required";
      }
    } else if (brief.source.kind === "video") {
      resolvedClipRange(brief, inspected.duration);
    }
    return { brief, inspected, state };
  } finally {
    await staged.cleanup();
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    console.error("用法：node scripts/validate_direct_sticker_brief.mjs <direct-sticker-brief.json>");
    process.exit(2);
  }
  const result = await validateDirectStickerBrief(path.resolve(argv[0]));
  console.log(`结果：通过（${result.brief.source.kind}，${result.brief.output_format}，${result.state}）`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`校验失败：${error.message}`);
    process.exit(1);
  });
}

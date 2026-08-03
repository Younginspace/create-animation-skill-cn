#!/usr/bin/env node
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSemanticSearchRange,
  inspectSourceProbe,
  probeMedia,
  runCommand,
  stageAuthorizedSource,
  validateDirectBriefShape,
} from "./direct_sticker_common.mjs";
import { prepareVideoSelection } from "./prepare_video_selection.mjs";
import { approveDirectSticker } from "./approve_direct_sticker.mjs";
import { renderDirectSticker } from "./render_direct_sticker.mjs";
import { validateDirectStickerBrief } from "./validate_direct_sticker_brief.mjs";
import { verifyDirectSticker } from "./verify_direct_sticker.mjs";

function baseBrief(sourcePath, root, kind, projectName) {
  return {
    schema_kind: "direct-sticker-source",
    schema_version: 1,
    project_name: projectName,
    source: {
      path: sourcePath,
      source_id: `${projectName}-source`,
      kind,
      authorized: true,
      alt: "自检素材",
    },
    approved_media_roots: [root],
    message: { title: kind === "video" ? "搞定了" : "就这？" },
    use_case: "自检",
    aspect_ratio: "1:1",
    duration_seconds: kind === "video" ? 2 : 0,
    output_format: kind === "video" ? "gif" : "png",
    style: kind === "video" ? "energetic" : "playful",
    loop: kind === "video",
    text_position: "bottom",
    crop_anchor: "center",
    facts_to_preserve: [],
    privacy_review: {
      status: "reviewed-no-sensitive-content",
      confirmation: "合成自检素材不含真实个人信息",
      actions: [],
    },
  };
}

export async function runDirectStickerSelfTest() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-animation-direct-self-test-"));
  const sources = path.join(tempRoot, "sources");
  const outputs = path.join(tempRoot, "outputs");
  const briefs = path.join(tempRoot, "briefs");
  await mkdir(sources, { mode: 0o700 });
  await mkdir(outputs, { mode: 0o700 });
  await mkdir(briefs, { mode: 0o700 });
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const videoPath = path.join(sources, "fixture.mp4");
  const imagePath = path.join(sources, "fixture.jpg");
  try {
    runCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=640x480:r=30:d=4",
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-n",
      videoPath,
    ]);
    runCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0xDDE8F0:s=640x640:d=1",
      "-frames:v",
      "1",
      "-n",
      imagePath,
    ]);

    const exact = baseBrief(videoPath, sources, "video", "direct-exact");
    exact.clip = { mode: "time-range", start_seconds: 1, end_seconds: 3 };
    const exactPath = path.join(briefs, "exact.json");
    await writeFile(exactPath, `${JSON.stringify(exact, null, 2)}\n`, { mode: 0o600 });
    const exactValidation = await validateDirectStickerBrief(exactPath);
    assert.equal(exactValidation.state, "render-ready");
    const exactRender = await renderDirectSticker(exactPath, outputs);
    const exactApproval = await approveDirectSticker(exactRender.projectDirectory);
    const exactVerified = await verifyDirectSticker(exactRender.artifact, exactRender.deliveryPath, exactApproval.approvalPath);
    assert.equal(exactVerified.ok, true, exactVerified.errors.join("；"));
    assert.equal((await readFile(exactRender.deliveryPath, "utf8")).includes(tempRoot), false);
    const exactDeliveryOriginal = await readFile(exactRender.deliveryPath, "utf8");
    const exactDeliveryChanged = JSON.parse(exactDeliveryOriginal);
    exactDeliveryChanged.use_case = "批准后被改写";
    await writeFile(exactRender.deliveryPath, `${JSON.stringify(exactDeliveryChanged, null, 2)}\n`);
    const changedAfterApproval = await verifyDirectSticker(
      exactRender.artifact,
      exactRender.deliveryPath,
      exactApproval.approvalPath,
    );
    assert.equal(changedAfterApproval.ok, false);
    assert.match(changedAfterApproval.errors.join("；"), /delivery brief 摘要/);
    await writeFile(exactRender.deliveryPath, exactDeliveryOriginal);
    const linkedArtifact = path.join(outputs, "linked-final.gif");
    await symlink(exactRender.artifact, linkedArtifact);
    const linkedArtifactResult = await verifyDirectSticker(linkedArtifact, exactRender.deliveryPath);
    assert.equal(linkedArtifactResult.ok, false);
    assert.match(linkedArtifactResult.errors.join("；"), /符号链接/);

    const leakedDelivery = JSON.parse(await readFile(exactRender.deliveryPath, "utf8"));
    leakedDelivery.source.alt = "素材来自 /Users/alice/secret/clip.mp4";
    const leakedDeliveryPath = path.join(briefs, "leaked-delivery.json");
    await writeFile(leakedDeliveryPath, `${JSON.stringify(leakedDelivery, null, 2)}\n`, { mode: 0o600 });
    const leakedResult = await verifyDirectSticker(exactRender.artifact, leakedDeliveryPath);
    assert.equal(leakedResult.ok, false);
    assert.match(leakedResult.errors.join("；"), /绝对路径/);
    const chineseLeakedDelivery = structuredClone(leakedDelivery);
    chineseLeakedDelivery.source.alt = "素材来自 /中文/秘密";
    const chineseLeakedDeliveryPath = path.join(briefs, "chinese-leaked-delivery.json");
    await writeFile(chineseLeakedDeliveryPath, `${JSON.stringify(chineseLeakedDelivery, null, 2)}\n`, { mode: 0o600 });
    const chineseLeakedResult = await verifyDirectSticker(exactRender.artifact, chineseLeakedDeliveryPath);
    assert.equal(chineseLeakedResult.ok, false);
    assert.match(chineseLeakedResult.errors.join("；"), /绝对路径/);

    const semantic = baseBrief(videoPath, sources, "video", "direct-semantic");
    semantic.clip = { mode: "visual-query", query: "彩色测试画面出现之后" };
    const semanticPath = path.join(briefs, "semantic.json");
    await writeFile(semanticPath, `${JSON.stringify(semantic, null, 2)}\n`, { mode: 0o600 });
    const semanticValidation = await validateDirectStickerBrief(semanticPath);
    assert.equal(semanticValidation.state, "selection-required");
    const selection = await prepareVideoSelection(semanticPath, outputs);
    assert.equal(selection.sheetCount, 1);
    const tamperedIndex = JSON.parse(await readFile(selection.indexPath, "utf8"));
    tamperedIndex.source.sha256 = "0".repeat(64);
    const tamperedIndexPath = path.join(briefs, "tampered-selection-index.json");
    await writeFile(tamperedIndexPath, `${JSON.stringify(tamperedIndex, null, 2)}\n`, { mode: 0o600 });
    const tamperedSemantic = structuredClone(semantic);
    tamperedSemantic.clip.resolved_start_seconds = 1;
    tamperedSemantic.clip.resolved_end_seconds = 3;
    tamperedSemantic.clip.evidence_samples = [4, 7, 10];
    tamperedSemantic.clip.selection_index_path = tamperedIndexPath;
    const tamperedSemanticPath = path.join(briefs, "tampered-semantic.json");
    await writeFile(tamperedSemanticPath, `${JSON.stringify(tamperedSemantic, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(() => renderDirectSticker(tamperedSemanticPath, outputs), /源素材摘要不一致/);
    const originalSheet = await readFile(path.join(selection.selectionDirectory, "sheet-01.jpg"));
    await writeFile(
      path.join(selection.selectionDirectory, "sheet-01.jpg"),
      Buffer.concat([originalSheet, Buffer.from("tampered")]),
    );
    const tamperedPixelsSemantic = structuredClone(semantic);
    tamperedPixelsSemantic.clip.resolved_start_seconds = 1;
    tamperedPixelsSemantic.clip.resolved_end_seconds = 3;
    tamperedPixelsSemantic.clip.evidence_samples = [4, 7, 10];
    tamperedPixelsSemantic.clip.selection_index_path = selection.indexPath;
    const tamperedPixelsPath = path.join(briefs, "tampered-sheet-pixels.json");
    await writeFile(tamperedPixelsPath, `${JSON.stringify(tamperedPixelsSemantic, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(() => renderDirectSticker(tamperedPixelsPath, outputs), /摘要不一致/);
    await writeFile(path.join(selection.selectionDirectory, "sheet-01.jpg"), originalSheet);
    semantic.clip.resolved_start_seconds = 1;
    semantic.clip.resolved_end_seconds = 3;
    semantic.clip.evidence_samples = [4, 7, 10];
    semantic.clip.selection_index_path = selection.indexPath;
    const semanticResolvedPath = path.join(briefs, "semantic-resolved.json");
    await writeFile(semanticResolvedPath, `${JSON.stringify(semantic, null, 2)}\n`, { mode: 0o600 });
    const semanticRender = await renderDirectSticker(semanticResolvedPath, outputs);
    const semanticApproval = await approveDirectSticker(semanticRender.projectDirectory);
    const semanticVerified = await verifyDirectSticker(semanticRender.artifact, semanticRender.deliveryPath, semanticApproval.approvalPath);
    assert.equal(semanticVerified.ok, true, semanticVerified.errors.join("；"));

    const still = baseBrief(imagePath, sources, "image", "direct-static");
    const stillPath = path.join(briefs, "still.json");
    await writeFile(stillPath, `${JSON.stringify(still, null, 2)}\n`, { mode: 0o600 });
    const stillRender = await renderDirectSticker(stillPath, outputs);
    const stillApproval = await approveDirectSticker(stillRender.projectDirectory);
    const stillVerified = await verifyDirectSticker(stillRender.artifact, stillRender.deliveryPath, stillApproval.approvalPath);
    assert.equal(stillVerified.ok, true, stillVerified.errors.join("；"));
    const stillProbe = probeMedia(stillRender.artifact);
    assert.equal(Object.keys(stillProbe.format?.tags || {}).some((key) => key.toLowerCase() !== "encoder"), false);

    const longTitle = baseBrief(imagePath, sources, "image", "direct-long-title");
    longTitle.message.title = "一二三四五六七八九十一二三四五六";
    const longTitlePath = path.join(briefs, "long-title.json");
    await writeFile(longTitlePath, `${JSON.stringify(longTitle, null, 2)}\n`, { mode: 0o600 });
    const longTitleRender = await renderDirectSticker(longTitlePath, outputs);
    const longTitleApproval = await approveDirectSticker(longTitleRender.projectDirectory);
    const longTitleVerified = await verifyDirectSticker(longTitleRender.artifact, longTitleRender.deliveryPath, longTitleApproval.approvalPath);
    assert.equal(longTitleVerified.ok, true, longTitleVerified.errors.join("；"));

    const disguisedImagePath = path.join(sources, "disguised.jpg");
    await copyFile(videoPath, disguisedImagePath);
    const disguised = baseBrief(disguisedImagePath, sources, "image", "direct-disguised-image");
    const disguisedPath = path.join(briefs, "disguised.json");
    await writeFile(disguisedPath, `${JSON.stringify(disguised, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(() => validateDirectStickerBrief(disguisedPath), /真实容器与编码必须是单张/);

    assert.throws(
      () => runCommand(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { timeout: 20 }),
      /启动失败/,
    );

    assert.throws(
      () =>
        assertSemanticSearchRange(
          { clip: { mode: "visual-query", query: "某个事件" } },
          30 * 60 + 1,
        ),
      /超过30分钟/,
    );
    const narrowed = assertSemanticSearchRange(
      {
        clip: {
          mode: "visual-query",
          query: "某个事件",
          approximate_start_seconds: 1200,
          approximate_end_seconds: 1500,
        },
      },
      31 * 60,
    );
    assert.equal(narrowed.rangeDuration, 300);

    const resolvedWithoutEvidence = structuredClone(semantic);
    resolvedWithoutEvidence.clip.resolved_start_seconds = 1;
    resolvedWithoutEvidence.clip.resolved_end_seconds = 3;
    delete resolvedWithoutEvidence.clip.evidence_samples;
    delete resolvedWithoutEvidence.clip.selection_index_path;
    assert.match(validateDirectBriefShape(resolvedWithoutEvidence).join("；"), /evidence_samples/);

    assert.throws(
      () =>
        inspectSourceProbe(exact, {
          format: { duration: "4" },
          streams: [
            { codec_type: "video", codec_name: "h264", width: 640, height: 480, duration: "4" },
            { codec_type: "subtitle", codec_name: "subrip" },
          ],
        }),
      /字幕、数据或附件流/,
    );

    const unauthorized = structuredClone(exact);
    unauthorized.project_name = "direct-unauthorized";
    unauthorized.approved_media_roots = [briefs];
    await assert.rejects(() => stageAuthorizedSource(unauthorized), /不在 approved_media_roots 内/);

    const broadRoot = structuredClone(exact);
    broadRoot.project_name = "direct-broad-root";
    broadRoot.approved_media_roots = ["/private/tmp"];
    await assert.rejects(() => stageAuthorizedSource(broadRoot), /范围过宽/);

    const linkedPath = path.join(sources, "linked.mp4");
    await symlink(videoPath, linkedPath);
    const linked = structuredClone(exact);
    linked.project_name = "direct-linked-source";
    linked.source.path = linkedPath;
    await assert.rejects(() => stageAuthorizedSource(linked), /不得是符号链接/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
  return "通过（时间段/语义证据绑定、静态PNG、长文案、视觉批准、元数据/路径脱敏、授权根/符号链接、伪装容器/流类型、命令超时、长视频降级与成品验证）";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runDirectStickerSelfTest()
    .then((message) => console.log(`结果：${message}`))
    .catch((error) => {
      console.error(`自检失败：${error.message}`);
      process.exit(1);
    });
}

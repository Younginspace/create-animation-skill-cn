#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import {
  approvePreview,
  requirePreviewApproval,
  snapshotEvidenceDigest,
} from "./approve_preview.mjs";
import { validateDeliveryBriefContract } from "./delivery_brief_contract.mjs";
import { projectContractDigest } from "./runtime_guard.mjs";
import { main as scaffoldMain, sanitizeImage } from "./scaffold_project.mjs";
import {
  decodeJpegBuffer,
  inspectImageBuffer,
  loadBrief,
  validateBrief,
} from "./validate_brief.mjs";
import { verifyDelivery } from "./verify_delivery.mjs";
import { verifyProject } from "./verify_project.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const crcTable = Array.from({ length: 256 }, (_, initial) => {
  let value = initial;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([typeBuffer, data])) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return chunk;
}

function makePng({ animated = false, ancillary = [], indexed = false } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr[8] = 8;
  ihdr[9] = indexed ? 3 : 6;
  const rows = Buffer.alloc((64 * (indexed ? 1 : 4) + 1) * 64);
  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
  ];
  if (indexed) {
    chunks.push(
      pngChunk("PLTE", Buffer.from([255, 0, 0, 0, 0, 255])),
      pngChunk("tRNS", Buffer.from([255, 128])),
    );
  }
  if (animated) {
    const animationControl = Buffer.alloc(8);
    animationControl.writeUInt32BE(2, 0);
    chunks.push(pngChunk("acTL", animationControl));
  }
  for (const item of ancillary) chunks.push(pngChunk(item.type, item.data));
  chunks.push(pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND"));
  return Buffer.concat(chunks);
}

function jpegSegment(marker, payload) {
  const segment = Buffer.alloc(payload.length + 4);
  segment[0] = 0xff;
  segment[1] = marker;
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return segment;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(script, args) {
  return spawnSync(process.execPath, [path.join(scriptDir, script), ...args], {
    encoding: "utf8",
    timeout: 15_000,
  });
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "create-animation-contract-"));
  try {
    const [
      runtimeSource,
      checkSource,
      renderSource,
      guardSource,
      browserGuardSource,
      scaffoldSource,
      approvalSource,
      privateBriefWrapperSource,
    ] =
      await Promise.all([
      readFile(path.join(scriptDir, "check_runtime.mjs"), "utf8"),
      readFile(path.join(scriptDir, "check_project.mjs"), "utf8"),
      readFile(path.join(scriptDir, "render_project.mjs"), "utf8"),
      readFile(path.join(scriptDir, "runtime_guard.mjs"), "utf8"),
      readFile(path.join(scriptDir, "chrome-headless-shell"), "utf8"),
      readFile(path.join(scriptDir, "scaffold_project.mjs"), "utf8"),
      readFile(path.join(scriptDir, "approve_preview.mjs"), "utf8"),
      readFile(path.join(scriptDir, "scaffold_from_stdin.mjs"), "utf8"),
    ]);
    for (const flag of [
      "HYPERFRAMES_NO_TELEMETRY",
      "HYPERFRAMES_NO_UPDATE_CHECK",
      "HYPERFRAMES_NO_AUTO_INSTALL",
      "DO_NOT_TRACK",
    ]) {
      assert(guardSource.includes(flag), `共享运行守卫缺少 ${flag}`);
    }
    assert(
      checkSource.includes('"--at-transitions"') &&
        checkSource.includes("plannedTransitionTimes") &&
        checkSource.includes('"snapshot"') &&
        checkSource.includes('"--json"') &&
        checkSource.includes("verifyProject") &&
        checkSource.includes("resolveRunner") &&
        checkSource.includes("freezeProject") &&
        checkSource.includes("guardedRuntimeEnv"),
      "快照检查入口缺少工程前验、冻结工程、固定 CLI、离线浏览器、转场取样或阻断后台更新查询的 --json",
    );
    assert(
      runtimeSource.includes('["--version", "--json"]') &&
        renderSource.includes('["--version", "--json"]'),
      "CLI 版本探测缺少真正阻断0.7.83后台请求的 --json",
    );
    assert(
      renderSource.includes('"--json"') &&
        renderSource.includes("freezeProject") &&
        renderSource.includes("guardedRuntimeEnv") &&
        renderSource.includes("requirePreviewApproval"),
      "渲染入口缺少冻结工程、离线浏览器、人工预览批准或阻断后台请求的 --json",
    );
    assert(
      checkSource.includes("contract_sha256") &&
        checkSource.includes("evidence_sha256") &&
        approvalSource.includes("approved-after-human-review"),
      "快照检查和人工批准没有绑定工程摘要与快照证据摘要",
    );
    assert(
      browserGuardSource.includes("--proxy-server=http://127.0.0.1:9") &&
        browserGuardSource.includes("--host-resolver-rules=") &&
        guardSource.includes("HYPERFRAMES_BROWSER_PATH") &&
        guardSource.includes("PRODUCER_HEADLESS_SHELL_PATH"),
      "浏览器离线守卫没有同时阻断外网并固定两个 HyperFrames 浏览器入口",
    );
    assert(
      scaffoldSource.includes('http-equiv="Content-Security-Policy"') &&
        scaffoldSource.includes("connect-src 'none'") &&
        scaffoldSource.includes("validateDeliveryBriefContract"),
      "脚手架缺少禁止网络连接的 CSP 或生成后 delivery brief 自检",
    );
    assert(
      privateBriefWrapperSource.includes("finally") &&
        privateBriefWrapperSource.includes("mkdtemp") &&
        privateBriefWrapperSource.includes("0o600") &&
        privateBriefWrapperSource.includes("rm(privateDirectory"),
      "执行者临时 source brief 缺少私有创建或覆盖 validate/scaffold 全路径的 finally 清理",
    );
    assert(renderSource.includes("scale=512:-2") && renderSource.includes("fps=12"), "GIF 512px/12fps 优化契约缺失");

    const fakeJpegWithExif = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08]),
      Buffer.from("Exif\0\0", "binary"),
      Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]),
    ]);
    const sanitizedJpeg = sanitizeImage(fakeJpegWithExif, ".jpg");
    assert(!sanitizedJpeg.includes(Buffer.from("Exif", "ascii")), "JPEG EXIF 元数据未被移除");

    const orientationPayload = Buffer.alloc(32);
    orientationPayload.write("Exif\u0000\u0000", 0, "binary");
    orientationPayload.write("II", 6, "ascii");
    orientationPayload.writeUInt16LE(42, 8);
    orientationPayload.writeUInt32LE(8, 10);
    orientationPayload.writeUInt16LE(1, 14);
    orientationPayload.writeUInt16LE(0x0112, 16);
    orientationPayload.writeUInt16LE(3, 18);
    orientationPayload.writeUInt32LE(1, 20);
    orientationPayload.writeUInt16LE(6, 24);
    const orientationSegment = Buffer.alloc(orientationPayload.length + 4);
    orientationSegment[0] = 0xff;
    orientationSegment[1] = 0xe1;
    orientationSegment.writeUInt16BE(orientationPayload.length + 2, 2);
    orientationPayload.copy(orientationSegment, 4);
    const orientedJpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      orientationSegment,
      Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]),
    ]);
    const sanitizedOrientedJpeg = sanitizeImage(orientedJpeg, ".jpg");
    assert(sanitizedOrientedJpeg.includes(Buffer.from("Exif", "ascii")), "JPEG 方向标记未被最小化保留");
    assert(sanitizedOrientedJpeg[30] === 6, "JPEG 方向值未被保留");

    const jpegWithPostScanComment = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x11]),
      Buffer.from([0xff, 0xfe, 0x00, 0x08]),
      Buffer.from("secret", "ascii"),
      Buffer.from([0xff, 0xd9]),
    ]);
    const sanitizedPostScanJpeg = sanitizeImage(jpegWithPostScanComment, ".jpg");
    assert(!sanitizedPostScanJpeg.includes(Buffer.from("secret", "ascii")), "JPEG 后置 COM 元数据未被移除");

    const generatedJpeg = spawnSync(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=#3977f6:s=64x64:d=0.04",
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-c:v",
        "mjpeg",
        "pipe:1",
      ],
      { encoding: null, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
    );
    assert(
      generatedJpeg.status === 0 && Buffer.isBuffer(generatedJpeg.stdout) && generatedJpeg.stdout.length > 0,
      `无法生成 JPEG 自检夹具：${String(generatedJpeg.stderr || generatedJpeg.error || "未知错误")}`,
    );
    const validJpeg = generatedJpeg.stdout;
    const jpegSecret = Buffer.from(
      "GPS=31.2304,121.4737;SOURCE=/Users/alice/private.jpg",
      "utf8",
    );
    const jpegWithPrivateApp = Buffer.concat([
      validJpeg.subarray(0, 2),
      jpegSegment(0xef, jpegSecret),
      validJpeg.subarray(2),
    ]);
    const sanitizedPrivateJpeg = sanitizeImage(jpegWithPrivateApp, ".jpg");
    assert(!sanitizedPrivateJpeg.includes(jpegSecret), "JPEG 私有 APP15 元数据未被移除");

    const adobePayload = Buffer.alloc(12);
    adobePayload.write("Adobe", 0, "ascii");
    adobePayload.writeUInt16BE(0x4750, 5);
    adobePayload.writeUInt16BE(0x5321, 7);
    adobePayload.writeUInt16BE(0x6c65, 9);
    adobePayload[11] = 1;
    const jpegWithPrivateAdobe = Buffer.concat([
      validJpeg.subarray(0, 2),
      jpegSegment(0xee, adobePayload),
      validJpeg.subarray(2),
    ]);
    const sanitizedPrivateAdobe = sanitizeImage(jpegWithPrivateAdobe, ".jpg");
    assert(
      !sanitizedPrivateAdobe.includes(adobePayload) &&
        sanitizedPrivateAdobe.includes(Buffer.from("Adobe", "ascii")),
      "JPEG Adobe APP14 未被重建为仅保留色彩变换的规范段",
    );
    const adobeDecode = decodeJpegBuffer(sanitizedPrivateAdobe);
    assert(adobeDecode.ok, `JPEG Adobe APP14 规范化后不可解码：${adobeDecode.error}`);

    const sourceBrief = {
      schema_kind: "source",
      schema_version: 2,
      project_name: "self-test-card",
      function: "card",
      message: { title: "测试卡片", subtitle: "离线契约", signature: "" },
      media: [],
      approved_media_roots: [],
      use_case: "本地自检",
      aspect_ratio: "1:1",
      duration_seconds: 6,
      output_format: "mp4",
      style: "clean",
      loop: false,
      facts_to_preserve: ["不得补造事实"],
      privacy_review: {
        status: "reviewed-no-sensitive-content",
        confirmation: "纯文字自检，不含图片或敏感账户信息",
        actions: [],
      },
    };

    const valid = await validateBrief(sourceBrief);
    assert(valid.errors.length === 0, `合法 source brief 被拒绝：${valid.errors.join("；")}`);

    const nullCardMessage = {
      ...sourceBrief,
      message: { title: "测试卡片", subtitle: null, signature: null },
    };
    const nullCardMessageResult = await validateBrief(nullCardMessage);
    assert(
      nullCardMessageResult.errors.some((item) => item.includes("message.subtitle")) &&
        nullCardMessageResult.errors.some((item) => item.includes("message.signature")),
      "source brief 对 null subtitle/signature 错误做了字符串强转",
    );
    const nullPhotoTitle = {
      ...sourceBrief,
      function: "photo-story",
      duration_seconds: 9,
      aspect_ratio: "9:16",
      message: { title: null },
    };
    const nullPhotoTitleResult = await validateBrief(nullPhotoTitle);
    assert(
      nullPhotoTitleResult.errors.some((item) => item.includes("message.title 必须是字符串")),
      "photo-story source brief 错误接受 null 标题",
    );
    const nullPhotoDeliveryErrors = validateDeliveryBriefContract({
      schema_kind: "delivery",
      schema_version: 2,
      project_name: "null-photo-title",
      function: "photo-story",
      message: { title: null },
      use_case: "本地自检",
      duration_seconds: 9,
      aspect_ratio: "9:16",
      output_format: "mp4",
      style: "clean",
      loop: false,
      facts_to_preserve: [],
      privacy_review: {
        status: "reviewed-no-sensitive-content",
        actions: [],
        image_metadata: "sensitive-stripped-orientation-preserved",
      },
      media: [1, 2, 3].map((index) => ({
        source_id: `photo-${index}`,
        project_path: `assets/media-0${index}.png`,
        alt: `测试照片${index}`,
      })),
    });
    assert(
      nullPhotoDeliveryErrors.some((item) => item.includes("message.title 必须是字符串")),
      "photo-story delivery brief 错误接受 null 标题",
    );
    const nullMessageBriefPath = path.join(root, "null-message-source-brief.json");
    const nullMessageProject = "null-message-card";
    await writeFile(
      nullMessageBriefPath,
      `${JSON.stringify(
        {
          ...nullCardMessage,
          project_name: nullMessageProject,
        },
        null,
        2,
      )}\n`,
    );
    const nullMessageScaffold = runNode("scaffold_project.mjs", [
      nullMessageBriefPath,
      root,
    ]);
    assert(nullMessageScaffold.status !== 0, "null 文案错误生成了工程");
    let nullMessageProjectExists = false;
    try {
      await lstat(path.join(root, nullMessageProject));
      nullMessageProjectExists = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    assert(!nullMessageProjectExists, "null 文案失败后残留了工程目录");

    const wrapperTmpRoot = path.join(root, "private-brief-wrapper-tmp");
    await mkdir(wrapperTmpRoot);
    const wrapperBrief = {
      ...sourceBrief,
      project_name: "private-brief-wrapper-card",
    };
    const wrapperRun = spawnSync(
      process.execPath,
      [path.join(scriptDir, "scaffold_from_stdin.mjs"), root],
      {
        encoding: "utf8",
        input: `${JSON.stringify(wrapperBrief)}\n`,
        timeout: 30_000,
        env: { ...process.env, TMPDIR: wrapperTmpRoot },
      },
    );
    assert(
      wrapperRun.status === 0,
      `私有 source brief 包装入口失败：${wrapperRun.stderr || wrapperRun.stdout}`,
    );
    assert(
      (await readdir(wrapperTmpRoot)).length === 0,
      "私有 source brief 包装入口成功后残留临时文件",
    );
    const wrapperProject = path.join(root, wrapperBrief.project_name);
    let wrapperSourceBriefLeaked = false;
    try {
      await lstat(path.join(wrapperProject, "source-brief.json"));
      wrapperSourceBriefLeaked = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    assert(!wrapperSourceBriefLeaked, "私有 source brief 被复制进交付工程");
    await rm(wrapperProject, { recursive: true, force: false });
    const wrapperInvalid = spawnSync(
      process.execPath,
      [path.join(scriptDir, "scaffold_from_stdin.mjs"), root],
      {
        encoding: "utf8",
        input: `${JSON.stringify({
          ...nullCardMessage,
          project_name: "private-brief-invalid-card",
        })}\n`,
        timeout: 30_000,
        env: { ...process.env, TMPDIR: wrapperTmpRoot },
      },
    );
    assert(wrapperInvalid.status !== 0, "私有 brief 包装入口错误接受无效文案");
    assert(
      (await readdir(wrapperTmpRoot)).length === 0,
      "私有 source brief 包装入口在 validate 失败后残留临时文件",
    );

    const oversizedBriefPath = path.join(root, "oversized-source-brief.json");
    await writeFile(oversizedBriefPath, Buffer.alloc(256 * 1024 + 1, 0x20));
    let oversizedBriefRejected = false;
    try {
      await loadBrief(oversizedBriefPath);
    } catch (error) {
      oversizedBriefRejected = error.message.includes("256KB");
    }
    assert(oversizedBriefRejected, "source brief 超过256KB后仍被无界读取");

    let unauthorizedCallback = false;
    const unauthorizedResult = await validateBrief(
      {
        ...sourceBrief,
        media: [
          {
            path: path.join(root, "must-not-be-opened.png"),
            source_id: "not-authorized",
            authorized: false,
          },
        ],
        approved_media_roots: [root],
      },
      { onValidatedMedia: async () => { unauthorizedCallback = true; } },
    );
    assert(
      unauthorizedResult.errors.some((item) => item.includes("authorized: true")) &&
        !unauthorizedResult.errors.some((item) => item.includes("文件不存在")) &&
        !unauthorizedCallback,
      "未授权素材没有在任何文件系统读取之前停止",
    );

    const approvedSubdir = path.join(root, "approved-only");
    await mkdir(approvedSubdir);
    const outsideApprovedPath = path.join(root, "outside-approved.png");
    await writeFile(outsideApprovedPath, makePng());
    let outsideCallback = false;
    const outsideResult = await validateBrief(
      {
        ...sourceBrief,
        media: [
          {
            path: outsideApprovedPath,
            source_id: "outside-approved-root",
            authorized: true,
          },
        ],
        approved_media_roots: [approvedSubdir],
      },
      { onValidatedMedia: async () => { outsideCallback = true; } },
    );
    assert(
      outsideResult.errors.some((item) => item.includes("不在 approved_media_roots 内")) &&
        !outsideCallback,
      "授权根之外的素材仍被读取或交给脚手架",
    );

    const legacyPrivacy = { ...sourceBrief, privacy_actions: ["遮挡车牌"] };
    const legacyResult = await validateBrief(legacyPrivacy);
    assert(
      legacyResult.errors.some((item) => item.includes("privacy_actions 是旧字段")),
      "旧 privacy_actions 未被安全门拒绝",
    );

    const pendingPrivacy = { ...sourceBrief, privacy_review: { status: "pending", confirmation: "", actions: [] } };
    const pendingResult = await validateBrief(pendingPrivacy);
    assert(pendingResult.errors.some((item) => item.includes("privacy_review.status")), "未确认隐私状态未被拒绝");

    const animatedInput = {
      ...sourceBrief,
      media: [{ path: path.join(root, "animated.gif"), source_id: "animated", authorized: true }],
      approved_media_roots: [root],
    };
    await writeFile(animatedInput.media[0].path, Buffer.from("GIF89a", "ascii"));
    const animatedResult = await validateBrief(animatedInput);
    assert(animatedResult.errors.some((item) => item.includes("静态 JPEG/PNG")), "动画 GIF 输入未被拒绝");

    const apngPath = path.join(root, "animated.png");
    await writeFile(apngPath, makePng({ animated: true }));
    const apngInput = {
      ...sourceBrief,
      media: [{ path: apngPath, source_id: "apng", authorized: true }],
      approved_media_roots: [root],
    };
    const apngResult = await validateBrief(apngInput);
    assert(apngResult.errors.some((item) => item.includes("APNG")), "APNG 动画输入未被拒绝");
    let apngSanitizeRejected = false;
    try {
      sanitizeImage(await readFile(apngPath), ".png");
    } catch (error) {
      apngSanitizeRejected = error.message.includes("APNG");
    }
    assert(apngSanitizeRejected, "脚手架防御层未拒绝 APNG");

    const pngSecret = Buffer.from(
      "GPS=31.2304,121.4737;SOURCE=/Users/alice/private.jpg",
      "utf8",
    );
    const privateChunkPng = makePng({
      ancillary: [{ type: "vpAg", data: pngSecret }],
    });
    const sanitizedPrivatePng = sanitizeImage(privateChunkPng, ".png");
    assert(!sanitizedPrivatePng.includes(pngSecret), "PNG 自定义 ancillary 元数据未被移除");
    assert(inspectImageBuffer(sanitizedPrivatePng)?.valid, "PNG 元数据清洗后不可解码");

    const indexedPng = sanitizeImage(makePng({ indexed: true }), ".png");
    assert(
      indexedPng.includes(Buffer.from("PLTE")) &&
        indexedPng.includes(Buffer.from("tRNS")) &&
        inspectImageBuffer(indexedPng)?.valid,
      "索引色 PNG 清洗错误移除了 PLTE/tRNS 或破坏像素流",
    );

    const fakePngPath = path.join(root, "fake.png");
    const fakePng = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(fakePng);
    fakePng.writeUInt32BE(64, 16);
    fakePng.writeUInt32BE(64, 20);
    await writeFile(fakePngPath, fakePng);
    const fakePngInput = {
      ...sourceBrief,
      media: [{ path: fakePngPath, source_id: "fake-png", authorized: true }],
      approved_media_roots: [root],
    };
    const fakePngResult = await validateBrief(fakePngInput);
    assert(fakePngResult.errors.some((item) => item.includes("图片结构或像素流无效")), "伪 PNG 未被拒绝");

    const broadRoot = { ...sourceBrief, approved_media_roots: [path.parse(root).root] };
    const broadRootResult = await validateBrief(broadRoot);
    assert(broadRootResult.errors.some((item) => item.includes("范围过宽")), "文件系统根目录授权未被拒绝");
    if (path.parse(root).root === "/" && os.platform() !== "win32") {
      const broadPrivate = { ...sourceBrief, approved_media_roots: ["/private"] };
      const broadPrivateResult = await validateBrief(broadPrivate);
      assert(broadPrivateResult.errors.some((item) => item.includes("范围过宽")), "/private 宽授权根未被拒绝");
      const broadUsr = { ...sourceBrief, approved_media_roots: ["/usr"] };
      const broadUsrResult = await validateBrief(broadUsr);
      assert(broadUsrResult.errors.some((item) => item.includes("范围过宽")), "/usr 单层宽授权根未被拒绝");
    }

    const oversizedJpegPath = path.join(root, "oversized.jpg");
    const oversizedHandle = await open(oversizedJpegPath, "w");
    await oversizedHandle.truncate(25 * 1024 * 1024 + 1);
    await oversizedHandle.close();
    const oversizedInput = {
      ...sourceBrief,
      media: [
        {
          path: oversizedJpegPath,
          source_id: "oversized-jpeg",
          authorized: true,
        },
      ],
      approved_media_roots: [root],
    };
    const oversizedResult = await validateBrief(oversizedInput);
    assert(
      oversizedResult.errors.some((item) => item.includes("超过25MB上限")) &&
        !oversizedResult.errors.some((item) => item.includes("魔数") || item.includes("真实像素解码")),
      "超过25MB的素材未在 readFile/decoder 前形成资源消耗硬门",
    );

    const malformedJpegPath = path.join(root, "malformed.jpg");
    await writeFile(
      malformedJpegPath,
      Buffer.from("ffd8ffc000070800400040ffda0002ffd9", "hex"),
    );
    const malformedJpegInput = {
      ...sourceBrief,
      media: [
        {
          path: malformedJpegPath,
          source_id: "malformed-jpeg",
          authorized: true,
        },
      ],
      approved_media_roots: [root],
    };
    const malformedJpegResult = await validateBrief(malformedJpegInput);
    assert(
      malformedJpegResult.errors.some((item) => item.includes("JPEG")),
      "不可解码的伪 JPEG 未被真实 decoder 门拒绝",
    );

    const sourcePath = path.join(root, "source-brief.json");
    await writeFile(sourcePath, `${JSON.stringify(sourceBrief, null, 2)}\n`);
    const rollbackBrief = { ...sourceBrief, project_name: "rollback-self-test-card" };
    const rollbackBriefPath = path.join(root, "rollback-source-brief.json");
    const rollbackProjectDir = path.join(root, rollbackBrief.project_name);
    await writeFile(rollbackBriefPath, `${JSON.stringify(rollbackBrief, null, 2)}\n`);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    await scaffoldMain([rollbackBriefPath, root], {
      onCheckpoint: (point, detail) => {
        if (point === "generated-file-written" && detail.name === "delivery-brief.json") {
          throw new Error("事务回滚自检：模拟首个文件写入后的中途失败");
        }
      },
    });
    const rollbackFailureExitCode = process.exitCode;
    process.exitCode = previousExitCode;
    assert(rollbackFailureExitCode === 1, "脚手架中途故障夹具没有触发失败");
    let rollbackProjectStillExists = false;
    try {
      await lstat(rollbackProjectDir);
      rollbackProjectStillExists = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    assert(!rollbackProjectStillExists, "脚手架中途失败后残留同名半成品工程");
    const rollbackRetry = runNode("scaffold_project.mjs", [rollbackBriefPath, root]);
    assert(
      rollbackRetry.status === 0,
      `事务回滚后同名工程无法重试：${rollbackRetry.stderr || rollbackRetry.stdout}`,
    );
    await rm(rollbackProjectDir, { recursive: true, force: false });
    if (os.platform() !== "win32") {
      const symlinkOutputRoot = path.join(root, "symlink-output");
      const escapedTarget = path.join(root, "outside-output-root");
      await Promise.all([mkdir(symlinkOutputRoot), mkdir(escapedTarget)]);
      const symlinkBrief = { ...sourceBrief, project_name: "symlink-card" };
      const symlinkBriefPath = path.join(root, "symlink-source-brief.json");
      await writeFile(symlinkBriefPath, `${JSON.stringify(symlinkBrief, null, 2)}\n`);
      await symlink(escapedTarget, path.join(symlinkOutputRoot, symlinkBrief.project_name), "dir");
      const symlinkScaffold = runNode("scaffold_project.mjs", [symlinkBriefPath, symlinkOutputRoot]);
      assert(symlinkScaffold.status !== 0, "预置 projectDir 符号链接时脚手架错误通过");
      assert((await readdir(escapedTarget)).length === 0, "脚手架通过 projectDir 符号链接写出了授权父目录");
    }
    const scaffold = runNode("scaffold_project.mjs", [sourcePath, root]);
    assert(scaffold.status === 0, `脚手架失败：${scaffold.stderr || scaffold.stdout}`);

    const projectDir = path.join(root, sourceBrief.project_name);
    const projectResult = await verifyProject(projectDir);
    assert(projectResult.ok, `工程闭环校验失败：${projectResult.errors.join("；")}`);

    const approvalProjectDir = await realpath(projectDir);
    const verifiedRunDir = path.join(
      approvalProjectDir,
      "snapshots",
      "verified-1000000000000",
    );
    await mkdir(verifiedRunDir);
    await writeFile(path.join(verifiedRunDir, "frame-00.png"), makePng());
    const [checkedContractSha256, checkedEvidenceSha256] = await Promise.all([
      projectContractDigest(approvalProjectDir),
      snapshotEvidenceDigest(verifiedRunDir),
    ]);
    await writeFile(
      path.join(verifiedRunDir, "run-manifest.json"),
      `${JSON.stringify(
        {
          schema_kind: "preview-check",
          schema_version: 1,
          source_project: sourceBrief.project_name,
          purpose: "verified-preview-review",
          contract_sha256: checkedContractSha256,
          evidence_sha256: checkedEvidenceSha256,
          transition_times_seconds: [],
          checked_at: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    let missingApprovalRejected = false;
    try {
      await requirePreviewApproval(approvalProjectDir);
    } catch (error) {
      missingApprovalRejected = error.message.includes("缺少与当前工程摘要一致的人工预览批准");
    }
    assert(missingApprovalRejected, "没有人工批准时渲染前置门错误通过");
    const approved = await approvePreview(approvalProjectDir, verifiedRunDir);
    const acceptedApproval = await requirePreviewApproval(approvalProjectDir);
    assert(
      acceptedApproval.approvalId === approved.approval.approval_id,
      "有效人工批准没有被渲染前置门接受",
    );
    const approvalIndexPath = path.join(approvalProjectDir, "index.html");
    const approvalIndex = await readFile(approvalIndexPath, "utf8");
    await writeFile(approvalIndexPath, `${approvalIndex}\n`);
    let staleApprovalRejected = false;
    try {
      await requirePreviewApproval(approvalProjectDir);
    } catch (error) {
      staleApprovalRejected = error.message.includes("缺少与当前工程摘要一致的人工预览批准");
    }
    assert(staleApprovalRejected, "工程变更后旧人工批准仍错误放行");
    await writeFile(approvalIndexPath, approvalIndex);

    const briefMarkdownPath = path.join(projectDir, "BRIEF.md");
    const originalBriefMarkdown = await readFile(briefMarkdownPath, "utf8");
    await rm(briefMarkdownPath);
    const missingBriefMarkdown = await verifyProject(projectDir);
    assert(
      !missingBriefMarkdown.ok && missingBriefMarkdown.errors.some((item) => item.includes("缺少必需文件：BRIEF.md")),
      "删除必须交接的 BRIEF.md 后工程错误通过",
    );
    await writeFile(briefMarkdownPath, originalBriefMarkdown);

    const manifestPath = path.join(projectDir, "asset-manifest.json");
    const deliveryPath = path.join(projectDir, "delivery-brief.json");
    const indexPath = path.join(projectDir, "index.html");
    const [originalManifest, originalDelivery, originalIndex] = await Promise.all([
      readFile(manifestPath, "utf8"),
      readFile(deliveryPath, "utf8"),
      readFile(indexPath, "utf8"),
    ]);
    const privatePng = makePng({
      ancillary: [{ type: "vpAg", data: Buffer.from("GPS=31.2304,121.4737", "utf8") }],
    });
    const privatePngPath = path.join(projectDir, "assets", "media-01.png");
    const privatePngProjectPath = "assets/media-01.png";
    const privatePngId = "private-png";
    const privatePngManifest = [
      {
        source_id: privatePngId,
        project_path: privatePngProjectPath,
        alt: "带私有块的测试图",
        sha256: createHash("sha256").update(privatePng).digest("hex"),
        metadata_sanitized: true,
      },
    ];
    const privatePngDelivery = JSON.parse(originalDelivery);
    privatePngDelivery.media = [
      { source_id: privatePngId, project_path: privatePngProjectPath, alt: "带私有块的测试图" },
    ];
    await Promise.all([
      writeFile(privatePngPath, privatePng),
      writeFile(manifestPath, `${JSON.stringify(privatePngManifest, null, 2)}\n`),
      writeFile(deliveryPath, `${JSON.stringify(privatePngDelivery, null, 2)}\n`),
      writeFile(
        indexPath,
        originalIndex.replace("</body>", '<img src="assets/media-01.png" alt="fixture" /></body>'),
      ),
    ]);
    const privateMetadataResult = await verifyProject(projectDir);
    assert(
      !privateMetadataResult.ok &&
        privateMetadataResult.errors.some((item) => item.includes("仍含未清洗的图片元数据")),
      "asset manifest 声称已清洗时，verifier 未识别 PNG 私有元数据",
    );
    await Promise.all([
      rm(privatePngPath),
      writeFile(manifestPath, originalManifest),
      writeFile(deliveryPath, originalDelivery),
      writeFile(indexPath, originalIndex),
    ]);

    const gammaSecret = Buffer.from("GPS!", "ascii");
    const pngWithGammaBytes = makePng({
      ancillary: [{ type: "gAMA", data: gammaSecret }],
    });
    const sanitizedGammaPng = sanitizeImage(pngWithGammaBytes, ".png");
    assert(
      !sanitizedGammaPng.includes(gammaSecret),
      "PNG 非必要色彩提示 chunk 仍可承载私有字节",
    );

    const leakedSourceBrief = path.join(projectDir, "source-brief.json");
    await writeFile(leakedSourceBrief, `${JSON.stringify(sourceBrief, null, 2)}\n`);
    const leakedSourceResult = await verifyProject(projectDir);
    assert(
      !leakedSourceResult.ok && leakedSourceResult.errors.some((item) => item.includes("不得包含 source-brief.json")),
      "工程误带 source brief 时未被拒绝",
    );
    await rm(leakedSourceBrief);

    const files = await Promise.all([
      readFile(path.join(projectDir, "delivery-brief.json"), "utf8"),
      readFile(path.join(projectDir, "index.html"), "utf8"),
    ]);
    assert(!files[0].includes(root), "delivery brief 泄露授权执行路径");
    assert(files[1].includes("const settle = 1 - clamp"), "card 基线缺少稳定收束逻辑");
    assert(
      !files[1].includes("requestAnimationFrame(") &&
        !files[1].includes("setInterval(") &&
        files[1].includes("seek: (t) => applyFrame(t)"),
      "基线 timeline 使用了与寻帧不一致的墙钟动画，或缺少确定性 seek",
    );

    const secondScaffold = runNode("scaffold_project.mjs", [sourcePath, root]);
    assert(secondScaffold.status !== 0, "脚手架错误覆盖了已有非空工程");

    const delivery = JSON.parse(files[0]);
    delivery.use_case = "https://unexpected.example";
    await writeFile(deliveryPath, `${JSON.stringify(delivery, null, 2)}\n`);
    const remoteResult = await verifyProject(projectDir);
    assert(!remoteResult.ok && remoteResult.errors.some((item) => item.includes("远程 URL")), "工程远程 URL 未被拒绝");
    await writeFile(deliveryPath, files[0]);

    const withoutCsp = files[1].replace(
      /\s*<meta http-equiv="Content-Security-Policy"[^>]*\/>/,
      "",
    );
    await writeFile(indexPath, withoutCsp);
    const missingCspResult = await verifyProject(projectDir);
    assert(
      !missingCspResult.ok && missingCspResult.errors.some((item) => item.includes("CSP")),
      "删除离线 CSP 后工程错误通过",
    );
    const networkScript = files[1].replace(
      "</body>",
      '<script>fetch(String.fromCharCode(104,116,116,112,115,58,47,47,101,120,97,109,112,108,101,46,99,111,109));</script></body>',
    );
    await writeFile(indexPath, networkScript);
    const networkScriptResult = await verifyProject(projectDir);
    assert(
      !networkScriptResult.ok &&
        networkScriptResult.errors.some((item) => item.includes("网络") || item.includes("fetch")),
      "执行脚本包含网络 API 时工程错误通过",
    );
    await writeFile(indexPath, files[1]);

    delivery.use_case = "素材来自 /etc/passwd 所在目录";
    await writeFile(deliveryPath, `${JSON.stringify(delivery, null, 2)}\n`);
    const absolutePathResult = await verifyProject(projectDir);
    assert(
      !absolutePathResult.ok &&
        absolutePathResult.errors.some((item) => item.includes("绝对源路径")),
      "嵌入式任意 POSIX 绝对路径未被拒绝",
    );
    await writeFile(deliveryPath, files[0]);

    const hyperframesPath = path.join(projectDir, "hyperframes.json");
    const planPath = path.join(projectDir, "animation-plan.json");
    const [originalHyperframes, originalPlan] = await Promise.all([
      readFile(hyperframesPath, "utf8"),
      readFile(planPath, "utf8"),
    ]);
    const hugeDelivery = { ...JSON.parse(files[0]), duration_seconds: 1_000_000_000 };
    const hugeHyperframes = { ...JSON.parse(originalHyperframes), duration: 1_000_000_000 };
    const hugePlan = { ...JSON.parse(originalPlan), duration_seconds: 1_000_000_000 };
    hugePlan.scenes = hugePlan.scenes.map((scene) => ({ ...scene, duration: 1_000_000_000 }));
    await Promise.all([
      writeFile(deliveryPath, `${JSON.stringify(hugeDelivery, null, 2)}\n`),
      writeFile(hyperframesPath, `${JSON.stringify(hugeHyperframes, null, 2)}\n`),
      writeFile(planPath, `${JSON.stringify(hugePlan, null, 2)}\n`),
      writeFile(indexPath, files[1].replace('data-duration="6"', 'data-duration="1000000000"')),
    ]);
    const hugeDurationResult = await verifyProject(projectDir);
    assert(
      !hugeDurationResult.ok &&
        hugeDurationResult.errors.some((item) => item.includes("时长") || item.includes("duration")),
      "相互一致但超出功能上限的工程时长错误通过",
    );
    await Promise.all([
      writeFile(deliveryPath, files[0]),
      writeFile(hyperframesPath, originalHyperframes),
      writeFile(planPath, originalPlan),
      writeFile(indexPath, files[1]),
    ]);

    const withoutRegistration = files[1].replace(
      /window\.__timelines\["self-test-card"\]\s*=\s*\{/,
      'const removedTimeline = { /* window.__timelines string remains */',
    );
    await writeFile(indexPath, withoutRegistration);
    const fakeTimelineResult = await verifyProject(projectDir);
    assert(
      !fakeTimelineResult.ok &&
        fakeTimelineResult.errors.some((item) => item.includes("实际 timeline 注册")),
      "只保留 timeline 字符串时工程错误通过",
    );
    await writeFile(indexPath, files[1]);

    const nestedTimelineOnly = files[1].replace(
      /window\.__timelines\["self-test-card"\]\s*=\s*\{[\s\S]*?\n\};/,
      'window.__timelines["self-test-card"] = { nested: { duration: 1, time: 1, seek: 1 } };',
    );
    await writeFile(indexPath, nestedTimelineOnly);
    const nestedTimelineResult = await verifyProject(projectDir);
    assert(
      !nestedTimelineResult.ok &&
        nestedTimelineResult.errors.some((item) => item.includes("实际 timeline 注册")),
      "仅在嵌套对象中伪造 duration/time/seek 时工程错误通过",
    );
    const scalarTimelineOnly = files[1].replace(
      /window\.__timelines\["self-test-card"\]\s*=\s*\{[\s\S]*?\n\};/,
      'window.__timelines["self-test-card"] = { duration: 1, time: 1, seek: 1 };',
    );
    await writeFile(indexPath, scalarTimelineOnly);
    const scalarTimelineResult = await verifyProject(projectDir);
    assert(
      !scalarTimelineResult.ok &&
        scalarTimelineResult.errors.some((item) => item.includes("实际 timeline 注册")),
      "顶层 duration/time/seek 不是函数时工程错误通过",
    );
    await writeFile(indexPath, files[1]);

    const fakeMedia = path.join(root, "fake.mp4");
    await writeFile(fakeMedia, Buffer.alloc(2048));
    const validContractProbe = () => ({
      error: null,
      status: 0,
      stderr: "",
      stdout: JSON.stringify({
        format: { duration: 6, format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
        streams: [
          {
            codec_type: "video",
            width: 1080,
            height: 1080,
            codec_name: "h264",
            pix_fmt: "yuv420p",
            r_frame_rate: "30/1",
            avg_frame_rate: "30/1",
          },
        ],
      }),
    });
    for (const field of ["message", "use_case", "style", "facts_to_preserve"]) {
      const incompleteDelivery = JSON.parse(files[0]);
      delete incompleteDelivery[field];
      await writeFile(deliveryPath, `${JSON.stringify(incompleteDelivery, null, 2)}\n`);
      const incompleteProject = await verifyProject(projectDir);
      assert(
        !incompleteProject.ok &&
          incompleteProject.errors.some((item) => item.includes(field)),
        `删除 ${field} 后工程契约错误通过`,
      );
      const incompleteArtifact = await verifyDelivery(fakeMedia, deliveryPath, {
        spawnSync: validContractProbe,
      });
      assert(
        !incompleteArtifact.ok &&
          incompleteArtifact.errors.some((item) => item.includes(field)),
        `删除 ${field} 后成品契约错误通过`,
      );
    }
    await writeFile(deliveryPath, files[0]);
    const missingProbe = await verifyDelivery(fakeMedia, deliveryPath, {
      spawnSync: () => ({ error: { code: "ENOENT" }, status: null, stdout: "", stderr: "" }),
    });
    assert(!missingProbe.ok && missingProbe.errors.some((item) => item.includes("未找到 ffprobe")), "缺少 ffprobe 时错误通过");
    const mockMp4Probe = (streams) => () => ({
      error: null,
      status: 0,
      stderr: "",
      stdout: JSON.stringify({
        format: { duration: 6, format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
        streams,
      }),
    });
    const validVideoStream = {
      codec_type: "video",
      width: 1080,
      height: 1080,
      codec_name: "h264",
      pix_fmt: "yuv420p",
      r_frame_rate: "30/1",
      avg_frame_rate: "30/1",
    };
    const audioStreamResult = await verifyDelivery(fakeMedia, deliveryPath, {
      spawnSync: mockMp4Probe([
        validVideoStream,
        { codec_type: "audio", codec_name: "aac" },
      ]),
    });
    assert(
      !audioStreamResult.ok &&
        audioStreamResult.errors.some((item) => item.includes("恰好包含一个 video stream")),
      "含 AAC 音频流的 MP4 错误通过首版纯视频契约",
    );
    const wrongCodecResult = await verifyDelivery(fakeMedia, deliveryPath, {
      spawnSync: mockMp4Probe([{ ...validVideoStream, codec_name: "hevc" }]),
    });
    assert(
      !wrongCodecResult.ok && wrongCodecResult.errors.some((item) => item.includes("h264")),
      "非 H.264 MP4 错误通过编码契约",
    );

    const gifHeader = Buffer.alloc(13);
    gifHeader.write("GIF89a", 0, "ascii");
    gifHeader.writeUInt16LE(512, 6);
    gifHeader.writeUInt16LE(512, 8);
    const gifComment = (firstPayload = Buffer.alloc(255, 0x43)) =>
      Buffer.concat([
        Buffer.from([0x21, 0xfe, firstPayload.length]),
        firstPayload,
        ...Array.from({ length: 4 }, () => Buffer.concat([Buffer.from([255]), Buffer.alloc(255, 0x43)])),
        Buffer.from([0]),
      ]);
    const netscapeLoop = Buffer.concat([
      Buffer.from([0x21, 0xff, 0x0b]),
      Buffer.from("NETSCAPE2.0", "ascii"),
      Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]),
    ]);
    const fakeGif = path.join(root, "fake.gif");
    await writeFile(
      fakeGif,
      Buffer.concat([gifHeader, netscapeLoop, gifComment(), Buffer.from([0x3b])]),
    );
    const gifBriefPath = path.join(root, "gif-delivery-brief.json");
    const gifBrief = {
      ...JSON.parse(files[0]),
      output_format: "gif",
      aspect_ratio: "1:1",
      loop: true,
    };
    await writeFile(gifBriefPath, `${JSON.stringify(gifBrief, null, 2)}\n`);
    const mockGifProbe = (width, height) => () => ({
      error: null,
      status: 0,
      stderr: "",
      stdout: JSON.stringify({
        format: { duration: gifBrief.duration_seconds, format_name: "gif" },
        streams: [
          {
            codec_type: "video",
            width,
            height,
            codec_name: "gif",
            pix_fmt: "bgra",
            r_frame_rate: "12/1",
            avg_frame_rate: "12/1",
          },
        ],
      }),
    });
    const wrongGifSize = await verifyDelivery(fakeGif, gifBriefPath, {
      spawnSync: mockGifProbe(1, 1),
    });
    assert(
      !wrongGifSize.ok && wrongGifSize.errors.some((item) => item.includes("GIF优化契约")),
      "1×1 假 GIF 仅靠正确比例错误通过绝对尺寸门",
    );
    const validGifContract = await verifyDelivery(fakeGif, gifBriefPath, {
      spawnSync: mockGifProbe(512, 512),
    });
    assert(validGifContract.ok, `合法 GIF 尺寸/无限循环契约被误拒：${validGifContract.errors.join("；")}`);
    const commentSpoofPayload = Buffer.alloc(255, 0x53);
    Buffer.from("NETSCAPE2.0", "ascii").copy(commentSpoofPayload, 0);
    Buffer.from([0x03, 0x01, 0x00, 0x00]).copy(commentSpoofPayload, 11);
    const commentSpoofGif = path.join(root, "comment-spoof.gif");
    await writeFile(
      commentSpoofGif,
      Buffer.concat([gifHeader, gifComment(commentSpoofPayload), Buffer.from([0x3b])]),
    );
    const spoofLoopResult = await verifyDelivery(commentSpoofGif, gifBriefPath, {
      spawnSync: mockGifProbe(512, 512),
    });
    assert(
      !spoofLoopResult.ok && spoofLoopResult.errors.some((item) => item.includes("未声明无限循环")),
      "GIF Comment Extension 中伪造 NETSCAPE 字节错误通过循环契约",
    );
    gifBrief.loop = false;
    await writeFile(gifBriefPath, `${JSON.stringify(gifBrief, null, 2)}\n`);
    const falseLoopGif = await verifyDelivery(fakeGif, gifBriefPath, {
      spawnSync: mockGifProbe(512, 512),
    });
    assert(
      !falseLoopGif.ok && falseLoopGif.errors.some((item) => item.includes("要求非循环")),
      "brief.loop=false 时含 NETSCAPE 无限循环扩展的 GIF 错误通过",
    );

    console.log(
      "结果：通过（授权前置门、brief/素材资源上限、GIF/APNG/伪PNG、PNG/JPEG私有元数据、JPEG真解码、宽路径拒绝、事务回滚/无覆写、离线CSP/网络API门、确定性时间线、严格工程契约、工程与快照摘要绑定的人工预览批准、冻结执行入口、CLI后台请求抑制、浏览器离线守卫、成品单视频流/编码/尺寸/帧率/GIF循环、ffprobe强校验）",
    );
    return 0;
  } catch (error) {
    console.error(`自检失败：${error.message}`);
    return 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

process.exitCode = await main();

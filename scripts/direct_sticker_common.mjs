import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MAX_DIRECT_BRIEF_BYTES = 256 * 1024;
export const MAX_DIRECT_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_DIRECT_VIDEO_BYTES = 512 * 1024 * 1024;
export const MAX_DIRECT_VIDEO_SECONDS = 4 * 60 * 60;
export const MAX_SEMANTIC_SEARCH_SECONDS = 30 * 60;
export const MAX_DIRECT_PIXELS = 12_000_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

const STYLES = new Set(["warm", "playful", "clean", "energetic"]);
const PRIVACY_STATUSES = new Set([
  "reviewed-no-sensitive-content",
  "user-confirmed-keep",
  "source-already-redacted",
]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);
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

function nonempty(value, maximum = Infinity) {
  return typeof value === "string" && value.trim().length > 0 && [...value.trim()].length <= maximum;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function unknownKeys(object, allowed, label, errors) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return;
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length) errors.push(`${label} 含未知字段：${unknown.join("、")}`);
}

export async function readStableJson(filePath, label = "JSON 文件", maximum = MAX_DIRECT_BRIEF_BYTES) {
  const linkInfo = await lstat(filePath);
  if (linkInfo.isSymbolicLink()) throw new Error(`${label} 不得是符号链接`);
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (info.dev !== linkInfo.dev || info.ino !== linkInfo.ino) throw new Error(`${label} 在检查与打开之间被替换`);
    if (!info.isFile()) throw new Error(`${label} 不是普通文件`);
    if (info.size > maximum) throw new Error(`${label} 超过大小上限`);
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (
      bytesRead !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    ) {
      throw new Error(`${label} 在读取期间发生变化`);
    }
    const parsed = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} 顶层必须是对象`);
    }
    return parsed;
  } finally {
    await handle.close();
  }
}

export async function readDirectBrief(filePath) {
  return readStableJson(filePath, "direct sticker brief", MAX_DIRECT_BRIEF_BYTES);
}

export function validateDirectBriefShape(brief) {
  const errors = [];
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) {
    return ["direct sticker brief 顶层必须是对象"];
  }
  unknownKeys(
    brief,
    [
      "schema_kind",
      "schema_version",
      "project_name",
      "source",
      "approved_media_roots",
      "clip",
      "message",
      "use_case",
      "aspect_ratio",
      "duration_seconds",
      "output_format",
      "style",
      "loop",
      "text_position",
      "crop_anchor",
      "facts_to_preserve",
      "privacy_review",
    ],
    "direct sticker brief",
    errors,
  );
  if (brief.schema_kind !== "direct-sticker-source" || brief.schema_version !== 1) {
    errors.push('必须声明 schema_kind: "direct-sticker-source" 和 schema_version: 1');
  }
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(brief.project_name || "")) {
    errors.push("project_name 必须是1—48位英文小写、数字或短横线");
  }

  const source = brief.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    errors.push("source 必须是对象");
  } else {
    unknownKeys(source, ["path", "source_id", "kind", "authorized", "alt"], "source", errors);
    if (!path.isAbsolute(source.path || "")) errors.push("source.path 必须是绝对路径");
    if (!nonempty(source.source_id, 80)) errors.push("source.source_id 必须是1—80个字符");
    if (!new Set(["video", "image"]).has(source.kind)) errors.push("source.kind 必须是 video 或 image");
    if (source.authorized !== true) errors.push("source.authorized 必须显式为 true");
    if ("alt" in source && !nonempty(source.alt, 120)) errors.push("source.alt 必须是1—120个字符");
    const extension = path.extname(source.path || "").toLowerCase();
    if (source.kind === "video" && !VIDEO_EXTENSIONS.has(extension)) {
      errors.push("视频输入只接受 MP4、MOV、WebM 或 MKV");
    }
    if (source.kind === "image" && !IMAGE_EXTENSIONS.has(extension)) {
      errors.push("静态输入只接受 JPEG 或 PNG");
    }
  }

  if (!Array.isArray(brief.approved_media_roots) || brief.approved_media_roots.length < 1) {
    errors.push("approved_media_roots 必须至少包含一个本轮授权目录");
  } else if (brief.approved_media_roots.length > 12) {
    errors.push("approved_media_roots 最多12项");
  }

  const message = brief.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    errors.push("message 必须是对象");
  } else {
    unknownKeys(message, ["title"], "message", errors);
    if (!nonempty(message.title, 16)) errors.push("message.title 必须是1—16个字符");
  }
  if (!nonempty(brief.use_case, 30)) errors.push("use_case 必须是1—30个字符");
  if (brief.aspect_ratio !== "1:1") errors.push("direct sticker v1 只支持 1:1");
  if (!STYLES.has(brief.style)) errors.push("style 必须是 warm、playful、clean 或 energetic");
  if (!new Set(["top", "bottom"]).has(brief.text_position)) {
    errors.push("text_position 必须是 top 或 bottom；direct sticker v1 不猜测 auto");
  }
  if (!new Set(["center", "top", "bottom", "left", "right"]).has(brief.crop_anchor)) {
    errors.push("crop_anchor 必须是 center、top、bottom、left 或 right");
  }
  if (!Array.isArray(brief.facts_to_preserve)) {
    errors.push("facts_to_preserve 必须是数组");
  } else if (
    brief.facts_to_preserve.length > 20 ||
    brief.facts_to_preserve.some((item) => !nonempty(item, 120))
  ) {
    errors.push("facts_to_preserve 最多20项，每项1—120个字符");
  }

  if (source?.kind === "video") {
    if (brief.output_format !== "gif") errors.push("视频片段表情的 output_format 必须是 gif");
    if (!finite(brief.duration_seconds) || brief.duration_seconds < 1.5 || brief.duration_seconds > 6) {
      errors.push("视频片段表情时长必须在1.5—6秒");
    }
    if (brief.loop !== true) errors.push("视频 GIF 表情必须设置 loop: true");
    const clip = brief.clip;
    if (!clip || typeof clip !== "object" || Array.isArray(clip)) {
      errors.push("视频输入必须包含 clip 对象");
    } else {
      unknownKeys(
        clip,
        [
          "mode",
          "query",
          "start_seconds",
          "end_seconds",
          "resolved_start_seconds",
          "resolved_end_seconds",
          "evidence_samples",
          "approximate_start_seconds",
          "approximate_end_seconds",
          "selection_index_path",
        ],
        "clip",
        errors,
      );
      if (!new Set(["time-range", "visual-query"]).has(clip.mode)) {
        errors.push("clip.mode 必须是 time-range 或 visual-query");
      }
      if (clip.mode === "time-range") {
        if (!finite(clip.start_seconds) || !finite(clip.end_seconds) || clip.start_seconds < 0 || clip.end_seconds <= clip.start_seconds) {
          errors.push("time-range 必须提供有效的 start_seconds 和 end_seconds");
        }
      }
      if (clip.mode === "visual-query") {
        if (!nonempty(clip.query, 120)) errors.push("visual-query 必须提供1—120个字符的 query");
        const hasResolved = finite(clip.resolved_start_seconds) || finite(clip.resolved_end_seconds);
        if (
          hasResolved &&
          (!finite(clip.resolved_start_seconds) ||
            !finite(clip.resolved_end_seconds) ||
            clip.resolved_start_seconds < 0 ||
            clip.resolved_end_seconds <= clip.resolved_start_seconds)
        ) {
          errors.push("语义片段的 resolved_start_seconds / resolved_end_seconds 必须成对且有效");
        }
        if (hasResolved) {
          if (
            !Array.isArray(clip.evidence_samples) ||
            clip.evidence_samples.length < 1 ||
            clip.evidence_samples.length > 12 ||
            clip.evidence_samples.some((item) => !Number.isInteger(item) || item < 1 || item > 48) ||
            new Set(clip.evidence_samples).size !== clip.evidence_samples.length
          ) {
            errors.push("已解析 visual-query 必须包含1—12个不重复的 evidence_samples 编号");
          }
          if (!path.isAbsolute(clip.selection_index_path || "")) {
            errors.push("已解析 visual-query 必须提供绝对 selection_index_path 以绑定联系表证据");
          }
        } else if ("evidence_samples" in clip) {
          errors.push("尚未解析的 visual-query 不得提前填写 evidence_samples");
        } else if ("selection_index_path" in clip) {
          errors.push("尚未解析的 visual-query 不得提前填写 selection_index_path");
        }
        const hasApproximate = finite(clip.approximate_start_seconds) || finite(clip.approximate_end_seconds);
        if (
          hasApproximate &&
          (!finite(clip.approximate_start_seconds) ||
            !finite(clip.approximate_end_seconds) ||
            clip.approximate_start_seconds < 0 ||
            clip.approximate_end_seconds <= clip.approximate_start_seconds)
        ) {
          errors.push("approximate_start_seconds / approximate_end_seconds 必须成对且有效");
        }
      }
    }
  }
  if (source?.kind === "image") {
    if (brief.output_format !== "png") errors.push("静态表情的 output_format 必须是 png");
    if (brief.duration_seconds !== 0) errors.push("静态表情的 duration_seconds 必须是 0");
    if (brief.loop !== false) errors.push("静态表情必须设置 loop: false");
    if ("clip" in brief) errors.push("静态图片输入不得包含 clip");
  }

  const privacy = brief.privacy_review;
  if (!privacy || typeof privacy !== "object" || Array.isArray(privacy)) {
    errors.push("privacy_review 必须是对象");
  } else {
    unknownKeys(privacy, ["status", "confirmation", "actions"], "privacy_review", errors);
    if (!PRIVACY_STATUSES.has(privacy.status)) errors.push("privacy_review.status 无效");
    if (!nonempty(privacy.confirmation, 200)) errors.push("privacy_review.confirmation 必须是1—200个字符");
    if (!Array.isArray(privacy.actions)) {
      errors.push("privacy_review.actions 必须是数组");
    } else {
      if (privacy.actions.length > 10 || privacy.actions.some((item) => !nonempty(item, 100))) {
        errors.push("privacy_review.actions 最多10项，每项1—100个字符");
      }
      if (privacy.status === "source-already-redacted" && privacy.actions.length === 0) {
        errors.push("source-already-redacted 必须记录已完成的脱敏动作");
      }
      if (privacy.status !== "source-already-redacted" && privacy.actions.length > 0) {
        errors.push("只有 source-already-redacted 可以包含 privacy_review.actions");
      }
    }
  }
  return errors;
}

async function resolveApprovedRoots(roots) {
  const errors = [];
  const resolved = [];
  let homePath = os.homedir();
  try {
    homePath = await realpath(homePath);
  } catch {
    // Keep the platform path for the broad-root guard.
  }
  for (const [index, root] of roots.entries()) {
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
      const actual = await realpath(root);
      const segments = path.relative(path.parse(actual).root, actual).split(path.sep).filter(Boolean);
      if (
        actual === path.parse(actual).root ||
        actual === homePath ||
        BROAD_MEDIA_ROOTS.has(actual) ||
        segments.length <= 1
      ) {
        errors.push(`approved_media_roots[${index}] 范围过宽`);
        continue;
      }
      resolved.push(actual);
    } catch {
      errors.push(`approved_media_roots[${index}] 不存在`);
    }
  }
  if (errors.length) throw new Error(errors.join("；"));
  return resolved;
}

function insideRoot(filePath, roots) {
  return roots.some((root) => {
    const relative = path.relative(root, filePath);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  });
}

export async function stageAuthorizedSource(brief) {
  const shapeErrors = validateDirectBriefShape(brief);
  if (shapeErrors.length) throw new Error(shapeErrors.join("；"));
  const roots = await resolveApprovedRoots(brief.approved_media_roots);
  const sourcePath = brief.source.path;
  const linkInfo = await lstat(sourcePath);
  if (linkInfo.isSymbolicLink()) throw new Error("source.path 不得是符号链接");
  const resolved = await realpath(sourcePath);
  if (!insideRoot(resolved, roots)) throw new Error("source.path 不在 approved_media_roots 内");
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let tempDirectory = null;
  let outputHandle = null;
  try {
    const info = await handle.stat();
    if (info.dev !== linkInfo.dev || info.ino !== linkInfo.ino) throw new Error("source.path 在授权检查与打开之间被替换");
    const assertCurrentPathBinding = async () => {
      const currentLink = await lstat(sourcePath);
      if (currentLink.isSymbolicLink()) throw new Error("source.path 在处理期间被替换为符号链接");
      const currentReal = await realpath(sourcePath);
      if (currentReal !== resolved || currentLink.dev !== info.dev || currentLink.ino !== info.ino) {
        throw new Error("source.path 或其祖先目录在处理期间发生变化");
      }
    };
    await assertCurrentPathBinding();
    if (!info.isFile() || info.size <= 0) throw new Error("source.path 不是非空普通文件");
    const maximum = brief.source.kind === "video" ? MAX_DIRECT_VIDEO_BYTES : MAX_DIRECT_IMAGE_BYTES;
    if (info.size > maximum) {
      throw new Error(`source.path 超过${brief.source.kind === "video" ? "512MB" : "25MB"}上限`);
    }
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), "create-animation-direct-"));
    await chmod(tempDirectory, 0o700);
    const extension = path.extname(resolved).toLowerCase();
    const stagedPath = path.join(tempDirectory, `source${extension}`);
    outputHandle = await open(stagedPath, "wx", 0o600);
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < info.size) {
      const length = Math.min(chunk.length, info.size - offset);
      const result = await handle.read(chunk, 0, length, offset);
      if (!result.bytesRead) break;
      await outputHandle.write(chunk, 0, result.bytesRead, offset);
      hash.update(chunk.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    if (offset !== info.size) throw new Error("source.path 在复制时提前结束");
    await outputHandle.sync();
    const after = await handle.stat();
    if (
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs ||
      after.dev !== info.dev ||
      after.ino !== info.ino
    ) {
      throw new Error("source.path 在复制期间发生变化");
    }
    await assertCurrentPathBinding();
    await outputHandle.close();
    outputHandle = null;
    return {
      stagedPath,
      sourceSha256: hash.digest("hex"),
      sourceBytes: info.size,
      cleanup: async () => rm(tempDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    await outputHandle?.close().catch(() => {});
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
}

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: DEFAULT_COMMAND_TIMEOUT_MS,
    ...options,
  });
  if (result.error) throw new Error(`${command} 启动失败：${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} 执行失败：${(result.stderr || result.stdout || `退出码 ${result.status}`).trim()}`);
  }
  return result;
}

export function probeMedia(filePath) {
  const executable = process.env.FFPROBE_PATH || "ffprobe";
  const result = runCommand(executable, [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    filePath,
  ], { timeout: 20_000 });
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`ffprobe 输出不是有效 JSON：${error.message}`);
  }
}

export function inspectSourceProbe(brief, probe) {
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const videos = streams.filter((stream) => stream.codec_type === "video");
  const audios = streams.filter((stream) => stream.codec_type === "audio");
  const unsupported = streams.filter((stream) => !new Set(["video", "audio"]).has(stream.codec_type));
  if (videos.length !== 1) throw new Error(`输入必须恰好包含一个视频流；实际 ${videos.length}`);
  if (audios.length > 1) throw new Error("输入最多包含一个音频流");
  if (unsupported.length) throw new Error("输入不得包含字幕、数据或附件流");
  const video = videos[0];
  const width = Number(video.width);
  const height = Number(video.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64) {
    throw new Error("输入视频流缺少有效尺寸或尺寸小于64×64");
  }
  if (width * height > MAX_DIRECT_PIXELS) throw new Error("输入视频流超过1200万像素上限");
  const durationCandidates = [probe.format?.duration, video.duration].map(Number).filter(Number.isFinite);
  const duration = durationCandidates[0];
  if (brief.source.kind === "video") {
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_DIRECT_VIDEO_SECONDS) {
      throw new Error("视频时长必须大于0且不超过4小时");
    }
  }
  if (brief.source.kind === "image") {
    const formatNames = String(probe.format?.format_name || "").split(",");
    const imageFormats = new Set(["image2", "image2pipe", "jpeg_pipe", "png_pipe"]);
    if (!new Set(["png", "mjpeg"]).has(video.codec_name) || !formatNames.some((name) => imageFormats.has(name))) {
      throw new Error("静态输入真实容器与编码必须是单张 JPEG 或 PNG");
    }
    if (audios.length) throw new Error("静态 JPEG/PNG 不得包含音频流");
  }
  return {
    duration: brief.source.kind === "video" ? duration : 0,
    width,
    height,
    codec: video.codec_name,
    hasAudio: audios.length === 1,
  };
}

export async function createOutputProject(parentDirectory, projectName, subdirectories = []) {
  if (!path.isAbsolute(parentDirectory)) throw new Error("输出父目录必须是绝对路径");
  const linkInfo = await lstat(parentDirectory);
  if (linkInfo.isSymbolicLink()) throw new Error("输出父目录不得是符号链接");
  const info = await stat(parentDirectory);
  if (!info.isDirectory()) throw new Error("输出父目录不是目录");
  const resolvedParent = await realpath(parentDirectory);
  const projectDirectory = path.join(resolvedParent, projectName);
  await mkdir(projectDirectory, { mode: 0o700 });
  for (const subdirectory of subdirectories) {
    await mkdir(path.join(projectDirectory, subdirectory), { mode: 0o700 });
  }
  return projectDirectory;
}

export async function writeJsonExclusive(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

export async function sha256File(filePath, maximum = 64 * 1024 * 1024) {
  const linkInfo = await lstat(filePath);
  if (linkInfo.isSymbolicLink()) throw new Error("待校验文件不得是符号链接");
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (info.dev !== linkInfo.dev || info.ino !== linkInfo.ino) throw new Error("待校验文件在检查与打开之间被替换");
    if (!info.isFile() || info.size <= 0 || info.size > maximum) throw new Error("待校验文件大小无效");
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < info.size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, info.size - offset), offset);
      if (!bytesRead) break;
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
      throw new Error("待校验文件在读取期间发生变化");
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

export function directFontCandidates() {
  return [
    process.env.CREATE_ANIMATION_FONT_PATH,
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/Library/Fonts/Microsoft Yahei.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
  ].filter(Boolean);
}

export function resolveFontPath() {
  const candidates = directFontCandidates();
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("缺少可用的本地中文字体；请设置 CREATE_ANIMATION_FONT_PATH");
}

export async function verifySemanticSelectionEvidence(brief, stagedSourceSha256) {
  if (brief.source.kind !== "video" || brief.clip?.mode !== "visual-query") return null;
  if (!finite(brief.clip.resolved_start_seconds) || !finite(brief.clip.resolved_end_seconds)) {
    throw new Error("visual-query 尚未解析，无法验证联系表证据");
  }
  const index = await readStableJson(brief.clip.selection_index_path, "selection-index.json");
  if (index.schema_kind !== "direct-sticker-selection" || index.schema_version !== 1) {
    throw new Error("selection-index.json schema 无效");
  }
  if (index.project_name !== brief.project_name || index.source?.source_id !== brief.source.source_id) {
    throw new Error("selection-index.json 与 project/source_id 不一致");
  }
  if (index.source?.sha256 !== stagedSourceSha256) throw new Error("selection-index.json 与当前源素材摘要不一致");
  if (index.query !== brief.clip.query) throw new Error("selection-index.json 与 visual-query 文案不一致");
  if (!Array.isArray(index.sheets) || index.sheets.length < 1 || index.sheets.length > 4) {
    throw new Error("selection-index.json 缺少联系表像素摘要");
  }
  const sheetFiles = [];
  const indexDirectory = path.dirname(brief.clip.selection_index_path);
  for (let sheetIndex = 0; sheetIndex < index.sheets.length; sheetIndex += 1) {
    const sheet = index.sheets[sheetIndex];
    const expectedPath = `selection/sheet-${String(sheetIndex + 1).padStart(2, "0")}.jpg`;
    if (sheet?.path !== expectedPath || !/^[a-f0-9]{64}$/.test(sheet.sha256 || "")) {
      throw new Error("selection-index.json 联系表路径或摘要无效");
    }
    const absolute = path.join(indexDirectory, sheet.path);
    const relative = path.relative(indexDirectory, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("selection-index.json 联系表路径越界");
    const actual = await sha256File(absolute, 16 * 1024 * 1024);
    if (actual !== sheet.sha256) throw new Error(`${sheet.path} 与 selection-index.json 摘要不一致`);
    sheetFiles.push({ source: absolute, relative: sheet.path, sha256: actual });
  }
  const samples = Array.isArray(index.samples) ? index.samples : [];
  const byNumber = new Map(samples.map((sample) => [sample.sample, sample]));
  const evidence = brief.clip.evidence_samples.map((number) => byNumber.get(number));
  if (evidence.some((sample) => !sample || !finite(sample.seconds))) {
    throw new Error("evidence_samples 未全部出现在 selection-index.json");
  }
  const interval = Number(index.search_range?.interval_seconds);
  if (!Number.isFinite(interval) || interval <= 0) throw new Error("selection-index.json 缺少有效抽样间隔");
  const times = evidence.map((sample) => sample.seconds);
  const lower = Math.min(...times) - interval - 0.05;
  const upper = Math.max(...times) + interval + 0.05;
  if (brief.clip.resolved_end_seconds < lower || brief.clip.resolved_start_seconds > upper) {
    throw new Error("resolved 时间段与 evidence_samples 的联系表时间不相交");
  }
  const digest = createHash("sha256").update(JSON.stringify(index)).digest("hex");
  return { index, digest, sheetFiles };
}

export function requireDirectFfmpegFeatures(outputFormat) {
  const executable = process.env.FFMPEG_PATH || "ffmpeg";
  const result = runCommand(executable, ["-hide_banner", "-filters"], { timeout: 10_000 });
  if (!/\bdrawtext\b/.test(result.stdout)) throw new Error("预装 FFmpeg 缺少 drawtext/libfreetype");
  if (outputFormat === "gif" && (!/\bpalettegen\b/.test(result.stdout) || !/\bpaletteuse\b/.test(result.stdout))) {
    throw new Error("预装 FFmpeg 缺少 GIF 调色板滤镜");
  }
  const encoders = runCommand(executable, ["-hide_banner", "-encoders"], { timeout: 10_000 }).stdout;
  const muxers = runCommand(executable, ["-hide_banner", "-muxers"], { timeout: 10_000 }).stdout;
  const demuxers = runCommand(executable, ["-hide_banner", "-demuxers"], { timeout: 10_000 }).stdout;
  if (outputFormat === "png" && (!/\bpng\b/.test(encoders) || !/\bimage2\b/.test(muxers))) {
    throw new Error("预装 FFmpeg 缺少 PNG encoder 或 image2 muxer");
  }
  if (outputFormat === "gif" && (!/\bgif\b/.test(encoders) || !/\bgif\b/.test(muxers))) {
    throw new Error("预装 FFmpeg 缺少 GIF encoder 或 muxer");
  }
  if (outputFormat === "selection" && (!/\bmjpeg\b/.test(encoders) || !/\bimage2\b/.test(muxers) || !/\bimage2\b/.test(demuxers))) {
    throw new Error("预装 FFmpeg 缺少联系表所需的 MJPEG encoder 或 image2 muxer/demuxer");
  }
  return executable;
}

export function escapeFilterPath(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export function resolvedClipRange(brief, sourceDuration) {
  const clip = brief.clip;
  let start;
  let end;
  if (clip.mode === "time-range") {
    start = clip.start_seconds;
    end = clip.end_seconds;
  } else {
    if (!finite(clip.resolved_start_seconds) || !finite(clip.resolved_end_seconds)) {
      throw new Error("visual-query 尚未解析为时间段；先运行 prepare_video_selection.mjs 并查看联系表");
    }
    start = clip.resolved_start_seconds;
    end = clip.resolved_end_seconds;
  }
  const duration = end - start;
  if (duration < 1.5 || duration > 6) throw new Error("最终截取片段必须在1.5—6秒");
  if (Math.abs(duration - brief.duration_seconds) > 0.05) {
    throw new Error("clip 时间段长度必须与 duration_seconds 一致");
  }
  if (start < 0 || end > sourceDuration + 0.05) throw new Error("clip 时间段超出源视频时长");
  return { start, end, duration };
}

export function assertSemanticSearchRange(brief, sourceDuration) {
  const clip = brief.clip;
  if (clip.mode !== "visual-query") throw new Error("只有 visual-query 需要生成联系表");
  if (finite(clip.resolved_start_seconds) && finite(clip.resolved_end_seconds)) {
    throw new Error("visual-query 已有解析时间段，不需要再次生成联系表");
  }
  let start = 0;
  let end = sourceDuration;
  if (finite(clip.approximate_start_seconds) && finite(clip.approximate_end_seconds)) {
    start = clip.approximate_start_seconds;
    end = clip.approximate_end_seconds;
  } else if (sourceDuration > MAX_SEMANTIC_SEARCH_SECONDS) {
    throw new Error("视频超过30分钟；语义找片段前请让用户提供大概分钟范围");
  }
  if (start < 0 || end <= start || end > sourceDuration + 0.05) {
    throw new Error("语义搜索范围超出源视频时长");
  }
  const rangeDuration = end - start;
  if (rangeDuration > MAX_SEMANTIC_SEARCH_SECONDS) {
    throw new Error("单次语义搜索范围不得超过30分钟；请让用户提供更窄的大概分钟范围");
  }
  const sampleCount = rangeDuration <= 60 ? 12 : rangeDuration <= 300 ? 24 : rangeDuration <= 900 ? 36 : 48;
  return { start, end, rangeDuration, sampleCount, interval: rangeDuration / sampleCount };
}

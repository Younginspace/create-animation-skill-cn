#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMPOSITION_CSP, sanitizeImage } from "./scaffold_project.mjs";
import { validateDeliveryBriefContract } from "./delivery_brief_contract.mjs";
import { decodeJpegBuffer, inspectImageBuffer } from "./validate_brief.mjs";

const REQUIRED_FILES = [
  "BRIEF.md",
  "delivery-brief.json",
  "index.html",
  "hyperframes.json",
  "animation-plan.json",
  "asset-manifest.json",
];
const FORBIDDEN_ENTRIES = new Set(["source-brief.json", "brief.json", ".git", "node_modules"]);
const TEXT_EXTENSIONS = new Set([".json", ".md", ".html", ".css", ".js", ".mjs", ".txt", ".yaml", ".yml"]);
const REMOTE_URL = /(?:https?:)?\/\/[^\s"'<>]+/i;
const EMBEDDED_POSIX_PATH =
  /(?:^|[\s"'`=(:,;\[{])(\/(?!\/|[<>*])(?:[\p{L}\p{N}._~@%+-]+\/)*[\p{L}\p{N}._~@%+-]+)(?=$|[\s"'`),:;}\]<>])/u;
const FILE_OR_PLATFORM_PATH = /(?:file:\/\/|[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)/i;
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
const FIXED_DIMS = {
  "1:1": [1080, 1080],
  "9:16": [1080, 1920],
  "16:9": [1920, 1080],
};
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_TEXT_BYTES = 20 * 1024 * 1024;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 300 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_PROJECT_BYTES = 1024 * 1024 * 1024;
const MAX_PROJECT_ENTRIES = 4096;
const MAX_PROJECT_DEPTH = 8;
const MAX_JSON_NODES = 100_000;

function isSafeProjectPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    !value.split(/[\\/]/).includes("..") &&
    !value.includes("\\")
  );
}

function walkStrings(value, visit) {
  const stack = [{ value, location: "$" }];
  let visited = 0;
  while (stack.length) {
    const current = stack.pop();
    visited += 1;
    if (visited > MAX_JSON_NODES) throw new Error(`JSON 节点超过 ${MAX_JSON_NODES}，停止审计`);
    if (typeof current.value === "string") {
      visit(current.value, current.location);
    } else if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], location: `${current.location}[${index}]` });
      }
    } else if (current.value && typeof current.value === "object") {
      for (const [key, item] of Object.entries(current.value)) {
        stack.push({ value: item, location: `${current.location}.${key}` });
      }
    }
  }
}

async function readBoundedFile(file, maximum, label, encoding = null) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("不是普通文件");
    if (before.size > maximum) {
      throw new Error(`超过读取上限 ${Math.floor(maximum / 1024 / 1024)}MiB`);
    }
    const chunks = [];
    let position = 0;
    while (position <= maximum) {
      const buffer = Buffer.alloc(Math.min(1024 * 1024, maximum + 1 - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (position > maximum) {
      throw new Error(`读取期间增长并超过上限 ${Math.floor(maximum / 1024 / 1024)}MiB`);
    }
    const after = await handle.stat();
    if (
      position !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("文件在有界读取期间发生变化");
    }
    const result = Buffer.concat(chunks, position);
    return encoding ? result.toString(encoding) : result;
  } finally {
    await handle.close();
  }
}

async function parseJson(file, label, errors) {
  try {
    return JSON.parse(await readBoundedFile(file, MAX_JSON_BYTES, label, "utf8"));
  } catch (error) {
    errors.push(`${label} 不是可读取的有界 JSON：${error.message}`);
    return null;
  }
}

async function readTextFile(file, maximum, label, errors) {
  try {
    return await readBoundedFile(file, maximum, label, "utf8");
  } catch (error) {
    errors.push(`${label} 不是可读取的有界文本：${error.message}`);
    return null;
  }
}

async function listProjectFiles(root) {
  const pending = [{ relative: "", depth: 0 }];
  const files = [];
  let entryCount = 0;
  let totalBytes = 0;
  while (pending.length) {
    const current = pending.pop();
    const directory = path.join(root, ...current.relative.split("/").filter(Boolean));
    const directoryHandle = await opendir(directory);
    for await (const entry of directoryHandle) {
      entryCount += 1;
      if (entryCount > MAX_PROJECT_ENTRIES) {
        throw new Error(`工程条目超过 ${MAX_PROJECT_ENTRIES}，停止遍历`);
      }
      const projectPath = path.posix.join(current.relative, entry.name);
      const diskPath = path.join(root, ...projectPath.split("/"));
      const info = await lstat(diskPath);
      const depth = current.depth + 1;
      const item = {
        path: projectPath,
        symlink: info.isSymbolicLink(),
        directory: info.isDirectory(),
        file: info.isFile(),
        size: info.isFile() ? info.size : 0,
        depth,
      };
      files.push(item);
      if (info.isFile()) {
        totalBytes += info.size;
        if (totalBytes > MAX_PROJECT_BYTES) throw new Error("工程普通文件总量超过 1GiB，停止遍历");
      }
      if (!info.isFile() && !info.isDirectory() && !info.isSymbolicLink()) {
        throw new Error(`工程含不允许的特殊文件：${projectPath}`);
      }
      if (info.isDirectory() && !FORBIDDEN_ENTRIES.has(entry.name)) {
        if (depth >= MAX_PROJECT_DEPTH) {
          throw new Error(`工程目录深度达到或超过 ${MAX_PROJECT_DEPTH}：${projectPath}`);
        } else {
          pending.push({ relative: projectPath, depth });
        }
      }
    }
  }
  return files;
}

function htmlAttributeValue(html, attribute) {
  const match = html.match(new RegExp(`\\b${attribute}=["']([^"']+)["']`, "i"));
  return match?.[1];
}

function containsAbsolutePath(value) {
  return (
    typeof value === "string" &&
    (path.posix.isAbsolute(value) ||
      path.win32.isAbsolute(value) ||
      FILE_OR_PLATFORM_PATH.test(value) ||
      EMBEDDED_POSIX_PATH.test(value))
  );
}

function javascriptCodeMask(source) {
  const mask = new Uint8Array(source.length);
  let state = "code";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line-comment";
        index += 1;
      } else if (char === "/" && next === "*") {
        state = "block-comment";
        index += 1;
      } else if (char === "'" || char === '"' || char === "`") {
        state = char;
        escaped = false;
      } else {
        mask[index] = 1;
      }
      continue;
    }
    if (state === "line-comment") {
      if (char === "\n" || char === "\r") {
        state = "code";
        mask[index] = 1;
      }
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === state) state = "code";
  }
  return mask;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function skipIgnored(source, mask, start) {
  let index = start;
  while (index < source.length && (!mask[index] || /\s/.test(source[index]))) index += 1;
  return index;
}

function findTopLevelMemberEnd(source, mask, start) {
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  for (let index = start; index < source.length; index += 1) {
    if (!mask[index]) continue;
    const char = source[index];
    if (char === "{") braces += 1;
    else if (char === "}") braces -= 1;
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets -= 1;
    else if (char === "(") parentheses += 1;
    else if (char === ")") parentheses -= 1;
    else if (char === "," && braces === 0 && brackets === 0 && parentheses === 0) return index;
    if (braces < 0 || brackets < 0 || parentheses < 0) return index;
  }
  return source.length;
}

function topLevelObjectMembers(source) {
  const mask = javascriptCodeMask(source);
  const members = new Map();
  let cursor = 0;
  while (cursor < source.length) {
    cursor = skipIgnored(source, mask, cursor);
    while (source[cursor] === "," || source[cursor] === ";") {
      cursor = skipIgnored(source, mask, cursor + 1);
    }
    if (cursor >= source.length) break;
    const keyMatch = source.slice(cursor).match(/^[A-Za-z_$][\w$]*/);
    const memberEnd = findTopLevelMemberEnd(source, mask, cursor);
    if (!keyMatch) {
      cursor = memberEnd + 1;
      continue;
    }
    const key = keyMatch[0];
    let valueStart = skipIgnored(source, mask, cursor + key.length);
    if (source[valueStart] !== ":") {
      cursor = memberEnd + 1;
      continue;
    }
    valueStart = skipIgnored(source, mask, valueStart + 1);
    members.set(key, source.slice(valueStart, memberEnd));
    cursor = memberEnd + 1;
  }
  return members;
}

function isFunctionExpression(source) {
  const mask = javascriptCodeMask(source);
  let visible = "";
  for (let index = 0; index < source.length; index += 1) {
    visible += mask[index] ? source[index] : " ";
  }
  const value = visible.trim();
  return (
    /^(?:async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\(/.test(value) ||
    /^(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(value)
  );
}

function hasTimelineRegistration(html, compositionName) {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(
    (match) => match[1],
  );
  const escapedName = escapeRegExp(compositionName);
  const registration = new RegExp(
    `window\\s*\\.\\s*__timelines\\s*\\[\\s*(["'])${escapedName}\\1\\s*\\]\\s*=\\s*\\{`,
    "g",
  );
  for (const script of scripts) {
    const mask = javascriptCodeMask(script);
    for (const match of script.matchAll(registration)) {
      if (!mask[match.index]) continue;
      const open = match.index + match[0].lastIndexOf("{");
      let depth = 0;
      let close = -1;
      for (let index = open; index < script.length; index += 1) {
        if (!mask[index]) continue;
        if (script[index] === "{") depth += 1;
        if (script[index] === "}") {
          depth -= 1;
          if (depth === 0) {
            close = index;
            break;
          }
        }
      }
      if (close < 0) continue;
      const objectSource = script.slice(open + 1, close);
      const members = topLevelObjectMembers(objectSource);
      if (["duration", "time", "seek"].every((name) => isFunctionExpression(members.get(name) || ""))) {
        return true;
      }
    }
  }
  return false;
}

function verifyCompositionCsp(html, errors) {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const head = withoutComments.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i);
  if (!head) {
    errors.push("index.html 缺少可验证的首个 head");
    return;
  }
  const charset = head[1].match(/^\s*<meta\s+charset=["']utf-8["']\s*\/?>/i);
  if (!charset) {
    errors.push("index.html 首个 head 必须以 UTF-8 charset meta 开始");
    return;
  }
  const afterCharset = head[1].slice(charset[0].length);
  const expectedCsp = `<meta http-equiv="Content-Security-Policy" content="${COMPOSITION_CSP}" />`;
  if (!new RegExp(`^\\s*${escapeRegExp(expectedCsp)}`).test(afterCharset)) {
    errors.push("index.html 的 charset 后必须紧邻精确的离线 CSP meta");
  }
}

function executableInlineScripts(html) {
  const scripts = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = match[1];
    const type = attributes.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (type && !["text/javascript", "application/javascript", "module"].includes(type)) continue;
    scripts.push(match[2]);
  }
  return scripts;
}

function visibleJavascript(source) {
  const mask = javascriptCodeMask(source);
  let visible = "";
  for (let index = 0; index < source.length; index += 1) visible += mask[index] ? source[index] : " ";
  return visible;
}

function verifyNoNetworkOrDynamicApis(html, errors) {
  const checks = [
    ["fetch", /\bfetch\s*\(/],
    ["XMLHttpRequest", /\bXMLHttpRequest\b/],
    ["WebSocket", /\bWebSocket\b/],
    ["EventSource", /\bEventSource\b/],
    ["sendBeacon", /\bsendBeacon\s*\(/],
    ["RTCPeerConnection", /\bRTCPeerConnection\b/],
    ["serviceWorker", /\bserviceWorker\b/],
    ["Worker/SharedWorker", /\b(?:Worker|SharedWorker)\s*\(/],
    ["importScripts", /\bimportScripts\s*\(/],
    ["dynamic import", /\bimport\s*\(/],
    ["eval", /\beval\s*\(/],
    ["Function constructor", /\b(?:new\s+)?Function\s*\(/],
    ["window.open", /\bwindow\s*\.\s*open\s*\(/],
    [
      "location navigation",
      /\b(?:(?:window|document)\s*\.\s*)?location(?:\s*\.\s*(?:href|assign|replace|reload))?\s*(?:=|\()/,
    ],
  ];
  const dangerousProperty = /["'](?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|RTCPeerConnection|serviceWorker|Worker|SharedWorker|importScripts|eval|Function|open|location)["']/;
  for (const script of executableInlineScripts(html)) {
    const visible = visibleJavascript(script);
    for (const [label, pattern] of checks) {
      if (pattern.test(visible)) errors.push(`index.html 执行脚本含禁用 API：${label}`);
    }
    if (dangerousProperty.test(script)) {
      errors.push("index.html 执行脚本含字符串形式的网络、动态执行或导航 API");
    }
  }
}

function validateCreativePlan(creative, brief, html, errors, creativeEngineVersion = null) {
  if (!creative || typeof creative !== "object" || Array.isArray(creative)) {
    errors.push("creative-plan.json 根节点必须是对象");
    return;
  }
  if (creative.version !== 1) errors.push("creative-plan.json.version 必须严格为 1");
  if (creative.source !== "create-animation-cn-creative") {
    errors.push('creative-plan.json.source 必须严格为 "create-animation-cn-creative"');
  }
  if (creative.function !== brief.function) {
    errors.push("creative-plan.json.function 必须与 delivery-brief.json.function 一致");
  }
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(String(creative.route || ""))) {
    errors.push("creative-plan.json.route 必须是3—64位英文小写、数字或短横线");
  }
  const content = creative.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    errors.push("creative-plan.json.content 必须是对象");
  } else {
    for (const [field, expected] of [
      ["source_title", brief.message?.title || ""],
      ["source_subtitle", brief.message?.subtitle || ""],
      ["source_signature", brief.message?.signature || ""],
    ]) {
      if (content[field] !== expected) {
        errors.push(`creative-plan.json.content.${field} 必须逐字对应 delivery brief`);
      }
    }
    if (
      ["sticker", "card"].includes(brief.function) &&
      Array.isArray(brief.media) &&
      brief.media.length === 0 &&
      creative.creative_director?.decision?.copy_policy === "source-only"
    ) {
      const source = String(brief.message?.title || "").replace(/[，,、：:；;。！？!?\s]+/g, "");
      const authored = `${content.eyebrow || ""}${content.hero || ""}`.replace(
        /[，,、：:；;。！？!?\s]+/g,
        "",
      );
      if (!source || authored !== source) {
        errors.push("纯文字作品的 eyebrow + hero 必须只重排原始标题，不得增删文本");
      }
    }
  }
  const palette = creative.palette;
  if (!palette || typeof palette !== "object" || Array.isArray(palette)) {
    errors.push("creative-plan.json.palette 必须是对象");
  } else {
    for (const key of ["background", "foreground", "accent", "secondary", "muted"]) {
      if (!/^#[0-9a-f]{6}$/i.test(String(palette[key] || ""))) {
        errors.push(`creative-plan.json.palette.${key} 必须是六位十六进制颜色`);
      }
    }
  }
  const textOnly =
    Array.isArray(brief.media) &&
    brief.media.length === 0 &&
    (brief.function === "sticker" || brief.function === "card");
  if (!Array.isArray(creative.layers) || creative.layers.length < (textOnly ? 3 : 2)) {
    errors.push(`creative-plan.json.layers 至少需要 ${textOnly ? 3 : 2} 个有职责的空间层`);
  }
  if (!Array.isArray(creative.focal_points) || creative.focal_points.length < (textOnly ? 2 : 1)) {
    errors.push(`creative-plan.json.focal_points 至少需要 ${textOnly ? 2 : 1} 个视觉焦点`);
  }
  if (!Array.isArray(creative.motion_beats) || creative.motion_beats.length < 3) {
    errors.push("creative-plan.json.motion_beats 必须覆盖 build、breathe、resolve 三个阶段");
  } else {
    const phases = new Set(creative.motion_beats.map((item) => item?.phase));
    for (const phase of ["build", "breathe", "resolve"]) {
      if (!phases.has(phase)) errors.push(`creative-plan.json.motion_beats 缺少 ${phase}`);
    }
  }
  if (!Array.isArray(creative.guardrails) || creative.guardrails.length < 3) {
    errors.push("creative-plan.json.guardrails 至少需要3项事实、媒介或离线边界");
  }
  if (creativeEngineVersion === 2) {
    const director = creative.creative_director;
    const decision = director?.decision;
    if (director?.engine !== "cn-context-router-v2" || director?.auto_applied !== true) {
      errors.push("Creative v2 工程必须记录 cn-context-router-v2 已自动应用");
    }
    if (!Array.isArray(director?.signals) || director.signals.length < 3) {
      errors.push("Creative v2 必须记录至少3个路由信号");
    }
    for (const key of ["audience", "tone", "composition_mode", "visual_metaphor"]) {
      if (typeof decision?.[key] !== "string" || !decision[key].trim()) {
        errors.push(`Creative v2 decision.${key} 必须是非空文字`);
      }
    }
    if (decision?.copy_policy !== "source-only") {
      errors.push('Creative v2 decision.copy_policy 必须为 "source-only"');
    }
    if (
      !Number.isInteger(decision?.decorative_budget) ||
      decision.decorative_budget < 0 ||
      decision.decorative_budget > 12
    ) {
      errors.push("Creative v2 decision.decorative_budget 必须是0—12的整数");
    }
    if (!Array.isArray(creative.motion_roles) || creative.motion_roles.length < 3) {
      errors.push("Creative v2 至少需要3个有职责的 motion_roles");
    }
    const actualEngine = htmlAttributeValue(html, "data-creative-engine");
    if (actualEngine !== "cn-context-router-v2") {
      errors.push("index.html 缺少或错配 data-creative-engine=cn-context-router-v2");
    }
  }
  const actualRoute = htmlAttributeValue(html, "data-creative-route");
  if (actualRoute == null) errors.push("index.html 缺少 data-creative-route");
  else if (actualRoute !== creative.route) {
    errors.push("index.html 的 data-creative-route 与 creative-plan.json.route 不一致");
  }
}

export async function verifyProject(projectDir) {
  const errors = [];
  let root;
  if (!projectDir) return { ok: false, errors: ["必须提供工程目录"] };
  try {
    root = path.resolve(projectDir);
    const linkInfo = await lstat(root);
    if (linkInfo.isSymbolicLink()) return { ok: false, errors: ["工程根目录不得是符号链接"] };
    const info = await stat(root);
    if (!info.isDirectory()) return { ok: false, errors: ["工程路径不是目录"] };
  } catch {
    return { ok: false, errors: [`工程目录不存在：${projectDir}`] };
  }

  let projectFiles = [];
  try {
    projectFiles = await listProjectFiles(root);
    for (const item of projectFiles) {
      if (item.symlink) errors.push(`工程不允许符号链接：${item.path}`);
    }
    for (const name of FORBIDDEN_ENTRIES) {
      if (projectFiles.some((item) => item.path.split("/").includes(name))) {
        errors.push(`工程不得包含 ${name}`);
      }
    }
  } catch (error) {
    errors.push(`无法遍历工程目录：${error.message}`);
  }

  for (const name of REQUIRED_FILES) {
    try {
      const info = await stat(path.join(root, name));
      if (!info.isFile()) errors.push(`必需项不是普通文件：${name}`);
    } catch {
      errors.push(`工程缺少必需文件：${name}`);
    }
  }
  if (errors.length) return { ok: false, errors };

  const hasCreativePlan = projectFiles.some(
    (item) => item.path === "creative-plan.json" && item.file && !item.symlink,
  );
  const [brief, hyperframes, plan, manifest, creative, html] = await Promise.all([
    parseJson(path.join(root, "delivery-brief.json"), "delivery-brief.json", errors),
    parseJson(path.join(root, "hyperframes.json"), "hyperframes.json", errors),
    parseJson(path.join(root, "animation-plan.json"), "animation-plan.json", errors),
    parseJson(path.join(root, "asset-manifest.json"), "asset-manifest.json", errors),
    hasCreativePlan
      ? parseJson(path.join(root, "creative-plan.json"), "creative-plan.json", errors)
      : Promise.resolve(null),
    readTextFile(path.join(root, "index.html"), MAX_HTML_BYTES, "index.html", errors),
  ]);
  if (!brief || !hyperframes || !plan || !manifest || html == null) return { ok: false, errors };
  if (typeof brief !== "object" || Array.isArray(brief)) errors.push("delivery-brief.json 根节点必须是对象");
  if (typeof hyperframes !== "object" || Array.isArray(hyperframes)) errors.push("hyperframes.json 根节点必须是对象");
  if (typeof plan !== "object" || Array.isArray(plan)) errors.push("animation-plan.json 根节点必须是对象");
  errors.push(...validateDeliveryBriefContract(brief, { label: "delivery-brief.json" }));

  for (const [label, object] of [
    ["delivery-brief.json", brief],
    ["hyperframes.json", hyperframes],
    ["animation-plan.json", plan],
    ["asset-manifest.json", manifest],
    ...(creative ? [["creative-plan.json", creative]] : []),
  ]) {
    try {
      walkStrings(object, (value, location) => {
        if (REMOTE_URL.test(value)) errors.push(`${label} ${location} 含远程 URL`);
        if (containsAbsolutePath(value)) {
          errors.push(`${label} ${location} 含绝对源路径`);
        }
      });
    } catch (error) {
      errors.push(`${label} 无法在资源上限内完成字符串审计：${error.message}`);
    }
  }
  if (REMOTE_URL.test(html)) errors.push("index.html 含远程 URL，工程不是离线闭环");
  if (containsAbsolutePath(html) || /\b(?:src|href)=["']\/(?!\/)/i.test(html)) {
    errors.push("index.html 含绝对路径");
  }
  verifyCompositionCsp(html, errors);
  verifyNoNetworkOrDynamicApis(html, errors);

  if (brief.schema_kind !== "delivery" || brief.schema_version !== 2) {
    errors.push('delivery-brief.json 必须声明 schema_kind: "delivery" 和 schema_version: 2');
  }
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(String(brief.project_name ?? ""))) {
    errors.push("delivery-brief.json.project_name 必须是1—48位英文小写、数字或短横线");
  }
  if ("approved_media_roots" in brief || "privacy_actions" in brief) {
    errors.push("delivery-brief.json 含仅限 source brief 或已废弃的字段");
  }
  const privacy = brief.privacy_review;
  if (!privacy || typeof privacy !== "object" || Array.isArray(privacy)) {
    errors.push("delivery-brief.json.privacy_review 必须是对象");
  } else {
    if (!PRIVACY_STATUSES.has(privacy.status)) errors.push("delivery-brief.json.privacy_review.status 无效");
    if (!Array.isArray(privacy.actions) || privacy.actions.some((item) => typeof item !== "string" || !item.trim())) {
      errors.push("delivery-brief.json.privacy_review.actions 必须是非空文字组成的数组（可为空数组）");
    }
    if (privacy.image_metadata !== "sensitive-stripped-orientation-preserved") {
      errors.push(
        'delivery-brief.json.privacy_review.image_metadata 必须是 "sensitive-stripped-orientation-preserved"',
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
  if (!functionRule) {
    errors.push("delivery-brief.json.function 必须是 sticker、card 或 photo-story");
  }
  if (hyperframes.version !== 1) errors.push("hyperframes.json.version 必须严格为 1");
  if (plan.version !== 1) errors.push("animation-plan.json.version 必须严格为 1");
  if (hyperframes.name !== brief.project_name) {
    errors.push("hyperframes.json.name 必须与 delivery-brief.json.project_name 一致");
  }
  if (hyperframes.composition !== "index.html") errors.push("hyperframes.json.composition 必须是 index.html");
  if (hyperframes.renderer !== "hyperframes@0.7.83") {
    errors.push('hyperframes.json.renderer 必须严格为 "hyperframes@0.7.83"');
  }
  if (hyperframes.source_skill !== "create-animation") {
    errors.push('hyperframes.json.source_skill 必须严格为 "create-animation"');
  }
  if (hyperframes.creative_contract_version != null && hyperframes.creative_contract_version !== 1) {
    errors.push("hyperframes.json.creative_contract_version 只支持 1");
  }
  if (hyperframes.creative_contract_version === 1 && !creative) {
    errors.push("声明 creative_contract_version: 1 的工程必须包含 creative-plan.json");
  }
  if (
    hyperframes.creative_engine_version != null &&
    hyperframes.creative_engine_version !== 2
  ) {
    errors.push("hyperframes.json.creative_engine_version 只支持 2");
  }
  if (creative) {
    validateCreativePlan(creative, brief, html, errors, hyperframes.creative_engine_version);
  }
  if (hyperframes.fps !== 30 || plan.fps !== 30) {
    errors.push("hyperframes.json.fps 与 animation-plan.json.fps 必须严格为 30");
  }
  if (plan.function !== brief.function) {
    errors.push("animation-plan.json.function 必须与 delivery-brief.json.function 一致");
  }
  const duration = Number(brief.duration_seconds);
  if (
    typeof brief.duration_seconds !== "number" ||
    typeof hyperframes.duration !== "number" ||
    typeof plan.duration_seconds !== "number" ||
    !Number.isFinite(duration) ||
    !functionRule ||
    duration < functionRule.duration[0] ||
    duration > functionRule.duration[1]
  ) {
    errors.push(
      functionRule
        ? `${brief.function} 时长必须在 ${functionRule.duration[0]}—${functionRule.duration[1]} 秒`
        : "delivery-brief.json.duration_seconds 无效",
    );
  }
  const fixedDimensions = FIXED_DIMS[brief.aspect_ratio];
  if (!fixedDimensions) {
    errors.push("delivery-brief.json.aspect_ratio 必须是 1:1、9:16 或 16:9");
  } else if (
    hyperframes.width !== fixedDimensions[0] ||
    hyperframes.height !== fixedDimensions[1] ||
    plan.width !== fixedDimensions[0] ||
    plan.height !== fixedDimensions[1]
  ) {
    errors.push(
      `画布必须使用 ${brief.aspect_ratio} 的固定尺寸 ${fixedDimensions[0]}×${fixedDimensions[1]}`,
    );
  }
  if (Number(plan.width) !== Number(hyperframes.width) || Number(plan.height) !== Number(hyperframes.height)) {
    errors.push("animation-plan.json 的画布尺寸与 hyperframes.json 不一致");
  }
  if (Number(plan.fps) !== Number(hyperframes.fps)) errors.push("animation-plan.json.fps 与 hyperframes.json 不一致");
  if (Number(plan.duration_seconds) !== Number(hyperframes.duration)) {
    errors.push("animation-plan.json.duration_seconds 与 hyperframes.json.duration 不一致");
  }
  if (Number(brief.duration_seconds) !== Number(hyperframes.duration)) {
    errors.push("delivery-brief.json.duration_seconds 与 hyperframes.json.duration 不一致");
  }
  if (!Array.isArray(plan.scenes) || plan.scenes.length === 0) {
    errors.push("animation-plan.json.scenes 必须是非空数组");
  } else {
    if (plan.scenes.length > 12) errors.push("animation-plan.json.scenes 最多允许 12 项");
    if (brief.function === "photo-story" && Array.isArray(brief.media) && plan.scenes.length !== brief.media.length) {
      errors.push("photo-story 的 scenes 数量必须与 media 数量一致");
    }
    if ((brief.function === "sticker" || brief.function === "card") && plan.scenes.length !== 1) {
      errors.push(`${brief.function} 必须严格使用一个主 scene`);
    }
    const sceneIds = new Set();
    for (const [index, scene] of plan.scenes.slice(0, 12).entries()) {
      if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
        errors.push(`animation-plan.json.scenes[${index}] 必须是对象`);
        continue;
      }
      if (typeof scene.id !== "string" || !scene.id || sceneIds.has(scene.id)) {
        errors.push(`animation-plan.json.scenes[${index}].id 缺失或重复`);
      } else {
        sceneIds.add(scene.id);
      }
      const start = Number(scene.start);
      const sceneDuration = Number(scene.duration);
      if (
        typeof scene.start !== "number" ||
        typeof scene.duration !== "number" ||
        !Number.isFinite(start) ||
        start < 0 ||
        !Number.isFinite(sceneDuration) ||
        sceneDuration <= 0
      ) {
        errors.push(`animation-plan.json.scenes[${index}] 的 start/duration 无效`);
      } else if (start + sceneDuration > Number(hyperframes.duration) + 0.001) {
        errors.push(`animation-plan.json.scenes[${index}] 超出工程时长`);
      }
      if (
        brief.function === "photo-story" &&
        Array.isArray(brief.media) &&
        scene.asset !== brief.media[index]?.project_path
      ) {
        errors.push(`photo-story 的 scenes[${index}].asset 必须按 media 顺序逐一对应`);
      }
    }
  }
  if (
    brief.function === "photo-story" &&
    Array.isArray(brief.media) &&
    Number.isFinite(duration) &&
    duration < brief.media.length * 1.2
  ) {
    errors.push("photo-story 每张图片平均至少需要1.2秒");
  }

  for (const [marker, expected] of [
    ["data-composition-id", hyperframes.name],
    ["data-duration", hyperframes.duration],
    ["data-fps", hyperframes.fps],
    ["data-width", hyperframes.width],
    ["data-height", hyperframes.height],
  ]) {
    const actual = htmlAttributeValue(html, marker);
    if (actual == null) errors.push(`index.html 缺少 ${marker}`);
    else if (String(actual) !== String(expected)) errors.push(`index.html 的 ${marker} 与工程元数据不一致`);
  }
  if (!hasTimelineRegistration(html, hyperframes.name)) {
    errors.push("index.html 缺少与 composition 名称一致且含 duration/time/seek 的实际 timeline 注册");
  }

  let totalAuditedTextBytes = 0;
  for (const item of projectFiles) {
    if (item.symlink || item.directory || !TEXT_EXTENSIONS.has(path.extname(item.path).toLowerCase())) continue;
    try {
      const filePath = path.join(root, ...item.path.split("/"));
      if (item.size > MAX_TEXT_BYTES) {
        errors.push(`文本文件超过5MB，无法安全审计：${item.path}`);
        continue;
      }
      totalAuditedTextBytes += item.size;
      if (totalAuditedTextBytes > MAX_TOTAL_TEXT_BYTES) {
        errors.push("工程待审计文本总量超过20MB上限");
        break;
      }
      const content = await readBoundedFile(filePath, MAX_TEXT_BYTES, item.path, "utf8");
      if (REMOTE_URL.test(content)) errors.push(`文本文件含远程 URL：${item.path}`);
      if (containsAbsolutePath(content)) errors.push(`文本文件含绝对源路径：${item.path}`);
    } catch (error) {
      errors.push(`无法审计文本文件 ${item.path}：${error.message}`);
    }
  }

  if (!Array.isArray(manifest)) {
    errors.push("asset-manifest.json 必须是数组");
    return { ok: false, errors };
  }
  if (manifest.length > 12) errors.push("asset-manifest.json 最多允许 12 项");
  if (!Array.isArray(brief.media)) {
    errors.push("delivery-brief.json.media 必须是数组");
  } else {
    if (brief.media.length > 12) errors.push("delivery-brief.json.media 最多允许 12 项");
    if (
      functionRule &&
      (brief.media.length < functionRule.media[0] || brief.media.length > functionRule.media[1])
    ) {
      errors.push(`${brief.function} 需要 ${functionRule.media[0]}—${functionRule.media[1]} 个图片素材`);
    }
  }

  const assetTreeItems = projectFiles.filter((item) => item.path.startsWith("assets/"));
  const diskAssetFilesPreflight = assetTreeItems.filter((item) => item.file && !item.symlink);
  if (diskAssetFilesPreflight.length > 12) errors.push("assets/ 普通文件最多允许 12 项");
  const diskAssetBytes = diskAssetFilesPreflight.reduce((sum, item) => sum + item.size, 0);
  if (diskAssetBytes > MAX_TOTAL_ASSET_BYTES) errors.push("assets/ 普通文件总量超过300MiB上限");
  for (const item of assetTreeItems) {
    if (item.directory) errors.push(`assets/ 不允许嵌套目录：${item.path}`);
  }

  const manifestPaths = new Map();
  const manifestIds = new Set();
  let totalAssetBytes = 0;
  for (const [index, item] of manifest.slice(0, 12).entries()) {
    const label = `asset-manifest.json[${index}]`;
    if (!item || typeof item !== "object") {
      errors.push(`${label} 必须是对象`);
      continue;
    }
    if (typeof item.source_id !== "string" || !item.source_id) errors.push(`${label}.source_id 缺失`);
    if (item.metadata_sanitized !== true) errors.push(`${label}.metadata_sanitized 必须是 true`);
    if (!isSafeProjectPath(item.project_path) || !item.project_path.startsWith("assets/")) {
      errors.push(`${label}.project_path 必须是 assets/ 下的安全相对路径`);
      continue;
    }
    if (!/^[a-f0-9]{64}$/i.test(item.sha256 || "")) errors.push(`${label}.sha256 必须是 64 位 SHA-256`);
    if (manifestPaths.has(item.project_path)) {
      errors.push(`asset manifest 重复路径：${item.project_path}`);
      continue;
    }
    if (manifestIds.has(item.source_id)) {
      errors.push(`asset manifest 重复 source_id：${item.source_id}`);
      continue;
    }
    manifestPaths.set(item.project_path, item);
    manifestIds.add(item.source_id);
    const diskPath = path.join(root, ...item.project_path.split("/"));
    try {
      const info = await lstat(diskPath);
      if (!info.isFile()) {
        errors.push(`素材不是普通文件：${item.project_path}`);
      } else if (info.size > MAX_ASSET_BYTES) {
        errors.push(`素材超过单文件25MiB上限：${item.project_path}`);
      } else {
        totalAssetBytes += info.size;
        if (totalAssetBytes > MAX_TOTAL_ASSET_BYTES) {
          errors.push("素材总量超过300MiB上限");
          continue;
        }
        const buffer = await readBoundedFile(diskPath, MAX_ASSET_BYTES, item.project_path);
        const actual = createHash("sha256").update(buffer).digest("hex");
        if (actual.toLowerCase() !== String(item.sha256).toLowerCase()) {
          errors.push(`素材 SHA-256 不一致：${item.project_path}`);
        }
        const extension = path.extname(item.project_path).toLowerCase();
        if (![".png", ".jpg", ".jpeg"].includes(extension)) {
          errors.push(`素材格式不在安全清单中：${item.project_path}`);
        } else {
          try {
            const inspection = inspectImageBuffer(buffer);
            if (!inspection?.valid) {
              throw new Error(inspection?.validationErrors?.join("、") || "图片结构或像素流无效");
            }
            const pixels = Number(inspection.width) * Number(inspection.height);
            if (
              !Number.isInteger(inspection.width) ||
              !Number.isInteger(inspection.height) ||
              inspection.width < 64 ||
              inspection.height < 64 ||
              !Number.isSafeInteger(pixels) ||
              pixels > MAX_IMAGE_PIXELS
            ) {
              throw new Error("图片尺寸无效或像素数超过4000万上限");
            }
            if (extension === ".jpg" || extension === ".jpeg") {
              const decoded = decodeJpegBuffer(buffer);
              if (!decoded.ok) throw new Error(decoded.error);
            }
            const sanitized = sanitizeImage(buffer, extension);
            if (!buffer.equals(sanitized)) {
              errors.push(`素材仍含未清洗的图片元数据：${item.project_path}`);
            }
          } catch (error) {
            errors.push(`素材图片安全检查失败 ${item.project_path}：${error.message}`);
          }
        }
      }
    } catch {
      errors.push(`素材不存在：${item.project_path}`);
    }
  }

  if (Array.isArray(brief.media)) {
    const briefPaths = new Set();
    const briefIds = new Set();
    for (const [index, item] of brief.media.slice(0, 12).entries()) {
      const label = `delivery-brief.json.media[${index}]`;
      if (!item || !isSafeProjectPath(item.project_path) || !item.project_path.startsWith("assets/")) {
        errors.push(`${label}.project_path 必须是 assets/ 下的安全相对路径`);
        continue;
      }
      if (briefPaths.has(item.project_path)) errors.push(`${label}.project_path 重复`);
      if (typeof item.source_id !== "string" || !item.source_id || briefIds.has(item.source_id)) {
        errors.push(`${label}.source_id 缺失或重复`);
      }
      briefPaths.add(item.project_path);
      briefIds.add(item.source_id);
      const manifestItem = manifestPaths.get(item.project_path);
      if (!manifestItem) errors.push(`${label} 未出现在 asset-manifest.json`);
      else if (item.source_id !== manifestItem.source_id) errors.push(`${label}.source_id 与 asset manifest 不一致`);
    }
    for (const manifestPath of manifestPaths.keys()) {
      if (!briefPaths.has(manifestPath)) errors.push(`asset manifest 中存在 delivery brief 未声明的素材：${manifestPath}`);
    }
  }

  const planAssets = Array.isArray(plan.scenes)
    ? plan.scenes.slice(0, 12).map((scene) => scene.asset).filter(Boolean)
    : [];
  for (const asset of planAssets) {
    if (!manifestPaths.has(asset)) errors.push(`animation plan 引用了未登记素材：${asset}`);
  }

  const assetsDirectory = projectFiles.find((item) => item.path === "assets" && item.directory && !item.symlink);
  if (!assetsDirectory) {
    errors.push("工程缺少可读取的 assets/ 目录");
  } else {
    const diskAssets = projectFiles
      .filter((item) => item.path.startsWith("assets/") && !item.directory)
      .map((item) => ({ ...item, projectPath: item.path }));
    for (const item of diskAssets) {
      if (item.symlink) errors.push(`assets/ 不允许符号链接：${item.projectPath}`);
      else if (!item.file) errors.push(`assets/ 含非普通文件：${item.projectPath}`);
      else if (!manifestPaths.has(item.projectPath)) errors.push(`assets/ 存在未登记素材：${item.projectPath}`);
    }
    for (const manifestPath of manifestPaths.keys()) {
      if (!diskAssets.some((item) => item.projectPath === manifestPath && item.file && !item.symlink)) {
        errors.push(`asset manifest 素材未在 assets/ 中形成普通文件闭环：${manifestPath}`);
      }
    }
  }

  const referencedAssets = new Set();
  for (const match of html.matchAll(/\b(?:src|href)=["']([^"'#]+)["']/gi)) referencedAssets.add(match[1]);
  for (const match of html.matchAll(/\burl\(\s*["']?([^"')]+)["']?\s*\)/gi)) referencedAssets.add(match[1]);
  for (const reference of referencedAssets) {
    if (REMOTE_URL.test(reference) || !isSafeProjectPath(reference)) {
      errors.push(`index.html 含不安全的资源引用：${reference}`);
    } else if (!manifestPaths.has(reference)) {
      errors.push(`index.html 引用了 asset manifest 未登记的资源：${reference}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export async function runCli(argv = process.argv.slice(2)) {
  const [projectDir] = argv;
  if (!projectDir) {
    console.error("用法：node scripts/verify_project.mjs <工程目录>");
    return 2;
  }
  const result = await verifyProject(projectDir);
  result.errors.forEach((item) => console.error(`错误：${item}`));
  if (!result.ok) {
    console.error(`结果：不通过，共 ${result.errors.length} 个错误`);
    return 1;
  }
  console.log(`结果：通过（工程目录 ${path.resolve(projectDir)}）`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await runCli();

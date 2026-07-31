#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectContractDigest } from "./runtime_guard.mjs";

const MAX_EVIDENCE_FILES = 256;
const MAX_EVIDENCE_FILE_BYTES = 25 * 1024 * 1024;
const MAX_EVIDENCE_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_SCAN_DEPTH = 4;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readStableFile(filePath, maxBytes = MAX_JSON_BYTES) {
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > maxBytes) {
      throw new Error(`文件不是允许大小的普通文件：${filePath}`);
    }
    const buffer = Buffer.alloc(before.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (
      bytesRead !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error(`文件在读取期间发生变化：${filePath}`);
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function captureDirectory(directory, label) {
  const resolvedInput = path.resolve(directory);
  const inputInfo = await lstat(resolvedInput);
  if (inputInfo.isSymbolicLink()) throw new Error(`${label}不得是符号链接`);
  const resolved = await realpath(resolvedInput);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label}必须是非符号链接的真实目录`);
  }
  return { path: resolved, dev: info.dev, ino: info.ino };
}

async function assertDirectory(directory, expected, label) {
  const current = await captureDirectory(directory, label);
  if (current.dev !== expected.dev || current.ino !== expected.ino || current.path !== expected.path) {
    throw new Error(`${label}在处理期间被替换`);
  }
}

async function resolveRun(projectDir, runArgument) {
  const project = await captureDirectory(projectDir, "工程根目录");
  const snapshotsPath = path.join(project.path, "snapshots");
  const snapshots = await captureDirectory(snapshotsPath, "snapshots/");
  const run = await captureDirectory(runArgument, "已验证快照目录");
  const relative = path.relative(snapshots.path, run.path);
  if (
    !/^verified-\d+$/.test(relative) ||
    relative.includes(path.sep) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("待审批目录必须是当前工程 snapshots/ 下的 verified-<时间戳>/");
  }
  return { project, snapshots, run };
}

async function collectEvidenceFiles(root) {
  const files = [];
  const visit = async (directory, depth) => {
    if (depth > MAX_SCAN_DEPTH) throw new Error("快照证据目录层级过深");
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (relative === "run-manifest.json" || relative === "approval.json") continue;
      if (entry.isSymbolicLink()) throw new Error(`快照证据不允许符号链接：${relative}`);
      if (entry.isDirectory()) {
        await visit(absolute, depth + 1);
      } else if (entry.isFile()) {
        files.push({ absolute, relative });
        if (files.length > MAX_EVIDENCE_FILES) throw new Error("快照证据文件超过256项");
      } else {
        throw new Error(`快照证据不允许特殊文件：${relative}`);
      }
    }
  };
  await visit(root, 0);
  return files.sort((left, right) => left.relative.localeCompare(right.relative));
}

export async function snapshotEvidenceDigest(runDir) {
  const run = await captureDirectory(runDir, "快照证据目录");
  const files = await collectEvidenceFiles(run.path);
  if (!files.some((item) => item.relative.endsWith(".png"))) {
    throw new Error("快照证据中没有 PNG，不能批准预览");
  }
  const hash = createHash("sha256");
  let totalBytes = 0;
  for (const item of files) {
    const buffer = await readStableFile(item.absolute, MAX_EVIDENCE_FILE_BYTES);
    totalBytes += buffer.length;
    if (totalBytes > MAX_EVIDENCE_TOTAL_BYTES) throw new Error("快照证据总量超过100MB");
    hash.update(`${item.relative}\0${buffer.length}\0`);
    hash.update(buffer);
  }
  await assertDirectory(run.path, run, "快照证据目录");
  return hash.digest("hex");
}

function requireExactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}必须是对象`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label}含未知字段：${unknown.join("、")}`);
}

async function loadRunManifest(runPath) {
  const manifestPath = path.join(runPath, "run-manifest.json");
  const buffer = await readStableFile(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error("run-manifest.json 不是有效 JSON");
  }
  requireExactKeys(
    manifest,
    new Set([
      "schema_kind",
      "schema_version",
      "source_project",
      "purpose",
      "contract_sha256",
      "evidence_sha256",
      "transition_times_seconds",
      "checked_at",
    ]),
    "run-manifest.json",
  );
  if (manifest.schema_kind !== "preview-check" || manifest.schema_version !== 1) {
    throw new Error("run-manifest.json schema 不受支持");
  }
  if (manifest.purpose !== "verified-preview-review") {
    throw new Error("run-manifest.json purpose 不正确");
  }
  for (const field of ["contract_sha256", "evidence_sha256"]) {
    if (!/^[a-f0-9]{64}$/.test(manifest[field] || "")) {
      throw new Error(`run-manifest.json ${field} 无效`);
    }
  }
  if (
    !Array.isArray(manifest.transition_times_seconds) ||
    manifest.transition_times_seconds.length > 36 ||
    manifest.transition_times_seconds.some(
      (item) => !Number.isFinite(item) || item <= 0 || item > 30,
    )
  ) {
    throw new Error("run-manifest.json 转场时间无效");
  }
  if (
    typeof manifest.checked_at !== "string" ||
    !Number.isFinite(Date.parse(manifest.checked_at))
  ) {
    throw new Error("run-manifest.json checked_at 无效");
  }
  return { manifest, buffer };
}

async function validateRun(projectDir, runArgument) {
  const resolved = await resolveRun(projectDir, runArgument);
  const { manifest, buffer: manifestBuffer } = await loadRunManifest(resolved.run.path);
  if (manifest.source_project !== path.basename(resolved.project.path)) {
    throw new Error("run-manifest.json 与工程名不一致");
  }
  const [contractSha256, evidenceSha256] = await Promise.all([
    projectContractDigest(resolved.project.path),
    snapshotEvidenceDigest(resolved.run.path),
  ]);
  if (manifest.contract_sha256 !== contractSha256) {
    throw new Error("预览检查对应的工程已发生变化，请重新运行 check_project");
  }
  if (manifest.evidence_sha256 !== evidenceSha256) {
    throw new Error("预览快照在检查后发生变化，请重新运行 check_project");
  }
  await Promise.all([
    assertDirectory(resolved.project.path, resolved.project, "工程根目录"),
    assertDirectory(resolved.snapshots.path, resolved.snapshots, "snapshots/"),
    assertDirectory(resolved.run.path, resolved.run, "已验证快照目录"),
  ]);
  return {
    ...resolved,
    manifest,
    manifestSha256: sha256(manifestBuffer),
    contractSha256,
    evidenceSha256,
  };
}

async function writeExclusiveJson(filePath, value) {
  const handle = await open(
    filePath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function approvePreview(projectDir, runArgument) {
  const checked = await validateRun(projectDir, runArgument);
  const approvalPath = path.join(checked.run.path, "approval.json");
  const approval = {
    schema_kind: "preview-approval",
    schema_version: 1,
    decision: "approved-after-human-review",
    project_name: path.basename(checked.project.path),
    verified_run: path.basename(checked.run.path),
    contract_sha256: checked.contractSha256,
    evidence_sha256: checked.evidenceSha256,
    manifest_sha256: checked.manifestSha256,
    approved_at: new Date().toISOString(),
    approval_id: randomBytes(16).toString("hex"),
  };
  await writeExclusiveJson(approvalPath, approval);
  await validateRun(checked.project.path, checked.run.path);
  return { approvalPath, approval };
}

async function validateApproval(projectDir, runPath) {
  const checked = await validateRun(projectDir, runPath);
  const approvalBuffer = await readStableFile(path.join(checked.run.path, "approval.json"));
  let approval;
  try {
    approval = JSON.parse(approvalBuffer.toString("utf8"));
  } catch {
    throw new Error("approval.json 不是有效 JSON");
  }
  requireExactKeys(
    approval,
    new Set([
      "schema_kind",
      "schema_version",
      "decision",
      "project_name",
      "verified_run",
      "contract_sha256",
      "evidence_sha256",
      "manifest_sha256",
      "approved_at",
      "approval_id",
    ]),
    "approval.json",
  );
  if (
    approval.schema_kind !== "preview-approval" ||
    approval.schema_version !== 1 ||
    approval.decision !== "approved-after-human-review"
  ) {
    throw new Error("approval.json 不是有效的人工预览批准");
  }
  if (
    approval.project_name !== path.basename(checked.project.path) ||
    approval.verified_run !== path.basename(checked.run.path) ||
    approval.contract_sha256 !== checked.contractSha256 ||
    approval.evidence_sha256 !== checked.evidenceSha256 ||
    approval.manifest_sha256 !== checked.manifestSha256
  ) {
    throw new Error("approval.json 与当前工程或快照证据不一致");
  }
  if (
    !/^[a-f0-9]{32}$/.test(approval.approval_id || "") ||
    typeof approval.approved_at !== "string" ||
    !Number.isFinite(Date.parse(approval.approved_at))
  ) {
    throw new Error("approval.json 的审批标识或时间无效");
  }
  return {
    runPath: checked.run.path,
    approvalId: approval.approval_id,
    contractSha256: checked.contractSha256,
  };
}

export async function requirePreviewApproval(projectDir) {
  const project = await captureDirectory(projectDir, "工程根目录");
  const snapshots = await captureDirectory(path.join(project.path, "snapshots"), "snapshots/");
  const candidates = [];
  const handle = await opendir(snapshots.path);
  for await (const entry of handle) {
    if (entry.isSymbolicLink()) throw new Error("snapshots/ 不允许符号链接");
    if (entry.isDirectory() && /^verified-\d+$/.test(entry.name)) {
      candidates.push(entry.name);
      if (candidates.length > 100) throw new Error("verified 快照目录超过100项，请归档旧记录");
    }
  }
  candidates.sort((left, right) => right.localeCompare(left));
  const failures = [];
  for (const name of candidates) {
    const runPath = path.join(snapshots.path, name);
    try {
      return await validateApproval(project.path, runPath);
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    }
  }
  const detail = failures.length ? `；最近记录：${failures.slice(0, 3).join("；")}` : "";
  throw new Error(
    `缺少与当前工程摘要一致的人工预览批准；先运行 check_project、查看快照，再运行 approve_preview${detail}`,
  );
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) {
    console.error(
      "用法：node scripts/approve_preview.mjs <工程目录> <snapshots/verified-时间戳目录>",
    );
    return 2;
  }
  try {
    const result = await approvePreview(path.resolve(argv[0]), path.resolve(argv[1]));
    console.log(`预览已人工批准：${result.approvalPath}`);
    console.log(`approval_id：${result.approval.approval_id}`);
    return 0;
  } catch (error) {
    console.error(`预览批准失败：${error.message}`);
    return 1;
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  process.exitCode = await main();
}

import { createHash } from "node:crypto";
import { constants, readdirSync } from "node:fs";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const BROWSER_GUARD_PATH = path.join(scriptDir, "chrome-headless-shell");
const RUNTIME_CLEANUP = Symbol("create-animation-runtime-cleanup");
const CONTRACT_FILES = [
  "BRIEF.md",
  "delivery-brief.json",
  "index.html",
  "hyperframes.json",
  "animation-plan.json",
  "asset-manifest.json",
];
const MAX_DIGEST_FILE_BYTES = 25 * 1024 * 1024;
const MAX_DIGEST_TOTAL_BYTES = 320 * 1024 * 1024;

export const NO_TRACKING_ENV = {
  ...process.env,
  HYPERFRAMES_NO_TELEMETRY: "1",
  HYPERFRAMES_NO_UPDATE_CHECK: "1",
  HYPERFRAMES_NO_AUTO_INSTALL: "1",
  DO_NOT_TRACK: "1",
  npm_config_update_notifier: "false",
  npm_config_audit: "false",
  npm_config_fund: "false",
};

function executableCandidates() {
  const candidates = [
    process.env.HYPERFRAMES_REAL_BROWSER_PATH,
    process.env.HYPERFRAMES_BROWSER_PATH,
    process.env.PRODUCER_HEADLESS_SHELL_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const cacheRoot = path.join(os.homedir(), ".cache", "hyperframes", "chrome");
  candidates.push(...findCachedBrowsers(cacheRoot));
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
      if (directory) candidates.push(path.join(directory, name));
    }
  }
  return candidates.filter(Boolean);
}

function findCachedBrowsers(root, depth = 0) {
  if (depth > 6) return [];
  let entries;
  try {
    entries = requireDirectoryEntries(root);
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (
      entry.isFile() &&
      ["chrome-headless-shell", "Google Chrome for Testing", "chrome"].includes(entry.name)
    ) {
      found.push(target);
    } else if (entry.isDirectory()) {
      found.push(...findCachedBrowsers(target, depth + 1));
    }
  }
  return found;
}

function requireDirectoryEntries(root) {
  // The synchronous directory walk happens only while resolving a preinstalled
  // browser and is capped to a small known cache depth.
  return readdirSync(root, { withFileTypes: true });
}

export async function resolveRealBrowserPath() {
  const guardRealPath = await realpath(BROWSER_GUARD_PATH).catch(() => BROWSER_GUARD_PATH);
  for (const candidate of executableCandidates()) {
    try {
      const candidateRealPath = await realpath(candidate);
      if (candidateRealPath === guardRealPath) continue;
      const info = await lstat(candidateRealPath);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      await access(candidateRealPath, constants.X_OK);
      return candidateRealPath;
    } catch {
      // Try the next explicitly installed browser.
    }
  }
  throw new Error(
    "未找到预装且可执行的 Chrome/Chromium；禁止让 HyperFrames 在运行时自动下载浏览器",
  );
}

async function materializeBrowserGuard() {
  const sourceHandle = await open(
    BROWSER_GUARD_PATH,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  let source;
  try {
    const before = await sourceHandle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > 64 * 1024) {
      throw new Error("浏览器离线守卫必须是64KB以内的非空普通文件");
    }
    source = Buffer.alloc(before.size + 1);
    const read = await sourceHandle.read(source, 0, source.length, 0);
    const after = await sourceHandle.stat();
    if (
      read.bytesRead !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("浏览器离线守卫在读取期间发生变化");
    }
    source = source.subarray(0, read.bytesRead);
  } finally {
    await sourceHandle.close();
  }

  const workspace = await mkdtemp(path.join(os.tmpdir(), "create-animation-browser-guard-"));
  const guardPath = path.join(workspace, "chrome-headless-shell");
  let outputHandle = null;
  try {
    outputHandle = await open(
      guardPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW || 0),
      0o700,
    );
    await outputHandle.writeFile(source);
    await outputHandle.sync();
    await outputHandle.close();
    outputHandle = null;
    // GitHub web-created files are commonly cloned as 0644. The installed
    // Skill can remain read-only; only this private disposable copy executes.
    await chmod(guardPath, 0o700);
    return {
      guardPath,
      async cleanup() {
        await rm(workspace, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await outputHandle?.close().catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function guardedRuntimeEnv() {
  const realBrowser = await resolveRealBrowserPath();
  const materialized = await materializeBrowserGuard();
  const env = {
    ...NO_TRACKING_ENV,
    HYPERFRAMES_REAL_BROWSER_PATH: realBrowser,
    HYPERFRAMES_BROWSER_PATH: materialized.guardPath,
    PRODUCER_HEADLESS_SHELL_PATH: materialized.guardPath,
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "localhost,127.0.0.1,::1",
  };
  Object.defineProperty(env, RUNTIME_CLEANUP, {
    enumerable: false,
    value: materialized.cleanup,
  });
  return env;
}

export async function cleanupGuardedRuntimeEnv(env) {
  const cleanup = env?.[RUNTIME_CLEANUP];
  if (typeof cleanup === "function") await cleanup();
}

async function boundedDigestFile(root, relativePath, hash, budget) {
  const filePath = path.join(root, ...relativePath.split("/"));
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`工程契约项不是普通文件：${relativePath}`);
    if (info.size > MAX_DIGEST_FILE_BYTES) {
      throw new Error(`工程契约项超过25MB：${relativePath}`);
    }
    budget.bytes += info.size;
    if (budget.bytes > MAX_DIGEST_TOTAL_BYTES) throw new Error("工程契约数据超过320MB");
    const buffer = Buffer.alloc(info.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (
      bytesRead !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    ) {
      throw new Error(`工程契约项在读取期间发生变化：${relativePath}`);
    }
    hash.update(`${relativePath}\0${bytesRead}\0`);
    hash.update(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function listAssetPaths(root) {
  const assetsDir = path.join(root, "assets");
  const paths = [];
  const directory = await opendir(assetsDir);
  for await (const entry of directory) {
    if (paths.length >= 12) throw new Error("assets/ 超过12项");
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`assets/ 仅允许普通文件：${entry.name}`);
    }
    paths.push(`assets/${entry.name}`);
  }
  return paths.sort();
}

export async function projectContractDigest(root) {
  const hash = createHash("sha256");
  const budget = { bytes: 0 };
  for (const relativePath of [...CONTRACT_FILES, ...(await listAssetPaths(root))]) {
    await boundedDigestFile(root, relativePath, hash, budget);
  }
  return hash.digest("hex");
}

async function captureRootIdentity(root) {
  const info = await lstat(root);
  const resolved = await realpath(root);
  if (!info.isDirectory() || info.isSymbolicLink() || resolved !== root) {
    throw new Error("工程根目录必须是非符号链接的真实目录");
  }
  return { dev: info.dev, ino: info.ino, resolved };
}

async function assertRootIdentity(root, expected) {
  const current = await captureRootIdentity(root);
  if (current.dev !== expected.dev || current.ino !== expected.ino || current.resolved !== expected.resolved) {
    throw new Error("工程根目录在运行期间被替换");
  }
}

export async function freezeProject(projectDir, verifyProject) {
  const sourceRoot = path.resolve(projectDir);
  const sourceIdentity = await captureRootIdentity(sourceRoot);
  const sourceDigest = await projectContractDigest(sourceRoot);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "create-animation-run-"));
  const frozenRoot = path.join(workspace, "project");
  try {
    await cp(sourceRoot, frozenRoot, {
      recursive: true,
      dereference: false,
      preserveTimestamps: false,
      errorOnExist: true,
      filter: (source) => {
        const relative = path.relative(sourceRoot, source);
        if (!relative) return true;
        const first = relative.split(path.sep)[0];
        return first !== "renders" && first !== "snapshots";
      },
    });
    await Promise.all([
      mkdir(path.join(frozenRoot, "renders"), { recursive: false, mode: 0o700 }),
      mkdir(path.join(frozenRoot, "snapshots"), { recursive: false, mode: 0o700 }),
    ]);
    await assertRootIdentity(sourceRoot, sourceIdentity);
    const currentSourceDigest = await projectContractDigest(sourceRoot);
    if (currentSourceDigest !== sourceDigest) throw new Error("工程内容在冻结期间发生变化");
    const frozenCheck = await verifyProject(frozenRoot);
    if (!frozenCheck.ok) {
      throw new Error(`冻结工程未通过复验：${frozenCheck.errors.join("；")}`);
    }
    const frozenDigest = await projectContractDigest(frozenRoot);
    if (frozenDigest !== sourceDigest) throw new Error("冻结副本与已验证工程不一致");
    return {
      workspace,
      sourceRoot,
      frozenRoot,
      async assertSourceUnchanged() {
        await assertRootIdentity(sourceRoot, sourceIdentity);
        const digest = await projectContractDigest(sourceRoot);
        if (digest !== sourceDigest) throw new Error("源工程在运行期间发生变化，拒绝回写产物");
      },
      async cleanup() {
        await rm(workspace, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

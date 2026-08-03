#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BRIEF_BYTES = 256 * 1024;
const PROCESS_TIMEOUT_MS = 30 * 60 * 1000;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

async function readBoundedStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BRIEF_BYTES) {
      process.stdin.destroy();
      throw new Error("stdin direct sticker brief 超过256KB");
    }
    chunks.push(buffer);
  }
  if (total === 0) throw new Error("stdin 中没有 direct sticker brief JSON");
  const parsed = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("stdin direct sticker brief 根节点必须是对象");
  }
  return Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

async function writePrivateBrief(directory, buffer) {
  const briefPath = path.join(directory, "direct-sticker-brief.json");
  const handle = await open(
    briefPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    await handle.writeFile(buffer);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return briefPath;
}

function runScript(scriptName, args) {
  return spawnSync(process.execPath, [path.join(scriptDirectory, scriptName), ...args], {
    stdio: "inherit",
    env: process.env,
    timeout: PROCESS_TIMEOUT_MS,
  });
}

async function main(argv = process.argv.slice(2)) {
  const [action, outputParent] = argv;
  if (!new Set(["validate", "selection", "render"]).has(action) || (action !== "validate" && !outputParent)) {
    console.error(
      "用法：通过 stdin 提供 brief；node scripts/direct_sticker_from_stdin.mjs <validate|selection|render> [输出父目录]",
    );
    return 2;
  }
  let privateDirectory = null;
  let resultCode = 1;
  try {
    const briefBuffer = await readBoundedStdin();
    privateDirectory = await mkdtemp(path.join(os.tmpdir(), "create-animation-direct-brief-"));
    await chmod(privateDirectory, 0o700);
    const briefPath = await writePrivateBrief(privateDirectory, briefBuffer);
    const scriptByAction = {
      validate: "validate_direct_sticker_brief.mjs",
      selection: "prepare_video_selection.mjs",
      render: "render_direct_sticker.mjs",
    };
    const args = action === "validate" ? [briefPath] : [briefPath, path.resolve(outputParent)];
    const result = runScript(scriptByAction[action], args);
    if (result.error) throw result.error;
    resultCode = result.status ?? 1;
  } catch (error) {
    console.error(`私有 direct sticker brief 流程失败：${error.message}`);
    resultCode = 1;
  } finally {
    if (privateDirectory) {
      await rm(privateDirectory, { recursive: true, force: true }).catch((error) => {
        console.error(`私有 direct sticker brief 清理失败：${error.message}`);
        resultCode = 1;
      });
    }
  }
  return resultCode;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath && entryPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

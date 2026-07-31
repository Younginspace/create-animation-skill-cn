#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BRIEF_BYTES = 256 * 1024;
const PROCESS_TIMEOUT_MS = 20 * 60 * 1000;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

async function readBoundedStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BRIEF_BYTES) {
      process.stdin.destroy();
      throw new Error("stdin source brief 超过256KB");
    }
    chunks.push(buffer);
  }
  if (total === 0) throw new Error("stdin 中没有 source brief JSON");
  const raw = Buffer.concat(chunks, total).toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("stdin 不是有效 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("stdin source brief 根节点必须是对象");
  }
  return Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

async function writePrivateBrief(directory, buffer) {
  const briefPath = path.join(directory, "source-brief.json");
  const handle = await open(
    briefPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW || 0),
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

function runScript(name, args) {
  return spawnSync(process.execPath, [path.join(scriptDir, name), ...args], {
    stdio: "inherit",
    env: process.env,
    timeout: PROCESS_TIMEOUT_MS,
  });
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    console.error(
      "用法：通过 stdin 提供 source brief JSON；node scripts/scaffold_from_stdin.mjs <工程父目录>",
    );
    return 2;
  }
  let privateDirectory = null;
  let resultCode = 1;
  try {
    const briefBuffer = await readBoundedStdin();
    privateDirectory = await mkdtemp(path.join(os.tmpdir(), "create-animation-brief-"));
    const briefPath = await writePrivateBrief(privateDirectory, briefBuffer);
    const validate = runScript("validate_brief.mjs", [briefPath]);
    if (validate.error) throw validate.error;
    if (validate.status !== 0) {
      resultCode = validate.status ?? 1;
    } else {
      const scaffold = runScript("scaffold_project.mjs", [
        briefPath,
        path.resolve(argv[0]),
      ]);
      if (scaffold.error) throw scaffold.error;
      resultCode = scaffold.status ?? 1;
    }
  } catch (error) {
    console.error(`私有 brief 流程失败：${error.message}`);
    resultCode = 1;
  } finally {
    if (privateDirectory) {
      await rm(privateDirectory, { recursive: true, force: true }).catch((error) => {
        console.error(`私有 source brief 清理失败：${error.message}`);
        resultCode = 1;
      });
    }
  }
  return resultCode;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  process.exitCode = await main();
}

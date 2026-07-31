#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotEvidenceDigest } from "./approve_preview.mjs";
import { resolveRunner } from "./render_project.mjs";
import {
  freezeProject,
  guardedRuntimeEnv,
  projectContractDigest,
} from "./runtime_guard.mjs";
import { verifyProject } from "./verify_project.mjs";

const PROCESS_TIMEOUT_MS = 20 * 60 * 1000;

async function plannedTransitionTimes(projectDir) {
  const plan = JSON.parse(await readFile(path.join(projectDir, "animation-plan.json"), "utf8"));
  const duration = Number(plan.duration_seconds);
  const times = new Set();
  for (const scene of Array.isArray(plan.scenes) ? plan.scenes.slice(1) : []) {
    const start = Number(scene.start);
    if (!Number.isFinite(start) || start <= 0 || start >= duration) continue;
    const overlap = Math.max(0, Number(scene.transition_overlap_seconds) || 0);
    const offsets = overlap > 0 ? [-overlap * (2 / 3), 0, overlap * (2 / 3)] : [0];
    for (const offset of offsets) {
      const time = Math.min(duration - 0.001, Math.max(0.001, start + offset));
      times.add(Number(time.toFixed(3)));
    }
  }
  return [...times].sort((left, right) => left - right);
}

export async function main(argv = process.argv.slice(2)) {
  const projectDir = path.resolve(argv[0] || ".");
  let frozen = null;
  try {
    const projectCheck = await verifyProject(projectDir);
    if (!projectCheck.ok) {
      throw new Error(`工程未通过检查前验证：${projectCheck.errors.join("；")}`);
    }
    frozen = await freezeProject(projectDir, verifyProject);
    const executionProject = frozen.frozenRoot;
    const runner = resolveRunner();
    const runtimeEnv = await guardedRuntimeEnv();
    const transitionTimes = await plannedTransitionTimes(executionProject);
    // v0.7.83 的 root CLI 只有在 argv 含 --json 时才完全跳过两个后台
    // update/skills-manifest fetch；因此即使输出主要供人阅读也必须保留该参数。
    const checkArgs = ["check", executionProject, "--snapshots", "--at-transitions"];
    if (transitionTimes.length) checkArgs.push("--at", transitionTimes.join(","));
    checkArgs.push("--json");
    const result = spawnSync(runner, checkArgs, {
      stdio: "inherit",
      env: runtimeEnv,
      timeout: PROCESS_TIMEOUT_MS,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`HyperFrames 检查进程退出码 ${result.status ?? 1}`);
    if (transitionTimes.length) {
      const transitionDir = path.join(executionProject, "snapshots", "transitions");
      await rm(transitionDir, { recursive: true, force: true });
      const snapshotResult = spawnSync(
        runner,
        [
          "snapshot",
          executionProject,
          "--at",
          transitionTimes.join(","),
          "--no-end",
          "--output",
          transitionDir,
          "--json",
        ],
        { stdio: "inherit", env: runtimeEnv, timeout: PROCESS_TIMEOUT_MS },
      );
      if (snapshotResult.error) throw snapshotResult.error;
      if (snapshotResult.status !== 0) {
        throw new Error(`转场快照进程退出码 ${snapshotResult.status ?? 1}`);
      }
      await writeFile(
        path.join(transitionDir, "manifest.json"),
        `${JSON.stringify(
          {
            source: "animation-plan.json",
            purpose: "photo-story-transition-review",
            times_seconds: transitionTimes,
          },
          null,
          2,
        )}\n`,
      );
      console.log(`转场快照：${transitionTimes.join(", ")} 秒`);
    }
    const contractSha256 = await projectContractDigest(executionProject);
    const evidenceSha256 = await snapshotEvidenceDigest(
      path.join(executionProject, "snapshots"),
    );
    await writeFile(
      path.join(executionProject, "snapshots", "run-manifest.json"),
      `${JSON.stringify(
        {
          schema_kind: "preview-check",
          schema_version: 1,
          source_project: path.basename(projectDir),
          purpose: "verified-preview-review",
          contract_sha256: contractSha256,
          evidence_sha256: evidenceSha256,
          transition_times_seconds: transitionTimes,
          checked_at: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    await frozen.assertSourceUnchanged();
    const snapshotsRoot = path.join(projectDir, "snapshots");
    await mkdir(snapshotsRoot, { recursive: false, mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const snapshotsIdentity = await lstat(snapshotsRoot);
    const snapshotsRealPath = await realpath(snapshotsRoot);
    if (
      !snapshotsIdentity.isDirectory() ||
      snapshotsIdentity.isSymbolicLink() ||
      snapshotsRealPath !== snapshotsRoot
    ) {
      throw new Error("snapshots/ 必须是非符号链接的真实目录");
    }
    const assertSnapshotsIdentity = async () => {
      await frozen.assertSourceUnchanged();
      const current = await lstat(snapshotsRoot);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== snapshotsIdentity.dev ||
        current.ino !== snapshotsIdentity.ino ||
        (await realpath(snapshotsRoot)) !== snapshotsRoot
      ) {
        throw new Error("snapshots/ 在检查期间被替换，拒绝回写");
      }
    };
    const runDir = path.join(snapshotsRoot, `verified-${Date.now()}`);
    await assertSnapshotsIdentity();
    await cp(path.join(executionProject, "snapshots"), runDir, {
      recursive: true,
      dereference: false,
      preserveTimestamps: false,
      errorOnExist: true,
    });
    const copiedEvidenceSha256 = await snapshotEvidenceDigest(runDir);
    if (copiedEvidenceSha256 !== evidenceSha256) {
      throw new Error("写回的快照证据与已检查副本不一致");
    }
    await assertSnapshotsIdentity();
    console.log(`检查快照：${runDir}`);
    console.log(`检查通过：${projectDir}`);
    console.log("人工查看全部关键快照后，必须显式批准本次记录，渲染入口才会放行：");
    console.log(
      `node ${path.join(path.dirname(fileURLToPath(import.meta.url)), "approve_preview.mjs")} ${projectDir} ${runDir}`,
    );
    return 0;
  } catch (error) {
    console.error(`检查失败：${error.message}`);
    return 1;
  } finally {
    await frozen?.cleanup().catch(() => {});
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  process.exitCode = await main();
}

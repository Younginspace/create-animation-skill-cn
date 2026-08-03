#!/usr/bin/env node
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStableJson, sha256File, writeJsonExclusive } from "./direct_sticker_common.mjs";
import { verifyDirectSticker } from "./verify_direct_sticker.mjs";

export async function approveDirectSticker(projectPath) {
  const linkInfo = await lstat(projectPath);
  if (linkInfo.isSymbolicLink()) throw new Error("direct sticker 工程目录不得是符号链接");
  const projectDirectory = await realpath(projectPath);
  const deliveryPath = path.join(projectDirectory, "delivery-brief.json");
  const delivery = await readStableJson(deliveryPath, "delivery brief", 256 * 1024);
  const artifact = path.join(projectDirectory, delivery.output?.path || "");
  const relativeArtifact = path.relative(projectDirectory, artifact);
  if (relativeArtifact.startsWith("..") || path.isAbsolute(relativeArtifact)) throw new Error("delivery 产物路径越界");
  const technical = await verifyDirectSticker(artifact, deliveryPath);
  if (!technical.ok) throw new Error(`技术验证未通过：${technical.errors.join("；")}`);
  const previewNames = delivery.output_format === "gif"
    ? ["start.png", "middle.png", "end.png"]
    : ["final.png"];
  const previews = {};
  for (const name of previewNames) {
    previews[`previews/${name}`] = await sha256File(path.join(projectDirectory, "previews", name), 16 * 1024 * 1024);
  }
  const approval = {
    schema_kind: "direct-sticker-visual-approval",
    schema_version: 1,
    project_name: delivery.project_name,
    output_sha256: delivery.output.sha256,
    delivery_sha256: await sha256File(deliveryPath, 256 * 1024),
    preview_sha256: previews,
    reviewed_checks: ["文案完整可读", "裁切锚点正确", "主体未被文字遮挡", "循环接缝或静态构图可接受"],
    approved_at: new Date().toISOString(),
  };
  const approvalPath = path.join(projectDirectory, "visual-approval.json");
  await writeJsonExclusive(approvalPath, approval);
  return { approvalPath, artifact, deliveryPath };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    console.error("用法：查看全部 previews 后运行 node scripts/approve_direct_sticker.mjs <direct sticker 工程目录>");
    process.exit(2);
  }
  const result = await approveDirectSticker(path.resolve(argv[0]));
  console.log(`结果：通过（视觉批准已绑定当前交付声明、成品与预览）\n批准：${result.approvalPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`批准失败：${error.message}`);
    process.exit(1);
  });
}

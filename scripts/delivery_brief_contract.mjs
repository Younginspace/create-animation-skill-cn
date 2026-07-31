const FUNCTION_LIMITS = {
  sticker: { duration: [2, 6], media: [0, 1], title: 16 },
  card: { duration: [4, 10], media: [0, 1], title: 16 },
  "photo-story": { duration: [6, 30], media: [3, 12], title: 20 },
};
const ASPECT_RATIOS = new Set(["1:1", "9:16", "16:9"]);
const OUTPUT_FORMATS = new Set(["mp4", "gif"]);
const STYLES = new Set(["warm", "playful", "clean", "energetic"]);
const PRIVACY_STATUSES = new Set([
  "reviewed-no-sensitive-content",
  "user-confirmed-keep",
  "source-already-redacted",
]);

function nonemptyString(value, maximum) {
  return typeof value === "string" && value.trim().length > 0 && [...value.trim()].length <= maximum;
}

function safeAssetPath(value) {
  return (
    typeof value === "string" &&
    /^assets\/[^/\\]+$/.test(value) &&
    !value.split(/[\\/]/).includes("..")
  );
}

export function validateDeliveryBriefContract(brief, options = {}) {
  const label = options.label || "delivery brief";
  const errors = [];
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) {
    return [`${label} 根节点必须是对象`];
  }

  if (brief.schema_kind !== "delivery" || brief.schema_version !== 2) {
    errors.push(`${label} 必须声明 schema_kind: "delivery" 和 schema_version: 2`);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(brief.project_name || "")) {
    errors.push(`${label}.project_name 必须是1—48位英文小写、数字或短横线`);
  }
  if ("approved_media_roots" in brief || "privacy_actions" in brief) {
    errors.push(`${label} 含仅限 source brief 或已废弃的字段`);
  }

  const rule = FUNCTION_LIMITS[brief.function];
  if (!rule) errors.push(`${label}.function 必须是 sticker、card 或 photo-story`);

  const message = brief.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    errors.push(`${label}.message 必须是对象`);
  } else {
    const unknownMessageFields = Object.keys(message).filter(
      (field) => !["title", "subtitle", "signature"].includes(field),
    );
    if (unknownMessageFields.length) {
      errors.push(`${label}.message 含未知字段：${unknownMessageFields.join("、")}`);
    }
    const hasTitle = Object.prototype.hasOwnProperty.call(message, "title");
    if (hasTitle && typeof message.title !== "string") {
      errors.push(`${label}.message.title 必须是字符串`);
    } else if (brief.function !== "photo-story" && (!hasTitle || !message.title.trim())) {
      errors.push(`${label}.message.title 在 sticker 和 card 中不能为空`);
    } else if (hasTitle && rule && [...message.title].length > rule.title) {
      errors.push(`${label}.message.title 最多 ${rule.title} 个字符`);
    }
    for (const [field, maximum] of [
      ["subtitle", 30],
      ["signature", 16],
    ]) {
      if (field in message && (typeof message[field] !== "string" || [...message[field]].length > maximum)) {
        errors.push(`${label}.message.${field} 必须是最多 ${maximum} 个字符的字符串`);
      }
    }
  }

  if (!nonemptyString(brief.use_case, 30)) {
    errors.push(`${label}.use_case 必须是1—30个字符的非空字符串`);
  }
  if (!STYLES.has(brief.style)) {
    errors.push(`${label}.style 必须是 warm、playful、clean 或 energetic`);
  }
  if (!Array.isArray(brief.facts_to_preserve)) {
    errors.push(`${label}.facts_to_preserve 必须是数组`);
  } else {
    if (brief.facts_to_preserve.length > 20) {
      errors.push(`${label}.facts_to_preserve 最多20项`);
    }
    if (brief.facts_to_preserve.some((item) => !nonemptyString(item, 120))) {
      errors.push(`${label}.facts_to_preserve 每项必须是1—120个字符的非空字符串`);
    }
  }

  if (typeof brief.duration_seconds !== "number" || !Number.isFinite(brief.duration_seconds)) {
    errors.push(`${label}.duration_seconds 必须是有限数字`);
  } else if (
    rule &&
    (brief.duration_seconds < rule.duration[0] || brief.duration_seconds > rule.duration[1])
  ) {
    errors.push(`${brief.function} 时长必须在 ${rule.duration[0]}—${rule.duration[1]} 秒`);
  }
  if (!ASPECT_RATIOS.has(brief.aspect_ratio)) {
    errors.push(`${label}.aspect_ratio 必须是 1:1、9:16 或 16:9`);
  }
  if (!OUTPUT_FORMATS.has(brief.output_format)) {
    errors.push(`${label}.output_format 必须是 mp4 或 gif`);
  }
  if (typeof brief.loop !== "boolean") errors.push(`${label}.loop 必须是布尔值`);

  const media = brief.media;
  if (!Array.isArray(media)) {
    errors.push(`${label}.media 必须是数组`);
  } else {
    if (media.length > 12) errors.push(`${label}.media 最多12项`);
    if (rule && (media.length < rule.media[0] || media.length > rule.media[1])) {
      errors.push(`${brief.function} 需要 ${rule.media[0]}—${rule.media[1]} 个图片素材`);
    }
    const sourceIds = new Set();
    const projectPaths = new Set();
    for (const [index, item] of media.slice(0, 12).entries()) {
      const itemLabel = `${label}.media[${index}]`;
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        errors.push(`${itemLabel} 必须是对象`);
        continue;
      }
      if (!nonemptyString(item.source_id, 80) || sourceIds.has(item.source_id)) {
        errors.push(`${itemLabel}.source_id 必须是1—80个字符且不可重复`);
      } else {
        sourceIds.add(item.source_id);
      }
      if (!safeAssetPath(item.project_path) || projectPaths.has(item.project_path)) {
        errors.push(`${itemLabel}.project_path 必须是 assets/ 下不重复的单层安全相对路径`);
      } else {
        projectPaths.add(item.project_path);
      }
      if (!nonemptyString(item.alt, 200)) {
        errors.push(`${itemLabel}.alt 必须是1—200个字符的非空字符串`);
      }
    }
  }

  const privacy = brief.privacy_review;
  if (!privacy || typeof privacy !== "object" || Array.isArray(privacy)) {
    errors.push(`${label}.privacy_review 必须是对象`);
  } else {
    if (!PRIVACY_STATUSES.has(privacy.status)) errors.push(`${label}.privacy_review.status 无效`);
    if (!Array.isArray(privacy.actions)) {
      errors.push(`${label}.privacy_review.actions 必须是数组`);
    } else {
      if (privacy.actions.length > 10) errors.push(`${label}.privacy_review.actions 最多10项`);
      if (privacy.actions.some((item) => !nonemptyString(item, 100))) {
        errors.push(`${label}.privacy_review.actions 每项必须是1—100个字符的非空字符串`);
      }
      if (privacy.status === "source-already-redacted" && privacy.actions.length === 0) {
        errors.push("source-already-redacted 必须记录已完成的脱敏动作");
      }
      if (privacy.status !== "source-already-redacted" && privacy.actions.length > 0) {
        errors.push("只有 source-already-redacted 可以包含 privacy_review.actions");
      }
    }
    if (privacy.image_metadata !== "sensitive-stripped-orientation-preserved") {
      errors.push(
        `${label}.privacy_review.image_metadata 必须是 "sensitive-stripped-orientation-preserved"`,
      );
    }
  }
  return errors;
}

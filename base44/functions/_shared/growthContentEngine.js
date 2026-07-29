const TOKEN_MAX = 120;
export const MAX_SOCIAL_POST_TEXT = 2200;

export function normalized(value) {
  return String(value || "").trim().toLowerCase();
}

export function token(value, fallback = "") {
  return normalized(value)
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._~-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, TOKEN_MAX) || fallback;
}

export function compactText(value, max) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
}

export function timestamp(value) {
  const parsed = new Date(value || "");
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function asArray(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

export function canonicalStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalStringify(nested)}`)
    .join(",")}}`;
}

export function isPublicHttpsUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      return false;
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const unbracketedHost = host.replace(/^\[|\]$/g, "");
    const ipv4 = unbracketedHost.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (
      !host
      || unbracketedHost.includes(":")
      || host === "localhost"
      || host.endsWith(".localhost")
    ) {
      return false;
    }
    if (ipv4) {
      const octets = ipv4.slice(1).map(Number);
      const [first, second] = octets;
      if (
        octets.some((octet) => octet < 0 || octet > 255)
        || first === 0
        || first === 10
        || first === 127
        || (first === 100 && second >= 64 && second <= 127)
        || (first === 169 && second === 254)
        || (first === 172 && second >= 16 && second <= 31)
        || (first === 192 && second === 168)
        || (first === 198 && (second === 18 || second === 19))
        || first >= 224
      ) {
        return false;
      }
    }
    return Boolean(host)
      && host !== "localhost"
      && !host.endsWith(".localhost")
      && !unbracketedHost.includes(":");
  } catch {
    return false;
  }
}

export function instagramTrackedUrl(campaign, contentId) {
  const url = new URL("/instagram", "https://firstknock.online");
  url.searchParams.set("utm_source", "instagram");
  url.searchParams.set("utm_medium", "organic_social");
  url.searchParams.set("utm_campaign", token(campaign, "1000-users"));
  url.searchParams.set("utm_content", token(contentId, "ig-bio"));
  return url.toString();
}

export function platformTrackedUrl(platform, campaign, contentId) {
  const source = token(platform);
  const fallbackContent = source === "tiktok" ? "tt-bio" : "ig-bio";
  const url = new URL("/start", "https://firstknock.online");
  url.searchParams.set("utm_source", source);
  url.searchParams.set("utm_medium", "organic_social");
  url.searchParams.set("utm_campaign", token(campaign, "1000-users"));
  url.searchParams.set("utm_content", token(contentId, fallbackContent));
  return url.toString();
}

export function socialPostText(artifact) {
  const caption = String(artifact?.caption || "").trim();
  const disclosure = compactText(artifact?.disclosure, 500);
  const ctaLabel = compactText(artifact?.cta_label, 160);
  const ctaUrl = String(artifact?.cta_url || "").trim().slice(0, 2048);
  const blocks = caption ? [caption] : [];
  const captionNormalized = normalized(caption);
  if (disclosure && !captionNormalized.includes(normalized(disclosure))) {
    blocks.push(disclosure);
  }
  const cta = [ctaLabel, ctaUrl].filter(Boolean).join(": ");
  const ctaAlreadyPresent = ctaUrl
    ? caption.includes(ctaUrl)
    : ctaLabel && captionNormalized.includes(normalized(ctaLabel));
  if (cta && !ctaAlreadyPresent) blocks.push(cta);
  return blocks.join("\n\n");
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  return sha256BytesHex(bytes);
}

export async function sha256BytesHex(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function canonicalArtifactPayload(artifact) {
  return {
    artifact_key: token(artifact?.artifact_key),
    campaign: token(artifact?.campaign, "1000-users"),
    concept_id: token(artifact?.concept_id),
    revision: Number(artifact?.revision || 0),
    platform: token(artifact?.platform),
    platform_content_id: token(artifact?.platform_content_id),
    format: token(artifact?.format),
    title: compactText(artifact?.title, 160),
    pillar: compactText(artifact?.pillar, 120),
    source_asset_keys: asArray(artifact?.source_asset_keys)
      .map((value) => token(value))
      .filter(Boolean),
    hook: compactText(artifact?.hook, 300),
    caption: String(artifact?.caption || "").trim().slice(0, 5000),
    provider_text: socialPostText(artifact),
    overlay_text: asArray(artifact?.overlay_text)
      .map((value) => compactText(value, 160))
      .filter(Boolean)
      .slice(0, 20),
    shot_list: asArray(artifact?.shot_list)
      .map((value) => compactText(value, 300))
      .filter(Boolean)
      .slice(0, 30),
    cta_label: compactText(artifact?.cta_label, 160),
    cta_url: String(artifact?.cta_url || "").trim().slice(0, 2048),
    disclosure: compactText(artifact?.disclosure, 500),
    ai_generated: artifact?.ai_generated === true,
    media_url: String(artifact?.media_url || "").trim().slice(0, 2048),
    media_sha256: normalized(artifact?.media_sha256),
    mime_type: normalized(artifact?.mime_type),
    width: Number(artifact?.width || 0),
    height: Number(artifact?.height || 0),
    duration_ms: Number(artifact?.duration_ms || 0),
    thumbnail_offset_ms: Number(artifact?.thumbnail_offset_ms || 0),
    render_result_schema: compactText(artifact?.render_result_schema, 80),
    render_pack_sha256: normalized(artifact?.render_pack_sha256),
    render_template_id: token(artifact?.render_template_id),
    render_template_version: compactText(artifact?.render_template_version, 80),
    render_input_sha256: normalized(artifact?.render_input_sha256),
    render_profile_id: token(artifact?.render_profile_id),
    render_environment_sha256: normalized(
      artifact?.render_environment_sha256,
    ),
    render_delivery_key: String(artifact?.render_delivery_key || "")
      .trim()
      .slice(0, 300),
    render_source_lineage: asArray(artifact?.render_source_lineage)
      .map((source) => ({
        asset_key: token(source?.asset_key),
        source_reference: String(source?.source_reference || "")
          .trim()
          .slice(0, 300),
        source_sha256: normalized(source?.source_sha256),
      })),
    media_byte_size: Number(artifact?.media_byte_size || 0),
    audio_mode: token(artifact?.audio_mode),
    growth_batch_key: normalized(artifact?.growth_batch_key),
    growth_batch_target_date: String(
      artifact?.growth_batch_target_date || "",
    ).trim().slice(0, 10),
    growth_batch_slot_key: token(artifact?.growth_batch_slot_key),
    review_status: token(artifact?.review_status),
    privacy_cleared: artifact?.privacy_cleared === true,
    demo_labeled: artifact?.demo_labeled === true,
    claims_supported: artifact?.claims_supported === true,
    media_rights_confirmed: artifact?.media_rights_confirmed === true,
  };
}

export async function artifactApprovalHash(artifact) {
  return sha256Hex(canonicalStringify(canonicalArtifactPayload(artifact)));
}

export function canonicalJobRequest(job) {
  const sourceLineageSnapshot = asArray(job?.source_lineage_snapshot)
    .map((source) => ({
      asset_key: token(source?.asset_key),
      source_reference: String(source?.source_reference || "")
        .trim()
        .slice(0, 300),
      source_sha256: normalized(source?.source_sha256),
    }));
  const hookSnapshot = compactText(job?.hook_snapshot, 300);
  const renderPackSha256 = normalized(job?.render_pack_sha256);
  const growthBatchKey = normalized(job?.growth_batch_key);
  return {
    provider: "buffer",
    provider_organization_id: String(job?.provider_organization_id || ""),
    provider_channel_id: String(job?.provider_channel_id || ""),
    provider_service: token(job?.provider_service),
    config_revision: normalized(job?.config_revision),
    media_origin: String(job?.media_origin || ""),
    artifact_hash: normalized(job?.artifact_hash),
    platform: token(job?.platform),
    platform_content_id: token(job?.platform_content_id),
    due_at: timestamp(job?.due_at) || "",
    scheduling_type: token(job?.scheduling_type),
    timezone: compactText(job?.timezone, 80),
    ...(sourceLineageSnapshot.length
      ? { source_lineage_snapshot: sourceLineageSnapshot }
      : {}),
    ...(hookSnapshot ? { hook_snapshot: hookSnapshot } : {}),
    ...(renderPackSha256 ? { render_pack_sha256: renderPackSha256 } : {}),
    ...(growthBatchKey ? { growth_batch_key: growthBatchKey } : {}),
  };
}

export async function publishJobRequestHash(job) {
  return sha256Hex(canonicalStringify(canonicalJobRequest(job)));
}

export async function publishJobKey(job) {
  return sha256Hex(canonicalStringify({
    provider: "buffer",
    provider_organization_id: String(job?.provider_organization_id || ""),
    provider_channel_id: String(job?.provider_channel_id || ""),
    platform: token(job?.platform),
    platform_content_id: token(job?.platform_content_id),
    artifact_hash: normalized(job?.artifact_hash),
    media_origin: String(job?.media_origin || ""),
  }));
}

export function isStablePublicHttpsUrl(value) {
  if (!isPublicHttpsUrl(value)) return false;
  const url = new URL(String(value || "").trim());
  return !url.search && url.href.length <= 2048;
}

export function isContentAddressedMediaUrl(value, sha256) {
  if (!isStablePublicHttpsUrl(value) || !/^[a-f0-9]{64}$/.test(normalized(sha256))) {
    return false;
  }
  try {
    const pathname = decodeURIComponent(new URL(String(value)).pathname).toLowerCase();
    return pathname.includes(normalized(sha256));
  } catch {
    return false;
  }
}

export function constantTimeEqual(leftValue, rightValue) {
  const left = new TextEncoder().encode(String(leftValue || ""));
  const right = new TextEncoder().encode(String(rightValue || ""));
  const length = Math.max(left.length, right.length, 1);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left[index % Math.max(left.length, 1)] || 0)
      ^ (right[index % Math.max(right.length, 1)] || 0);
  }
  return mismatch === 0;
}

export function safeProviderError(value, fallback = "provider_request_failed") {
  const message = compactText(value, 240)
    .replace(/bearer\s+[a-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(?:api|access|worker)[_-]?(?:key|token|secret)\s*[:=]\s*\S+/gi, "[redacted]");
  return message || fallback;
}

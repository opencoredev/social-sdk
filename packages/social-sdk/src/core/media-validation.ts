import type {
  CapabilityConstraints,
  CapabilityDeclaration,
  MediaAttachment,
  MediaInput,
  Platform,
  PreparationIssue,
  PublishContent,
} from "./types.js";

/** Host used for preparation placeholders when the staging provider names no origin. */
export const DEFAULT_STAGING_ORIGIN = "https://staging.social-sdk.invalid";

type ContentFormat = NonNullable<CapabilityDeclaration["formats"]>[number];

function contentFormats(content: PublishContent): readonly ContentFormat[] {
  const media = content.media ?? [];

  if (media.length === 0) return ["text"];

  const kinds = media.map((item) => item.kind);

  return media.length > 1 ? [...kinds, "carousel"] : kinds;
}

function matchesContent(declaration: CapabilityDeclaration, content: PublishContent): boolean {
  const formats = declaration.formats;

  if (formats === undefined) return true;

  return contentFormats(content).every((format) => formats.includes(format));
}

/**
 * The `posts.publish` declaration whose constraints apply to this content. The
 * first declaration for the platform decides as before; when an adapter
 * declares several at the same platform specificity, an available one whose
 * `formats` cover the content wins, so a platform can constrain photo and video
 * posts differently.
 */
export function selectPublishDeclaration(
  declarations: readonly CapabilityDeclaration[],
  platform: Platform,
  content: PublishContent,
): CapabilityDeclaration | undefined {
  const first = declarations.find(
    (candidate) =>
      candidate.operation === "posts.publish" &&
      (candidate.platform === "*" || candidate.platform === platform),
  );

  if (first === undefined) return undefined;

  return (
    declarations.find(
      (candidate) =>
        candidate.operation === "posts.publish" &&
        candidate.platform === first.platform &&
        candidate.availability === "available" &&
        matchesContent(candidate, content),
    ) ?? first
  );
}

/** Local media the core can stage for a target whose capability accepts only HTTPS URLs. */
export function needsStaging(
  constraints: CapabilityConstraints | undefined,
  source: MediaInput,
  stagingEnabled: boolean,
): boolean {
  const sources = constraints?.mediaSources;

  return (
    stagingEnabled &&
    (source.kind === "blob" || source.kind === "stream") &&
    sources !== undefined &&
    sources.includes("https-url") &&
    !sources.includes(source.kind)
  );
}

/** Replaces each source the core will stage with a placeholder URL on the staging origin. */
export function withStagingPlaceholders(
  content: PublishContent,
  constraints: CapabilityConstraints | undefined,
  origin: string,
): PublishContent {
  const media = content.media;

  if (media === undefined) return content;

  const placeholder = (source: MediaInput, name: string): MediaInput =>
    needsStaging(constraints, source, true)
      ? { kind: "https-url", url: `${origin}/social-sdk-staging/${name}` }
      : source;

  return {
    ...content,
    media: media.map((item, index) => {
      const attachment: MediaAttachment = {
        ...item,
        source: placeholder(item.source, String(index)),
      };

      if (item.thumbnail === undefined) return attachment;

      return { ...attachment, thumbnail: placeholder(item.thumbnail, `${index}-thumbnail`) };
    }),
  };
}

function hasMediaLimits(constraints: CapabilityConstraints): boolean {
  return (
    constraints.maxBytes !== undefined ||
    constraints.allowedMimeTypes !== undefined ||
    constraints.aspectRatioRange !== undefined ||
    constraints.maxDurationSeconds !== undefined
  );
}

function essence(mimeType: string): string {
  return (mimeType.split(";")[0] ?? "").trim().toLowerCase();
}

function mimeAllowed(mimeType: string, allowed: readonly string[]): boolean {
  const actual = essence(mimeType);

  return allowed.some((pattern) => {
    const expected = essence(pattern);

    return expected.endsWith("/*") ? actual.startsWith(expected.slice(0, -1)) : actual === expected;
  });
}

function positiveFinite(value: number | undefined): boolean {
  return value === undefined || (Number.isFinite(value) && value > 0);
}

/** Blob size and type, read only from a real `Blob` so untyped callers cannot spoof them. */
function blobFacts(source: MediaInput): { size: number; type: string | undefined } | undefined {
  if (source.kind !== "blob" || typeof Blob === "undefined" || !(source.blob instanceof Blob))
    return undefined;

  return { size: source.blob.size, type: source.blob.type === "" ? undefined : source.blob.type };
}

/**
 * Pure checks of attachments against declared capability constraints. Values
 * the SDK cannot know locally, such as the size of a stream without
 * `byteSize` or remote URL content, are left to the adapter and provider.
 */
export function mediaConstraintIssues(input: {
  readonly media: readonly MediaAttachment[];
  readonly constraints: CapabilityConstraints | undefined;
  readonly targetIndex: number;
  readonly stagingEnabled: boolean;
}): PreparationIssue[] {
  const { media, constraints, targetIndex } = input;
  const issues: PreparationIssue[] = [];

  if (constraints === undefined) return issues;

  const issue = (code: string, message: string, path: string): void => {
    issues.push({ code, message, path, targetIndex, severity: "error" });
  };

  if (constraints.maxItems !== undefined && media.length > constraints.maxItems)
    issue(
      "media.too_many",
      `This target accepts at most ${constraints.maxItems} attachments.`,
      "content.media",
    );

  const allowedSources = constraints.mediaSources;
  const checkLimits = hasMediaLimits(constraints);

  for (const [index, item] of media.entries()) {
    const path = `content.media[${index}]`;

    if (allowedSources !== undefined) {
      const sources: readonly [MediaInput, string][] =
        item.thumbnail === undefined
          ? [[item.source, `${path}.source`]]
          : [
              [item.source, `${path}.source`],
              [item.thumbnail, `${path}.thumbnail`],
            ];

      for (const [source, sourcePath] of sources)
        if (
          !allowedSources.includes(source.kind) &&
          !needsStaging(constraints, source, input.stagingEnabled)
        )
          issue(
            "media.source_unsupported",
            allowedSources.includes("https-url") &&
              (source.kind === "blob" || source.kind === "stream")
              ? "This target accepts only HTTPS media URLs. Configure mediaStaging to publish local media."
              : `This target accepts media sources: ${allowedSources.join(", ")}.`,
            sourcePath,
          );
    }

    if (!checkLimits) continue;

    if (
      (item.byteSize !== undefined &&
        (!Number.isSafeInteger(item.byteSize) || item.byteSize < 0)) ||
      !positiveFinite(item.width) ||
      !positiveFinite(item.height) ||
      (item.durationSeconds !== undefined &&
        (!Number.isFinite(item.durationSeconds) || item.durationSeconds < 0))
    ) {
      issue(
        "media.metadata_invalid",
        "Media size, dimensions and duration must be finite non-negative numbers.",
        path,
      );
      continue;
    }

    const actual = blobFacts(item.source);

    if (actual !== undefined && item.byteSize !== undefined && actual.size !== item.byteSize)
      issue("media.size_mismatch", "byteSize does not match the blob size.", `${path}.byteSize`);

    const size = actual?.size ?? item.byteSize;

    if (constraints.maxBytes !== undefined && size !== undefined && size > constraints.maxBytes)
      issue(
        "media.too_large",
        `This target accepts media up to ${constraints.maxBytes} bytes.`,
        `${path}.byteSize`,
      );

    if (
      actual?.type !== undefined &&
      item.mimeType !== undefined &&
      essence(actual.type) !== essence(item.mimeType)
    )
      issue("media.mime_mismatch", "mimeType does not match the blob type.", `${path}.mimeType`);

    const mimeType = item.mimeType ?? actual?.type;

    if (
      constraints.allowedMimeTypes !== undefined &&
      mimeType !== undefined &&
      !mimeAllowed(mimeType, constraints.allowedMimeTypes)
    )
      issue(
        "media.mime_unsupported",
        `This target accepts media types: ${constraints.allowedMimeTypes.join(", ")}.`,
        `${path}.mimeType`,
      );

    const range = constraints.aspectRatioRange;

    if (
      range !== undefined &&
      (item.kind === "image" || item.kind === "video") &&
      item.width !== undefined &&
      item.height !== undefined
    ) {
      const ratio = item.width / item.height;

      if (ratio < range[0] || ratio > range[1])
        issue(
          "media.aspect_ratio",
          `This target accepts width/height ratios from ${range[0]} to ${range[1]}.`,
          path,
        );
    }

    if (
      constraints.maxDurationSeconds !== undefined &&
      item.kind === "video" &&
      item.durationSeconds !== undefined &&
      item.durationSeconds > constraints.maxDurationSeconds
    )
      issue(
        "media.too_long",
        `This target accepts videos up to ${constraints.maxDurationSeconds} seconds.`,
        `${path}.durationSeconds`,
      );
  }

  return issues;
}

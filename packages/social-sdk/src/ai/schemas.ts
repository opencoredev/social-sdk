import type { JsonObject } from "../core/types.js";

/**
 * Portable JSON Schema fragments for tool inputs. They avoid `const`, `$ref`
 * and format keywords so MCP clients, OpenAI function tools and the Vercel AI
 * SDK all accept them unchanged.
 */
const text = { type: "string", minLength: 1 } satisfies JsonObject;

const version = { type: "integer", enum: [1] } satisfies JsonObject;

function reference(
  kind: string,
  description: string,
  fields: readonly string[],
  extra: JsonObject = {},
): JsonObject {
  return {
    type: "object",
    description,
    properties: {
      kind: { type: "string", enum: [kind] },
      version,
      backend: { ...text, description: "Configured backend instance key." },
      ...Object.fromEntries(fields.map((field) => [field, text])),
      ...extra,
    },
    required: ["kind", "version", "backend", ...fields],
    additionalProperties: false,
  };
}

export const connectedAccountSchema = reference(
  "connected-account",
  "Connected account reference returned by social_list_accounts.",
  ["platform", "accountId"],
);

export const platformPostSchema = reference(
  "platform-post",
  "Platform post reference returned by a publish outcome or post listing.",
  ["platform", "accountId", "postId"],
  { native: { type: "object", description: "Provider-native identifiers, when returned." } },
);

export const commentSchema = reference(
  "comment",
  "Comment reference returned by social_list_comments.",
  ["platform", "accountId", "postId", "commentId"],
);

export const conversationSchema = reference(
  "conversation",
  "Conversation reference returned by social_list_conversations.",
  ["platform", "accountId", "conversationId"],
);

export const deliverySchema = reference("delivery", "Delivery reference from a publish outcome.", [
  "platform",
  "accountId",
  "deliveryId",
]);

export const scheduledJobSchema = reference(
  "scheduled-job",
  "Scheduled job reference from a scheduled publish outcome.",
  ["platform", "accountId", "jobId"],
);

export const backendPostSchema = reference(
  "backend-post",
  "Managed backend record reference. This is not a platform post ID.",
  ["platform", "accountId", "recordId"],
);

const replyToSchema = {
  description: "Post or comment to reply to on the same backend and platform.",
  anyOf: [platformPostSchema, commentSchema],
} satisfies JsonObject;

const mediaSourceSchema = {
  type: "object",
  description: "Agents may attach HTTPS URLs only. Upload files through your application.",
  properties: { kind: { type: "string", enum: ["https-url"] }, url: text },
  required: ["kind", "url"],
  additionalProperties: false,
} satisfies JsonObject;

const contentSchema = {
  type: "object",
  description: "Post content. Provide text, media, or a link.",
  properties: {
    text: { type: "string" },
    media: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["image", "video"] },
          source: mediaSourceSchema,
          mimeType: { type: "string" },
          altText: { type: "string" },
          caption: { type: "string" },
          width: { type: "number" },
          height: { type: "number" },
          durationSeconds: { type: "number" },
          byteSize: { type: "number" },
        },
        required: ["kind", "source"],
      },
    },
    link: {
      type: "object",
      properties: { url: text, title: { type: "string" }, description: { type: "string" } },
      required: ["url"],
    },
  },
} satisfies JsonObject;

const targetSchema = {
  type: "object",
  properties: {
    account: connectedAccountSchema,
    content: { ...contentSchema, description: "Per-target content override." },
    replyTo: replyToSchema,
    options: {
      type: "object",
      description: "Platform options such as YouTube title and visibility or TikTok privacy.",
    },
  },
  required: ["account"],
} satisfies JsonObject;

export const publishRequestSchema = {
  type: "object",
  description: "A Social SDK publish request.",
  properties: {
    targets: { type: "array", minItems: 1, items: targetSchema },
    content: contentSchema,
    idempotencyKey: {
      ...text,
      description: "Stable key for this logical post. Reuse it when retrying the same request.",
    },
    correlationId: { type: "string" },
    schedule: {
      type: "object",
      properties: {
        at: { ...text, description: "Future ISO 8601 timestamp." },
        timeZone: { type: "string" },
      },
      required: ["at"],
    },
    replyTo: replyToSchema,
  },
  required: ["targets", "content"],
} satisfies JsonObject;

export const publishSequenceSchema = {
  type: "object",
  description: "Ordered items published one after another, such as a thread.",
  properties: {
    items: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          targets: { type: "array", minItems: 1, items: targetSchema },
          content: contentSchema,
          replyTo: replyToSchema,
        },
        required: ["targets", "content"],
      },
    },
    idempotencyKey: text,
    stopOnFailure: { type: "boolean" },
    replyToPrevious: {
      type: "boolean",
      description: "Reply each item to the post the previous item published.",
    },
  },
  required: ["items", "idempotencyKey"],
} satisfies JsonObject;

export const confirmWriteSchema = {
  type: "boolean",
  description:
    "Set true only after reviewing the dry-run result and receiving the user's approval. Without it the tool returns a preview and sends nothing.",
} satisfies JsonObject;

export const cursorSchema = {
  type: "string",
  description: "Opaque nextCursor from the previous page.",
} satisfies JsonObject;

export const limitSchema = {
  type: "integer",
  minimum: 1,
  description: "Page size. The toolkit caps it at its configured maximum.",
} satisfies JsonObject;

export const messageTextSchema = { type: "string", minLength: 1, maxLength: 10_000 };

/** An object schema whose listed properties are all optional unless named in `required`. */
export function objectSchema(
  properties: { readonly [name: string]: JsonObject },
  required: readonly string[] = [],
): JsonObject {
  return { type: "object", properties, required, additionalProperties: false };
}

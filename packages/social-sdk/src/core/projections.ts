import { definedFields } from "./fields.js";
import type { CanonicalMetricName, JsonObject, MetricValue } from "./types.js";
import {
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  type JsonField,
} from "../transport/validation.js";

/** Provider fields remain available alongside the portable read projection. */
export type NormalizedReadRecord = JsonObject & {
  readonly id?: string;
  readonly authorId?: string;
  readonly authorHandle?: string;
  readonly authorName?: string;
  readonly text?: string;
  readonly createdAt?: string;
  readonly parentId?: string;
  readonly native: JsonObject;
};

export type CommentRecord = NormalizedReadRecord;

export type MessageRecord = NormalizedReadRecord;

export type ConversationRecord = NormalizedReadRecord;

// Only equivalent counters are mapped. Rates, watch time, follows gained and
// aggregate interactions deliberately have no canonical counter name.
const metricNames = new Map<string, CanonicalMetricName>(
  Object.entries({
    views: "views",
    view: "views",
    viewcount: "views",
    viewscount: "views",
    videoviews: "views",
    videoviewcount: "views",
    mediaviews: "views",
    plays: "views",
    playcount: "views",
    likes: "likes",
    like: "likes",
    likecount: "likes",
    likescount: "likes",
    favorites: "likes",
    favoritecount: "likes",
    comments: "comments",
    comment: "comments",
    commentcount: "comments",
    commentscount: "comments",
    replies: "comments",
    replycount: "comments",
    shares: "shares",
    share: "shares",
    sharecount: "shares",
    sharescount: "shares",
    reposts: "shares",
    repostcount: "shares",
    retweets: "shares",
    retweetcount: "shares",
    reshares: "shares",
    resharecount: "shares",
    impressions: "impressions",
    impressioncount: "impressions",
    reach: "reach",
    accountsreached: "reach",
    uniqueimpressionscount: "reach",
    saves: "saves",
    saved: "saves",
    savecount: "saves",
    bookmarks: "saves",
    bookmarkcount: "saves",
    clicks: "clicks",
    clickcount: "clicks",
    linkclicks: "clicks",
    linkclickcount: "clicks",
    urlclicks: "clicks",
    followers: "followers",
    followercount: "followers",
    followerscount: "followers",
    subscribers: "followers",
    subscribercount: "followers",
    profileviews: "profile_views",
    profileviewcount: "profile_views",
  } satisfies Readonly<Record<string, CanonicalMetricName>>),
);

export function canonicalMetricName(name: string): CanonicalMetricName | undefined {
  const key = name.replace(/[\s_-]/g, "").toLowerCase();

  return metricNames.get(key);
}

export function normalizeMetrics(values: readonly MetricValue[]): readonly MetricValue[] {
  return values.map((metric) => ({
    ...metric,
    ...definedFields({ canonicalName: metric.canonicalName ?? canonicalMetricName(metric.name) }),
  }));
}

function record(value: JsonField): JsonObject {
  return isJsonObject(value) ? value : {};
}

function firstString(...values: readonly JsonField[]): string | undefined {
  return values.find(isString);
}

function identifier(...values: readonly JsonField[]): string | undefined {
  for (const value of values) {
    if (isString(value) && value.length > 0) return value;

    if (isFiniteNumber(value) && Number.isSafeInteger(value)) return String(value);
  }

  return undefined;
}

function timestamp(value: JsonField): string | undefined {
  if (isString(value) && !/^\d+$/.test(value)) return value;
  const milliseconds = isString(value) ? Number(value) : value;

  if (!isFiniteNumber(milliseconds)) return undefined;
  const date = new Date(milliseconds);

  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function normalizeRecord(row: JsonObject): NormalizedReadRecord {
  const snippet = record(row["snippet"]);
  const topComment = record(snippet["topLevelComment"]);
  const post = isJsonObject(row["post"]) ? row["post"] : row;
  const content = record(post["record"]);
  const details = isJsonObject(topComment["snippet"]) ? topComment["snippet"] : snippet;
  const lastMessage = record(row["lastMessage"]);

  const author = record(
    row["author"] ?? post["author"] ?? row["from"] ?? row["sender"] ?? lastMessage["sender"],
  );

  const message = record(row["message"]);
  const created = record(row["created"]);
  const reply = record(content["reply"]);
  const references = row["referenced_tweets"] ?? row["referenced_posts"];

  const reference = isJsonArray(references)
    ? references.find((entry) => isJsonObject(entry) && entry["type"] === "replied_to")
    : undefined;

  const fields = { ...row };

  for (const key of [
    "id",
    "authorId",
    "authorHandle",
    "authorName",
    "text",
    "createdAt",
    "parentId",
  ])
    delete fields[key];

  return {
    ...fields,
    ...definedFields({
      id: identifier(
        row["commentUrn"],
        topComment["id"],
        row["id"],
        row["commentId"],
        row["messageId"],
        row["conversationId"],
        row["dm_event_id"],
        row["uri"],
        post["uri"],
      ),
      authorId: identifier(
        row["authorId"],
        row["author_id"],
        row["senderId"],
        row["sender_id"],
        author["id"],
        author["did"],
        row["actor"],
        created["actor"],
        record(details["authorChannelId"])["value"],
        row["participantId"],
        lastMessage["senderId"],
      ),
      authorHandle: firstString(
        row["authorHandle"],
        row["senderHandle"],
        author["handle"],
        author["username"],
        row["username"],
        row["participantHandle"],
      ),
      authorName: firstString(
        row["authorName"],
        row["senderName"],
        author["displayName"],
        author["name"],
        details["authorDisplayName"],
        row["participantName"],
        lastMessage["senderName"],
      ),
      text: firstString(
        row["text"],
        row["message"],
        message["text"],
        content["text"],
        row["textOriginal"],
        row["textDisplay"],
        details["textOriginal"],
        details["textDisplay"],
        lastMessage["text"],
        lastMessage["message"],
        row["lastMessage"],
      ),
      createdAt: firstString(
        row["createdAt"],
        row["created_at"],
        row["createdTime"],
        row["created_time"],
        row["timestamp"],
        row["publishedAt"],
        content["createdAt"],
        details["publishedAt"],
        timestamp(created["time"]),
        timestamp(row["created_timestamp"]),
        lastMessage["createdAt"],
        lastMessage["createdTime"],
      ),
      parentId: identifier(
        row["parentId"],
        row["parent_id"],
        record(row["parent"])["id"],
        row["parentComment"],
        details["parentId"],
        record(reply["parent"])["uri"],
        record(reference)["id"],
      ),
    }),
    native: isJsonObject(row["native"]) ? row["native"] : row,
  };
}

export function normalizeComment(row: JsonObject): CommentRecord {
  return normalizeRecord(row);
}

export function normalizeMessage(row: JsonObject): MessageRecord {
  return normalizeRecord(row);
}

export function normalizeConversation(row: JsonObject): ConversationRecord {
  return {
    ...normalizeRecord(row),
    ...definedFields({
      updatedAt: firstString(row["updatedAt"], row["updatedTime"], row["updated_time"]),
    }),
  };
}

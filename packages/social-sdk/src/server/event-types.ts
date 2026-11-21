/**
 * Every normalized webhook event type. `SocialEvent["type"]` is derived from this list, so a
 * test can prove each member appears once; a repeated literal in a hand-written union would
 * collapse silently.
 */
export const socialEventTypes = [
  "publication.updated",
  "post.removed",
  "backend-record.deleted",
  "account.updated",
  "message.received",
  /** Zernio: a sent message changed state (`message.sent`, `delivered`, `read`, `failed`, `edited`, `deleted`). */
  "message.updated",
  /** Zernio `reaction.received`, LinkedIn `LIKE`, and Facebook Page `feed.reaction.add`. */
  "reaction.received",
  /** Facebook Page `feed.reaction.remove`: someone took a reaction back. */
  "reaction.removed",
  /** Zernio: a Facebook or Google Business review arrived or changed (`review.new`, `updated`, `deleted`, `restored`). */
  "review.updated",
  "comment.received",
  "mention.received",
  "post.published",
  "comment.updated",
  "comment.removed",
  "post.reshared",
  "message.postback",
  "message.reaction",
  "message.read",
  "message.referral",
  "message.edited",
  "insights.updated",
  /** Zernio: a conversation started or its handover control changed (`conversation.started`, `conversation.control_changed`). */
  "conversation.updated",
  "unknown",
] as const;

export type SocialEventType = (typeof socialEventTypes)[number];

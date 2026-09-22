import type { DeliveryOutcome, PublishResult } from "@opencoredev/social-sdk";

export function renderPublishResult(result: PublishResult): string[] {
  return result.outcomes.map(renderOutcome);
}

function renderOutcome(outcome: DeliveryOutcome): string {
  const target = `${outcome.account.platform}/${outcome.account.accountId}`;

  switch (outcome.state) {
    case "published":
      return `${target}: published (${outcome.post.postId})`;
    case "scheduled":
      return `${target}: scheduled (${outcome.job.jobId})`;
    case "accepted":
      return `${target}: accepted`;
    case "processing":
      return `${target}: processing`;
    case "failed":
      return `${target}: failed (${outcome.code})`;
    case "unknown":
      return `${target}: status unknown (${outcome.reason})`;
    case "cancelled":
      return `${target}: cancelled`;
    case "not-submitted":
      return `${target}: not submitted (${outcome.reason})`;
    default:
      return unreachable(outcome);
  }
}

function unreachable(value: never): never {
  throw new Error(`Unhandled delivery outcome: ${String(value)}`);
}

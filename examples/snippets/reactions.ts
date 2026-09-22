import { connectedAccountRef } from "@opencoredev/social-sdk";
import { xLike, xUnlike } from "@opencoredev/social-sdk/x";
import { bluesky } from "@opencoredev/social-sdk/bluesky";

// Server-only recipe: the caller must authorize these accounts before invoking either function.
export async function changeXReaction(input: {
  accessToken: string;
  userId: string;
  postId: string;
  liked: boolean;
}) {
  const account = connectedAccountRef({
    backend: "direct",
    platform: "x",
    accountId: input.userId,
  });

  const operation = input.liked ? xLike : xUnlike;

  return operation(
    input.postId,
    account,
    { userId: input.userId, accessToken: input.accessToken },
    {
      backendInstance: "direct",
      correlationId: "reaction",
      retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
    },
  );
}

export async function likeBlueskyPost(input: {
  service: string;
  accessJwt: string;
  did: string;
  uri: string;
  cid: string;
}) {
  const adapter = bluesky({
    backend: "direct",
    auth: { service: input.service, accessJwt: input.accessJwt, did: input.did },
  });

  return adapter.native!.likePost({
    account: connectedAccountRef({ backend: "direct", platform: "bluesky", accountId: input.did }),
    post: { uri: input.uri, cid: input.cid },
  });
}

import { it } from "node:test";
import assert from "node:assert/strict";
import { zernioOutcome, postForMeOutcome } from "../src/cloud/outcomes.js";
import type { ConnectedAccountRef } from "../src/core/types.js";

const account: ConnectedAccountRef = {
  kind: "connected-account",
  version: 1,
  backend: "managed",
  platform: "x",
  accountId: "account-a",
};

const context = { account, targetIndex: 0, observedAt: "2026-09-19T00:00:00Z" };

it("maps Zernio per-account outcomes in a partial parent including two accounts on one platform", () => {
  const post = {
    _id: "p1",
    status: "partial",
    platforms: [
      {
        platform: "twitter",
        accountId: "account-a",
        status: "failed",
        errorCategory: "auth_expired",
      },
      {
        platform: "twitter",
        accountId: "account-b",
        status: "published",
        platformPostId: "12345678901234567890",
      },
    ],
  };

  assert.equal(zernioOutcome({ post }, context).state, "failed");

  const successful = zernioOutcome(
    { post },
    { ...context, account: { ...account, accountId: "account-b" } },
  );

  assert.equal(successful.state, "published");

  if (successful.state === "published")
    assert.equal(successful.post.postId, "12345678901234567890");
  assert.equal(zernioOutcome({ existingPost: post }, context).state, "failed");
});

it("does not turn unknown, missing, cancelled or parent-only outcomes into success", () => {
  for (const status of ["new-provider-state", "cancelled", "published"]) {
    assert.equal(
      zernioOutcome(
        {
          post: {
            _id: "p1",
            status: "published",
            platforms: [{ platform: "twitter", accountId: "account-a", status }],
          },
        },
        context,
      ).state,
      "unknown",
    );
  }

  assert.equal(
    zernioOutcome({ post: { _id: "p1", status: "published", platforms: [] } }, context).state,
    "unknown",
  );
});

it("processed Post for Me parent can contain only failures", () => {
  const parent = { id: "p1", status: "processed" };
  assert.equal(
    postForMeOutcome(
      parent,
      { data: [{ post_id: "p1", social_account_id: "account-a", success: false }] },
      context,
    ).state,
    "failed",
  );
  assert.equal(postForMeOutcome(parent, { data: [] }, context).state, "unknown");
  assert.equal(postForMeOutcome(parent, undefined, context).state, "unknown");
  assert.equal(
    postForMeOutcome(
      parent,
      {
        data: [
          {
            post_id: "other-post",
            social_account_id: "account-a",
            success: true,
            platform_data: { id: "native" },
          },
        ],
      },
      context,
    ).state,
    "unknown",
  );
});

it("separates pending video processing from published native evidence", () => {
  assert.equal(
    postForMeOutcome({ id: "p1", status: "processing" }, undefined, context).state,
    "processing",
  );
  assert.equal(
    postForMeOutcome(
      { id: "p1", status: "processed" },
      {
        data: [
          {
            post_id: "p1",
            social_account_id: "account-a",
            success: true,
            platform_data: { id: "native" },
          },
        ],
      },
      context,
    ).state,
    "published",
  );
});

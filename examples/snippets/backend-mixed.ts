import { createSocial, type ConnectedAccountRef } from "@opencoredev/social-sdk";
import { postfast } from "@opencoredev/social-sdk/cloud/postfast";
import { zernio } from "@opencoredev/social-sdk/cloud/zernio";

/** Register two hosted backends side by side. The keys become each account's `backend`. */
export function createMixedSocial(keys: { zernioApiKey: string; postfastApiKey: string }) {
  return createSocial({
    backends: {
      zernio: zernio({ apiKey: keys.zernioApiKey }),
      postfast: postfast({ apiKey: keys.postfastApiKey }),
    },
  });
}

export type MixedSocial = ReturnType<typeof createMixedSocial>;

/** List accounts per backend, then schedule one post to an account on each. */
export async function scheduleOnBoth(
  social: MixedSocial,
  accounts: { zernioX: ConnectedAccountRef; postfastLinkedIn: ConnectedAccountRef },
  tenantId: string,
  at: string,
) {
  const authorization = { tenantId };
  const zernioAccounts = await social.accounts.list({ backend: "zernio", authorization });
  const postfastAccounts = await social.accounts.list({ backend: "postfast", authorization });

  const result = await social.posts.publish(
    {
      targets: [{ account: accounts.zernioX }, { account: accounts.postfastLinkedIn }],
      content: { text: "Registration for the spring cohort is open." },
      schedule: { at },
    },
    { authorization },
  );

  return {
    accounts: [...zernioAccounts.items, ...postfastAccounts.items],
    outcomes: result.outcomes,
  };
}

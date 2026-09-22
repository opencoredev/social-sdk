import type { OAuthSession } from "@atproto/oauth-client-node";
import { bluesky } from "@opencoredev/social-sdk/bluesky";

/** Build the SDK adapter from a restored OAuthSession without extracting or fabricating JWTs. */
export function blueskyFromOAuthSession(input: {
  readonly session: OAuthSession;
  readonly service: string;
  readonly backend?: string;
}) {
  if (input.backend === undefined)
    return bluesky({
      auth: { service: input.service, did: input.session.did },
      session: input.session,
    });

  return bluesky({
    backend: input.backend,
    auth: { service: input.service, did: input.session.did },
    session: input.session,
  });
}

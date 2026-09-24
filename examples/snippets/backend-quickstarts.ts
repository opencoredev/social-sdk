import { createSocial } from "@opencoredev/social-sdk";
import { bluesky } from "@opencoredev/social-sdk/bluesky";
import { postForMe } from "@opencoredev/social-sdk/cloud/post-for-me";
import { postfast } from "@opencoredev/social-sdk/cloud/postfast";
import { zernio } from "@opencoredev/social-sdk/cloud/zernio";

/** Call on your server with secrets from your environment or credential store. */
export function backendQuickstarts(credentials: {
  bluesky: { service: string; did: string; accessJwt: string };
  zernioApiKey: string;
  postForMeApiKey: string;
  postfastApiKey: string;
}) {
  return {
    directBluesky: createSocial({ backend: bluesky({ auth: credentials.bluesky }) }),
    managedZernio: createSocial({ backend: zernio({ apiKey: credentials.zernioApiKey }) }),
    managedPostForMe: createSocial({ backend: postForMe({ apiKey: credentials.postForMeApiKey }) }),
    managedPostFast: createSocial({ backend: postfast({ apiKey: credentials.postfastApiKey }) }),
  };
}

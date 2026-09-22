import { createSocial } from "@opencoredev/social-sdk";
import { mockBackend } from "@opencoredev/social-sdk/testing";

const social = createSocial({ backend: mockBackend() });

const metrics = await social.analytics.getPostMetrics({
  kind: "platform-post",
  version: 1,
  backend: "default",
  platform: "x",
  accountId: "mock-account-1",
  postId: "post-1",
});

for (const metric of metrics) console.log(metric.name, metric.value, metric.unit);

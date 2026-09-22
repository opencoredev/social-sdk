import {
  connectedAccountRef,
  createSocial,
  type ConnectedAccountRef,
  type PublishOptionsFor,
} from "../src/index.js";
import { mockBackend } from "../src/testing/index.js";

const x: ConnectedAccountRef<"x"> = connectedAccountRef({
  backend: "default",
  platform: "x",
  accountId: "x-1",
});

const options: PublishOptionsFor<"youtube"> = {
  title: "A video",
  visibility: "private",
  madeForKids: false,
};

const social = createSocial({ backend: mockBackend() });

void social.posts.prepare({
  targets: [{ account: x, options: { replySettings: "everyone" } }],
  content: { text: "hello" },
});

void options;

// @ts-expect-error Platform-specific options must not be assigned across platforms.
const invalid: PublishOptionsFor<"youtube"> = { replySettings: "everyone" };

void invalid;

social.posts.prepare({
  // @ts-expect-error An X destination cannot receive YouTube options through prepare.
  targets: [{ account: x, options: { title: "Wrong", visibility: "private", madeForKids: false } }],
  content: { text: "Hello" },
});

void social.posts.publish({
  // @ts-expect-error The same platform relationship is enforced for publish.
  targets: [{ account: x, options: { languages: ["en"] } }],
  content: { text: "Hello" },
});

const youtube = connectedAccountRef({
  backend: "default",
  platform: "youtube",
  accountId: "channel",
});

social.posts.prepare({
  targets: [
    { account: x, options: { replySettings: "following" } },
    { account: youtube, options },
  ],
  content: { text: "Different destination options" },
});

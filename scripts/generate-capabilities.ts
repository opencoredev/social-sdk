/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createDiagnosticAdapter, runCli } from "../packages/social-sdk/dist/cli.js";

async function command(args: string[]) {
  let output = "";

  const exit = await runCli([...args, "--json"], {
    env: {},
    readInput: async () => "",
    write: (text) => {
      output += text;
    },
  });

  if (exit !== 0) throw new Error("Offline manifest generation failed");

  return JSON.parse(output).data;
}

const adapters: string[] = (await command(["adapters"])).adapters;

const manifests = [];

// oxlint-disable-next-line anti-slop/no-known-value-widening -- validated boundary or fixture contract.
const implementationPaths: Record<string, readonly string[]> = {
  "accounts.read": ["accounts.list", "accounts.get"],
  "posts.publish": ["posts.prepareTarget", "posts.publishTarget"],
  "posts.read": ["posts.get"],
  "posts.list": ["posts.list"],
  "posts.status": ["posts.getDelivery"],
  "posts.cancelScheduled": ["posts.cancelScheduled"],
  "posts.deleteBackendRecord": ["posts.deleteBackendRecord"],
  "posts.removeFromPlatform": ["posts.removeFromPlatform"],
  "media.upload": ["media.upload"],
  "analytics.read": ["analytics.getPostMetrics"],
  "analytics.account.read": ["analytics.getAccountMetrics"],
  "comments.read": ["comments.list"],
  "comments.write": ["comments.reply"],
  "messages.write": ["messages.send"],
  "webhooks.verify": ["webhooks.verify", "webhooks.decode"],
  "posts.publish.video": ["posts.publishTarget"],
  "posts.repost": ["native.repostPost|native.repost"],
  "posts.quote": ["native.quotePost|native.quote"],
  "posts.delete": ["native.deletePost|native.deleteVideo"],
  "graph.follow": ["native.follow"],
  "graph.block": ["native.block"],
  "graph.mute": ["native.mute"],
  "notifications.read": ["native.listNotifications"],
  "notifications.seen": ["native.markNotificationsSeen"],
  "profile.read": ["native.getProfile"],
  "profile.update": ["native.updateProfile"],
  "feeds.read": ["native.listFeeds"],
  "chat.read": ["native.listConversations", "native.listMessages"],
  "chat.write": ["native.sendMessage"],
  "polls.create": ["native.createPoll"],
  "bookmarks.read": ["native.bookmarks"],
  "bookmarks.write": ["native.bookmark", "native.removeBookmark"],
  "follows.write": ["native.follow", "native.unfollow"],
  "media.video": ["native.uploadVideo"],
  "media.gif": ["native.uploadGif"],
  "messages.read": [
    "messages.listConversations|native.listDirectMessages|native.listConversations",
  ],
  "streams.read": ["native.stream"],
  "search.keyword": ["native.search"],
  "mentions.read": ["native.mentions"],
  "posts.draft": ["native.uploadDraft"],
  "posts.status.poll": ["native.publishStatus"],
  "reels.publish": ["native.publishReel"],
  "stories.publish": ["native.publishStory"],
  "hashtags.search": ["native.hashtagSearch"],
  "publishing.limit.read": ["native.publishingLimit"],
  "product.tagging": ["native.publishReel"],
  "thumbnails.write": ["native.setThumbnail"],
  "captions.read": ["native.captions"],
  "captions.write": ["native.captions"],
  "playlists.read": ["native.playlists"],
  "playlists.write": ["native.playlists"],
  "posts.schedule": ["posts.publishTarget"],
  "posts.update": ["native.updateVideo|native.updatePost"],
  "analytics.youtube.read": ["native.analytics"],
  "live.broadcasts": ["native.liveBroadcasts"],
  "posts.multi-image": ["native.createPoll"],
  "posts.video": ["native.registerVideo"],
  "posts.document": ["native.registerVideo"],
  "reactions.write": ["native.react"],
  "reshares.write": ["native.reshare"],
  "analytics.organization.read": ["native.organizationAnalytics"],
  "articles.create": ["native.updatePost"],
};

const cell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");

const rows = [];

for (const adapter of adapters) {
  const { manifest } = await command(["capabilities", "--adapter", adapter]);
  manifests.push({ adapter, manifest });

  const instance = createDiagnosticAdapter(
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
    adapter as Parameters<typeof createDiagnosticAdapter>[0],
  );

  for (const declaration of manifest.capabilities) {
    if (declaration.availability !== "available") continue;
    const paths = implementationPaths[declaration.operation];

    if (!paths)
      throw new Error(`No conformance mapping for available operation ${declaration.operation}`);

    for (const path of paths) {
      const found = path.split("|").some((candidate) => {
        let value: unknown = instance;

        for (const key of candidate.split("."))
          value =
            // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
            value && typeof value === "object"
              ? // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
                // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated boundary or fixture contract.
                // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- provider payload is validated at this adapter boundary.
                // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated external boundary or fixture contract.
                // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
                // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated external boundary or fixture contract.
                // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
                // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated external boundary or fixture contract.
                (value as Record<string, unknown>)[key]
              : undefined;

        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
        return typeof value === "function";
      });

      if (!found)
        throw new Error(
          `Adapter ${adapter} advertises ${declaration.operation} but has no ${path} method`,
        );
    }
  }

  for (const entry of manifest.capabilities)
    rows.push(
      `| ${cell(adapter)} | ${cell(entry.platform ?? "*")} | ${cell(entry.operation)} | ${cell(entry.availability)} | ${cell((entry.formats ?? []).join(", ") || "None declared")} | ${cell((entry.requiredScopes ?? []).join(", ") || "See adapter setup")} |`,
    );
}

const markdown = `---
title: Capability matrix
description: Read generated operation declarations for installed Social SDK adapters, including formats, backend routes, and scope guidance.
---

This table is generated from the same manifests used by local preparation and the diagnostic CLI. An available declaration describes an implemented route. It does not certify credentials, product approval, account eligibility or a successful live request. Read the platform/backend guide before enabling the operation. No adapter has live verification in this checkout.

An omitted operation is unsupported through the normalized API. Some operations need several permissions, and token/product restrictions can differ between member and organization accounts. The setup guide and current provider documentation determine the permissions for your account.

| Backend | Platform | Operation | Declaration | Formats | Scope guidance |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

Generate this page with \`bun scripts/generate-capabilities.ts\`. CI uses \`--check\` to detect drift. The complete manifests, including API revisions, runtimes and notes, are returned by \`social-sdk capabilities --adapter NAME --json\`.
`;

const files = new Map([
  ["apps/docs/docs/reference/capabilities.mdx", markdown],
  ["planning/evidence/capability-manifests.json", JSON.stringify(manifests, null, 2) + "\n"],
]);

for (const [path, content] of files) {
  if (process.argv.includes("--check")) {
    let existing: string;

    try {
      existing = await readFile(path, "utf8");
    } catch (error) {
      if (path.startsWith("planning/")) {
        console.log(`Skipping ${path}: the untracked planning folder is absent here.`);
        continue;
      }

      throw error;
    }

    if (existing !== content) throw new Error(`Generated capability data is stale: ${path}`);
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

console.log(
  `Capability ${process.argv.includes("--check") ? "check" : "generation"} passed (${rows.length} declarations).`,
);

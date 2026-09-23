import type { ComponentMarkdown } from "blume";

/** Display names for <PlatformTab platform="...">, shared by the page and Markdown output. */
export const PLATFORM_NAMES = {
  x: "X",
  bluesky: "Bluesky",
  threads: "Threads",
  instagram: "Instagram",
  youtube: "YouTube",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  zernio: "Zernio",
} as const;

export type PlatformKey = keyof typeof PLATFORM_NAMES;

const PLATFORM_LABELS: ReadonlyMap<unknown, string> = new Map(Object.entries(PLATFORM_NAMES));

const platformLabel = (props: {
  readonly title?: unknown;
  readonly platform?: unknown;
}): string => {
  if (props.title) return String(props.title);

  return PLATFORM_LABELS.get(props.platform) ?? "Platform";
};

/**
 * Markdown for agents (`<route>.md`, `Accept: text/markdown`, llms-full.txt):
 * every tab becomes a `### <Platform>` section with its prose and code intact.
 */
export const platformTabsMarkdown: ComponentMarkdown = ({ childComponents, children }) => {
  const tabs = childComponents("PlatformTab");

  if (tabs.length === 0) return children;

  return tabs
    .map((tab) => [`### ${platformLabel(tab.props)}`, tab.children].filter(Boolean).join("\n\n"))
    .join("\n\n");
};

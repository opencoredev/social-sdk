import { defineConfig } from "blume";

import { posthogScript } from "./analytics";

export default defineConfig({
  title: "Social SDK",
  description:
    "Typed social platform integrations for TypeScript applications, with direct routes, optional managed backends, and deterministic testing.",
  logo: {
    image: {
      light: "/brand/social-sdk-mark.svg",
      dark: "/brand/social-sdk-mark-cream.svg",
      alt: "Social SDK megaphone mark",
    },
    text: "Social SDK",
    href: "/docs",
  },
  basePath: "/docs",
  feedback: false,
  redirects: [
    { from: "/analytics", to: "/reads#post-metrics", status: 301 },
    { from: "/messaging", to: "/comments#messages", status: 301 },
    { from: "/overview", to: "/", status: 301 },
    { from: "/backends/direct", to: "/backends", status: 301 },
    { from: "/backends/managed", to: "/backends", status: 301 },
  ],
  content: {
    root: "docs",
    pages: "pages",
  },
  navigation: {
    sidebar: {
      display: "group",
      items: [
        { label: "Overview", root: "/", icon: "home" },
        { label: "Install", root: "/getting-started/installation", icon: "package" },
        { label: "Quickstart", root: "/getting-started/mock-quickstart", icon: "rocket" },
        {
          label: "Platforms",
          icon: "globe-2",
          collapsed: false,
          items: [
            { label: "Compare platforms", root: "/platforms", icon: "table-2" },
            { label: "X", root: "/platforms/x", icon: "/integrations/x.svg" },
            { label: "Threads", root: "/platforms/threads", icon: "/integrations/threads.svg" },
            { label: "Bluesky", root: "/platforms/bluesky", icon: "/integrations/bluesky.svg" },
            { label: "YouTube", root: "/platforms/youtube", icon: "/integrations/youtube.svg" },
            { label: "TikTok", root: "/platforms/tiktok", icon: "/integrations/tiktok.svg" },
            {
              label: "Instagram",
              root: "/platforms/instagram",
              icon: "/integrations/instagram.svg",
            },
            { label: "LinkedIn", root: "/platforms/linkedin", icon: "/integrations/linkedin.svg" },
            {
              label: "Hosted platforms",
              icon: "server",
              collapsed: true,
              items: [
                { label: "Overview", root: "/backends" },
                { label: "Zernio", root: "/backends/zernio", icon: "/integrations/zernio.svg" },
                {
                  label: "Post for Me",
                  root: "/backends/post-for-me",
                  icon: "/integrations/post-for-me.png",
                },
              ],
            },
          ],
        },
        {
          label: "Integrations",
          root: "/integrations",
          icon: "blocks",
          collapsed: false,
          items: [
            { label: "All integrations", root: "/integrations", icon: "layout-grid" },
            { label: "Next.js", root: "/integrations/nextjs", icon: "/integrations/nextjs.svg" },
            { label: "Convex", root: "/integrations/convex", icon: "/integrations/convex.svg" },
            {
              label: "Supabase",
              root: "/integrations/supabase",
              icon: "/integrations/supabase.svg",
            },
            { label: "Neon", root: "/integrations/neon", icon: "/integrations/neon.svg" },
            { label: "Express", root: "/integrations/express", icon: "/integrations/express.svg" },
            { label: "Hono", root: "/integrations/hono", icon: "/integrations/hono.svg" },
            { label: "NestJS", root: "/integrations/nestjs", icon: "/integrations/nestjs.svg" },
            {
              label: "TanStack Start",
              root: "/integrations/tanstack-start",
              icon: "/integrations/tanstack.svg",
            },
            {
              label: "Trigger.dev",
              root: "/integrations/trigger-dev",
              icon: "/integrations/trigger-dev.png",
            },
            { label: "Inngest", root: "/integrations/inngest", icon: "/integrations/inngest.svg" },
            { label: "Restate", root: "/integrations/restate", icon: "/integrations/restate.svg" },
          ],
        },
        {
          label: "Guides",
          icon: "book-open",
          items: [
            { label: "Connect accounts", root: "/authentication", icon: "key-round" },
            { label: "Publish content", root: "/publishing", icon: "send" },
            { label: "Read posts and analytics", root: "/reads", icon: "chart-no-axes-combined" },
            { label: "Handle comments and messages", root: "/comments", icon: "message-circle" },
            { label: "Process webhooks", root: "/events", icon: "webhook" },
            {
              label: "Mount in your framework",
              root: "/getting-started/framework-recipes",
              icon: "puzzle",
            },
            { label: "Integrate with an agent", root: "/agents/integrate-social-sdk", icon: "bot" },
            {
              label: "Integration checklist",
              root: "/agents/integration-checklist",
              icon: "list-checks",
            },
          ],
        },
        {
          label: "Concepts",
          icon: "shapes",
          items: [
            { label: "Model", root: "/concepts/integration-model", icon: "boxes" },
            { label: "Architecture", root: "/concepts/architecture", icon: "network" },
            { label: "Accounts", root: "/concepts/accounts", icon: "users" },
            {
              label: "Authorization",
              root: "/concepts/tenant-authorization",
              icon: "shield-check",
            },
            { label: "Outcomes", root: "/concepts/references-and-outcomes", icon: "flag" },
            { label: "Capabilities", root: "/concepts/capabilities", icon: "badge-check" },
            { label: "Content", root: "/concepts/content", icon: "file-text" },
            { label: "Media", root: "/concepts/media", icon: "image" },
            { label: "Idempotency", root: "/concepts/idempotency", icon: "repeat-2" },
            { label: "Native access", root: "/concepts/native-access", icon: "plug-2" },
          ],
        },
        {
          label: "Reference",
          icon: "library",
          items: [
            { label: "API overview", root: "/reference", icon: "book-open" },
            { label: "Capabilities", root: "/reference/capabilities", icon: "list-checks" },
            { label: "Pagination", root: "/reference/pagination", icon: "arrow-left-right" },
            { label: "CLI", root: "/reference/cli", icon: "terminal" },
            { label: "Errors", root: "/reference/errors", icon: "triangle-alert" },
            { label: "Security", root: "/reference/security", icon: "shield" },
            { label: "Operations", root: "/operations", icon: "activity" },
            { label: "Evidence levels", root: "/testing/evidence-levels", icon: "badge-check" },
            { label: "Contributing", root: "/contributing", icon: "git-pull-request" },
            { label: "FAQ", root: "/reference/faq", icon: "circle-help" },
          ],
        },
      ],
    },
  },
  theme: {
    accent: { light: "#1c1a17", dark: "#fafafa" },
    mode: "system",
    radius: "md",
    fonts: {
      display: "geist",
      body: "geist",
      mono: "geist-mono",
    },
  },
  seo: {
    x: { handle: "@leodev" },
  },
  ai: {
    llmsTxt: true,
    mcp: {
      enabled: false,
    },
  },
  analytics: {
    // Loaded as a custom script instead of `analytics.posthog` so the init
    // options (exceptions, replay masking, URL stripping) are ours to set.
    scripts: [{ content: posthogScript }],
  },
  deployment: {
    output: "static",
  },
});

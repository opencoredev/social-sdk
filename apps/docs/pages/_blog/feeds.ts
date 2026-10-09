// Blume only routes .astro files from pages/, so the blog's XML endpoints are
// added through an Astro integration instead.
import type { AstroIntegration } from "astro";

export const blogFeeds: AstroIntegration = {
  name: "social-sdk-blog-feeds",
  hooks: {
    "astro:config:setup": ({ injectRoute }) => {
      injectRoute({
        pattern: "/blog/rss.xml",
        entrypoint: new URL("./rss.xml.ts", import.meta.url),
      });
      injectRoute({
        pattern: "/blog/sitemap.xml",
        entrypoint: new URL("./sitemap.xml.ts", import.meta.url),
      });
    },
  },
};

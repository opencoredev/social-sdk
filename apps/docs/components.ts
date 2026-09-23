import { defineComponents } from "blume";
import PlatformTab from "./components/PlatformTab.astro";
import PlatformTabs from "./components/PlatformTabs.astro";

export default defineComponents({
  mdx: {
    PlatformTab,
    PlatformTabs,
  },
});

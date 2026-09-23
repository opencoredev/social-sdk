// Inline script that loads web fonts after the first paint, then adds `className`
// to <html> so CSS can switch from the metric-matched fallbacks. Used by the
// hand-drawn pages and, through the post-build script, by the Blume docs pages.
//
// Fonts start downloading once the browser reports the first contentful paint.
// A requestAnimationFrame callback can run before that paint on a small page, so
// it isn't enough. Browsers without paint timing wait for the load event. All
// fonts are awaited together so the page swaps once. Returning visitors already
// have the fonts cached, so they get the class straight away. A failed load
// still swaps for this visit but isn't remembered, so the next visit waits
// again. Astro's client router resets <html> attributes on each navigation, so
// the class is re-added after every swap.
export const fontLoader = (className: string, fonts: string[]) => `(() => {
  const root = document.documentElement;
  let loaded = false;
  const apply = () => {
    loaded = true;
    root.classList.add(${JSON.stringify(className)});
  };
  const ready = () => {
    apply();
    try { localStorage.setItem(${JSON.stringify(className)}, "1"); } catch {}
  };
  document.addEventListener("astro:after-swap", () => loaded && root.classList.add(${JSON.stringify(className)}));
  try { if (localStorage.getItem(${JSON.stringify(className)})) return ready(); } catch {}
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    setTimeout(() => {
      const faces = ${JSON.stringify(fonts)}.map((font) => document.fonts.load(font));
      Promise.all(faces).then(ready, apply);
    });
  };
  setTimeout(start, 3000);
  if (!self.PerformanceObserver?.supportedEntryTypes?.includes("paint")) return addEventListener("load", start);
  new PerformanceObserver((list) => {
    if (list.getEntriesByName("first-contentful-paint").length) start();
  }).observe({ type: "paint", buffered: true });
})();`;

// HTML escaping for markup the tool page scripts build. It matches escapeHtml in
// _blog/render.ts; a separate copy keeps that module's page shell out of the
// browser bundles.

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Static fixture server. `?cr-attr=theme&cr-value=g100` sets the attribute
 * on `<html>` before first paint (WebView has no init scripts).
 */
import path from "node:path";

const HEAD_OPEN_RE = /<head[^>]*>/i;

export function serveFixtures(dir: string): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const file = Bun.file(path.join(dir, decodeURIComponent(u.pathname)));
      if (!(await file.exists()))
        return new Response("not found", { status: 404 });
      const attr = u.searchParams.get("cr-attr");
      if (!attr || !u.pathname.endsWith(".html")) return new Response(file);
      const value = u.searchParams.get("cr-value") ?? "";
      const script = `<script>document.documentElement.setAttribute(${JSON.stringify(attr)},${JSON.stringify(value)})</script>`;
      const html = (await file.text()).replace(HEAD_OPEN_RE, (m) => m + script);
      return new Response(html, { headers: { "content-type": "text/html" } });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
  };
}

/** Every fixture in every theme, with its URL. */
export function themedPages(
  baseUrl: string,
  fixtures: string[],
  themes: string[],
): { name: string; theme: string; url: string }[] {
  return fixtures.flatMap((name) =>
    themes.map((theme) => ({
      name,
      theme,
      url: `${baseUrl}/${name}.html?cr-attr=theme&cr-value=${encodeURIComponent(theme)}`,
    })),
  );
}

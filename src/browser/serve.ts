import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const HEAD_OPEN_RE = /<head[^>]*>/i;

export interface ServeOptions {
  /**
   * Serves `css` in place of the library stylesheet: of the `.css` files
   * under `dir`, the largest that contains `marker`, replaced whole.
   */
  swap?: { marker: string; css: string };
}

function cssFiles(dir: string, at = ""): string[] {
  return readdirSync(path.join(dir, at), { withFileTypes: true }).flatMap(
    (e) => {
      const rel = path.join(at, e.name);
      if (e.isDirectory()) return cssFiles(dir, rel);
      return e.name.endsWith(".css") ? [rel] : [];
    },
  );
}

/** The fixture file `swap` replaces, relative to `dir`. */
export function swappedSheet(dir: string, marker: string): string {
  // As `librarySheet` picks it in the page. Largest first: only those
  // before the first match are read.
  const files = cssFiles(dir)
    .map((file) => ({ file, size: statSync(path.join(dir, file)).size }))
    .sort((a, b) => b.size - a.size);
  for (const { file } of files)
    if (readFileSync(path.join(dir, file), "utf8").includes(marker))
      return file;
  throw new Error(`no .css file under ${dir} contains ${marker}`);
}

/**
 * Serves `dir`. `?cr-attr=theme&cr-value=g100` sets that attribute on
 * `<html>` before first paint (WebView has no init scripts).
 */
export function serveFixtures(
  dir: string,
  options: ServeOptions = {},
): { url: string; stop: () => void } {
  const swapped = options.swap && {
    path: `/${swappedSheet(dir, options.swap.marker).split(path.sep).join("/")}`,
    css: options.swap.css,
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const pathname = decodeURIComponent(u.pathname);
      if (pathname === swapped?.path)
        return new Response(swapped.css, {
          headers: { "content-type": "text/css" },
        });
      const file = Bun.file(path.join(dir, pathname));
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

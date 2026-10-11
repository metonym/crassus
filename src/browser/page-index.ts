// Each fixture page's element tree (tags, attributes, structure; no text),
// recorded once per fixture build, so `compare` can tell which pages a
// stylesheet change can reach before loading any: the changed rules'
// selectors run against the tree in the engine itself.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { MATCH_SELECTORS } from "./page-helpers";
import { serveFixtures } from "./serve";
import {
  type PageJob,
  View,
  type VisitOptions,
  viewportsOf,
  visitPages,
} from "./view";

// Bump when the recorded shape changes.
const INDEX_VERSION = 1;

/** `[localName, attributes, children, namespace?]`; namespace when not HTML. */
type Skeleton = [string, Record<string, string>, Skeleton[], string?];

export interface PageIndex {
  /** By `PageJob.label`. */
  pages: Record<string, { skeleton: Skeleton; ready: boolean }>;
}

// <head>'s children can't be styled into <body>: kept as an empty <head>.
const SKELETON = `(() => {
  const HTML = "http://www.w3.org/1999/xhtml";
  const walk = (el) => {
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    const node = [el.localName, attrs, Array.from(el.children, walk)];
    if (el.namespaceURI !== HTML) node.push(el.namespaceURI);
    return node;
  };
  const html = walk(document.documentElement);
  html[2] = [["head", {}, []], walk(document.body)];
  return html;
})()`;

/** A bundler's content hash in an asset name: Vite's `mount-CYiQnMsr.css`. */
const ASSET_HASH_RE = /-[\w-]{8}(?=\.(?:css|js|mjs)\b)/g;
const GZ_RE = /\.json\.gz$/;
const TEXT_RE = /\.(?:html?|m?js|json|svg)$/;

/**
 * What the page index depends on: how pages load, and the fixture files
 * but stylesheets (it records only the DOM). Asset hashes are dropped, as
 * a CSS edit renames the sheet and changes every file that names it.
 */
function indexInputs(opts: IndexOptions): IndexInputs {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) walk(file);
      else if (!file.endsWith(".css")) files.push(file);
    }
  };
  walk(opts.dir);
  const normal = (text: string) => text.replace(ASSET_HASH_RE, "-#");
  const digest = (file: string) =>
    new Bun.CryptoHasher("sha256")
      .update(
        TEXT_RE.test(file)
          ? normal(readFileSync(file, "utf8"))
          : readFileSync(file),
      )
      .digest("hex")
      .slice(0, 16);
  return {
    options: JSON.stringify([
      INDEX_VERSION,
      opts.fixtures,
      opts.themes,
      opts.themeAttribute ?? "theme",
      viewportsOf(opts),
      opts.engine,
      opts.emulate,
      opts.readySelector ?? null,
      opts.settleMs ?? 500,
    ]),
    // By name, then content: two chunks can share a name once hashes go
    // (`form-reset-#.js`), and their real names mustn't order them.
    files: files
      .map((f): [string, string] => [
        normal(path.relative(opts.dir, f)),
        digest(f),
      ])
      .sort(([a, x], [b, y]) =>
        a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0,
      ),
  };
}

const indexKey = (inputs: IndexInputs) =>
  new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(inputs))
    .digest("hex")
    .slice(0, 16);

/** What changed since the index last written to `dir`, for a rebuild. */
function rebuiltBecause(dir: string, now: IndexInputs): string {
  const last = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".inputs.json"))
        .map((f) => path.join(dir, f))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
    : undefined;
  if (!last) return "no index cached yet";
  const before: IndexInputs = JSON.parse(readFileSync(last, "utf8"));
  if (before.options !== now.options) return "the run's options changed";
  const count = (l: [string, string][]) => {
    const m = new Map<string, number>();
    for (const [name, d] of l) {
      const k = `${name}\0${d}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const [a, b] = [count(before.files), count(now.files)];
  const changed = new Set<string>();
  for (const k of new Set([...a.keys(), ...b.keys()]))
    if ((a.get(k) ?? 0) !== (b.get(k) ?? 0)) changed.add(k.split("\0")[0]);
  const names = [...changed].sort();
  return names.length
    ? `fixture files changed: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`
    : "an index with these inputs was removed";
}

interface IndexInputs {
  options: string;
  /** Normalized name and content digest per file, stylesheets aside. */
  files: [string, string][];
}

export interface IndexOptions extends Omit<VisitOptions, "baseUrl"> {
  dir: string;
  sheetMarker: string;
  settleMs?: number;
  /** Where to keep the index between runs. Without it, it's rebuilt. */
  cacheDir?: string;
}

/**
 * The page index of `dir`: read from `cacheDir` when the fixtures haven't
 * changed, else recorded by loading every page as `capture` does (with the
 * fixtures' own stylesheet) and written there.
 */
export async function pageIndex(opts: IndexOptions): Promise<{
  index: PageIndex;
  cached: boolean;
  ms: number;
  /** Why it was rebuilt, with a `cacheDir`. */
  why?: string;
}> {
  const started = performance.now();
  const inputs = opts.cacheDir ? indexInputs(opts) : undefined;
  const file =
    opts.cacheDir &&
    inputs &&
    path.join(opts.cacheDir, `pages-${indexKey(inputs)}.json.gz`);
  if (file && existsSync(file)) {
    const index: PageIndex = JSON.parse(
      new TextDecoder().decode(Bun.gunzipSync(await Bun.file(file).bytes())),
    );
    return { index, cached: true, ms: performance.now() - started };
  }
  const why =
    opts.cacheDir && inputs ? rebuiltBecause(opts.cacheDir, inputs) : undefined;
  const server = serveFixtures(opts.dir);
  const index: PageIndex = { pages: {} };
  try {
    const r = await visitPages(
      { ...opts, baseUrl: server.url },
      async (view, job) => {
        await Bun.sleep(opts.settleMs ?? 500);
        index.pages[job.label] = {
          skeleton: await view.evaluate<Skeleton>(SKELETON),
          ready: true,
        };
      },
    );
    for (const label of r.notReady) index.pages[label].ready = false;
  } finally {
    server.stop();
  }
  if (file) {
    await mkdir(path.dirname(file), { recursive: true });
    await Bun.write(file, Bun.gzipSync(JSON.stringify(index)));
    await Bun.write(
      file.replace(GZ_RE, ".inputs.json"),
      JSON.stringify(inputs),
    );
  }
  return {
    index,
    cached: false,
    ms: performance.now() - started,
    ...(why && { why }),
  };
}

/** Page function `(skeleton, doc)`: builds it as `doc`'s root, and returns that. */
export const BUILD = `(tree, doc) => {
  const make = ([name, attrs, children, ns]) => {
    const el = ns ? doc.createElementNS(ns, name) : doc.createElement(name);
    for (const [k, v] of Object.entries(attrs)) { try { el.setAttribute(k, v); } catch {} }
    for (const c of children) el.append(make(c));
    return el;
  };
  const root = make(tree);
  doc.replaceChild(root, doc.documentElement);
  return root;
}`;

// Rebuilds a skeleton in an inert document and runs the selectors on it.
const MATCH = `((pages, selectors) => pages.map((skeleton) => {
  const doc = document.implementation.createHTMLDocument("");
  (${BUILD})(skeleton, doc);
  const { hits, all, els } = (${MATCH_SELECTORS})(doc, selectors);
  return { hits, all, elements: els.size };
}))`;

export interface PageMatch {
  /** Indexes of the selectors that match on the page. */
  hits: number[];
  /** A selector matched `<html>` or `<body>`, or the engine rejected one. */
  all: boolean;
  /** Elements in `<body>` they match. */
  elements: number;
}

/** Runs `selectors` on every indexed page, in a view of the engine that will capture them. */
export async function matchPages(
  index: PageIndex,
  jobs: PageJob[],
  selectors: string[],
  opts: Pick<VisitOptions, "engine" | "chromePath">,
): Promise<Map<string, PageMatch>> {
  const view = new View({ engine: opts.engine, chromePath: opts.chromePath });
  const out = new Map<string, PageMatch>();
  try {
    await view.navigate("about:blank");
    // A few pages per call keeps each message small.
    for (let i = 0; i < jobs.length; i += 16) {
      const batch = jobs.slice(i, i + 16).filter((j) => {
        if (index.pages[j.label]) return true;
        // Not indexed: it may match anything.
        out.set(j.label, {
          hits: selectors.map((_, k) => k),
          all: true,
          elements: 0,
        });
        return false;
      });
      if (batch.length === 0) continue;
      // biome-ignore lint/performance/noAwaitInLoops: one view
      const r = await view.evaluate<PageMatch[]>(
        `${MATCH}(${JSON.stringify(batch.map((j) => index.pages[j.label].skeleton))}, ${JSON.stringify(selectors)})`,
      );
      batch.forEach((job, k) => {
        out.set(job.label, r[k]);
      });
    }
  } finally {
    view.close();
  }
  return out;
}

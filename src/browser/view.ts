import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type EngineName = "chrome" | "webkit";

export interface ViewOptions {
  engine: EngineName;
  width?: number;
  height?: number;
  /**
   * Chrome/Chromium binary. Default: Playwright's newest
   * `chrome-headless-shell`, if installed, else Bun's auto-detection.
   */
  chromePath?: string;
}

const HEADLESS_SHELL_RE = /^chromium_headless_shell-(\d+)$/;

function playwrightCache(): string | undefined {
  const env = process.env.PLAYWRIGHT_BROWSERS_PATH;
  // "0" means browsers live in node_modules, per project.
  if (env && env !== "0") return env;
  if (process.platform === "darwin")
    return join(homedir(), "Library/Caches/ms-playwright");
  if (process.platform === "win32")
    return process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "ms-playwright")
      : undefined;
  return join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
    "ms-playwright",
  );
}

/**
 * Playwright's newest cached `chrome-headless-shell`. Bun prefers an
 * installed Chrome, which starts the user's browser helpers beside their own
 * windows; the shell is lighter and gives the exact viewport.
 */
export function headlessShell(): string | undefined {
  const cache = playwrightCache();
  if (!cache || !existsSync(cache)) return undefined;
  const exe = process.platform === "win32" ? ".exe" : "";
  const revisions = readdirSync(cache)
    .map((d) => [d, Number(HEADLESS_SHELL_RE.exec(d)?.[1] ?? -1)] as const)
    .filter(([, rev]) => rev >= 0)
    .sort((a, b) => b[1] - a[1]);
  for (const [dir] of revisions) {
    const root = join(cache, dir);
    for (const sub of readdirSync(root)) {
      const bin = join(root, sub, `chrome-headless-shell${exe}`);
      if (sub.startsWith("chrome-headless-shell-") && existsSync(bin))
        return bin;
    }
  }
  return undefined;
}

let defaultChrome: { path?: string } | undefined;
const defaultChromePath = () => {
  defaultChrome ??= { path: headlessShell() };
  return defaultChrome.path;
};

export interface Viewport {
  width: number;
  height: number;
}

const viewportOf = (o: { width?: number; height?: number }): Viewport => ({
  width: o.width ?? 1280,
  height: o.height ?? 900,
});

export const viewportName = (v: Viewport) => `${v.width}x${v.height}`;

export const viewportsOf = (opts: {
  viewports?: Viewport[];
  width?: number;
  height?: number;
}): Viewport[] =>
  opts.viewports?.length ? opts.viewports : [viewportOf(opts)];

export class View {
  readonly engine: EngineName;
  #view: Bun.WebView;
  // Null on Chrome until `resize`: its window size includes its own UI (1280 ×
  // 900 is a 1280 × 813 page in new headless).
  #size: Viewport | null;
  #queue: Promise<unknown> = Promise.resolve();
  #navigated = false;

  constructor(opts: ViewOptions) {
    this.engine = opts.engine;
    const size = viewportOf(opts);
    this.#size = opts.engine === "webkit" ? size : null;
    this.#view = new Bun.WebView({
      ...size,
      backend:
        opts.engine === "webkit"
          ? "webkit"
          : {
              type: "chrome",
              url: false,
              path: opts.chromePath ?? defaultChromePath(),
              // As Playwright: scrollbars take no width. One Chrome per
              // process: the first view's options win.
              argv: ["--hide-scrollbars"],
            },
    });
  }

  /** WebView throws instead of queueing when busy, so calls are serialized. */
  #run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#queue.then(fn);
    this.#queue = p.catch(() => {});
    return p;
  }

  /** CDP needs a page. */
  async #ensurePage(): Promise<void> {
    if (this.#navigated) return;
    await this.#view.navigate("about:blank");
    this.#navigated = true;
  }

  navigate(url: string): Promise<void> {
    return this.#run(async () => {
      await this.#view.navigate(url);
      this.#navigated = true;
    });
  }

  /** Takes effect for the next page. */
  resize({ width, height }: Viewport): Promise<void> {
    return this.#run(async () => {
      if (width === this.#size?.width && height === this.#size?.height) return;
      await this.#ensurePage();
      await this.#view.resize(width, height);
      this.#size = { width, height };
    });
  }

  evaluate<T = unknown>(expr: string): Promise<T> {
    return this.#run(() => this.#view.evaluate<T>(expr));
  }

  cdp<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    if (this.engine !== "chrome") {
      return Promise.reject(new Error(`cdp() requires chrome (${method})`));
    }
    return this.#run(async () => {
      await this.#ensurePage();
      return this.#view.cdp<T>(method, params);
    });
  }

  /** Subscribes to a CDP event; returns the unsubscribe. */
  on<T = unknown>(event: string, fn: (data: T) => void): () => void {
    const listener = (e: Event) => fn((e as MessageEvent<T>).data);
    this.#view.addEventListener(event, listener);
    return () => this.#view.removeEventListener(event, listener);
  }

  close(): void {
    this.#view.close();
  }
}

const reduceMotion = (view: View) =>
  view.cdp("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });

async function waitReady(
  view: View,
  selector: string,
  timeoutMs = 5000,
): Promise<boolean> {
  const expr = `!!document.querySelector(${JSON.stringify(selector)})`;
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: polling
    if (await view.evaluate<boolean>(expr)) return true;
    if (performance.now() >= deadline) return false;
    await Bun.sleep(25);
  }
}

async function runPool<J, R>(
  jobs: J[],
  size: number,
  makeView: () => View,
  work: (view: View, job: J, slot: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(jobs.length);
  let next = 0;
  // The first failure stops every view taking new jobs; views close once
  // their current job settles.
  const errors: unknown[] = [];
  const views = Array.from({ length: Math.min(size, jobs.length) }, makeView);
  try {
    await Promise.all(
      views.map(async (view, slot) => {
        while (errors.length === 0 && next < jobs.length) {
          const i = next++;
          try {
            // biome-ignore lint/performance/noAwaitInLoops: one job at a time per view
            results[i] = await work(view, jobs[i], slot);
          } catch (e) {
            errors.push(e);
          }
        }
      }),
    );
  } finally {
    for (const v of views) v.close();
  }
  if (errors.length > 0) throw errors[0];
  return results;
}

export interface PageJob {
  name: string;
  theme: string;
  viewport: Viewport;
  url: string;
  /** `name theme`, plus `WxH` when there are several viewports. */
  label: string;
}

// Viewport first, so a pooled view rarely resizes.
function pageJobs(
  baseUrl: string,
  fixtures: string[],
  themes: string[],
  viewports: Viewport[],
  attribute: string | null = "theme",
): PageJob[] {
  return viewports.flatMap((viewport) =>
    fixtures.flatMap((name) =>
      themes.map((theme) => ({
        name,
        theme,
        viewport,
        url:
          `${baseUrl}/${name}.html` +
          (attribute === null
            ? ""
            : `?cr-attr=${encodeURIComponent(attribute)}&cr-value=${encodeURIComponent(theme)}`),
        label:
          `${name} ${theme}` +
          (viewports.length > 1 ? ` ${viewportName(viewport)}` : ""),
      })),
    ),
  );
}

export interface VisitOptions {
  baseUrl: string;
  fixtures: string[];
  themes: string[];
  themeAttribute?: string | null;
  width?: number;
  height?: number;
  viewports?: Viewport[];
  engine: EngineName;
  chromePath?: string;
  concurrency: number;
  emulate: "cdp" | "cssom";
  readySelector?: string;
  readyTimeoutMs?: number;
}

/** Loads `url` in `view` and waits for `readySelector`; false if it never matched. */
export async function loadPage(
  view: View,
  url: string,
  opts: Pick<VisitOptions, "emulate" | "readySelector" | "readyTimeoutMs">,
): Promise<boolean> {
  if (opts.emulate === "cdp") await reduceMotion(view);
  await view.navigate(url);
  return opts.readySelector
    ? waitReady(view, opts.readySelector, opts.readyTimeoutMs)
    : true;
}

export async function visitPages(
  opts: VisitOptions,
  /** `slot` is the view's index in the pool. */
  work: (view: View, job: PageJob, slot: number) => Promise<void>,
): Promise<{ pages: number; ms: number; notReady: string[] }> {
  const viewports = viewportsOf(opts);
  const jobs = pageJobs(
    opts.baseUrl,
    opts.fixtures,
    opts.themes,
    viewports,
    opts.themeAttribute,
  );
  const started = performance.now();
  const ready = await runPool(
    jobs,
    opts.concurrency,
    () =>
      new View({
        engine: opts.engine,
        chromePath: opts.chromePath,
        ...viewports[0],
      }),
    async (view, job, slot) => {
      await view.resize(job.viewport);
      const ready = await loadPage(view, job.url, opts);
      await work(view, job, slot);
      return ready;
    },
  );
  return {
    pages: jobs.length,
    ms: performance.now() - started,
    notReady: jobs.filter((_, i) => !ready[i]).map((j) => j.label),
  };
}

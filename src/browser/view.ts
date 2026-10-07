/**
 * Bun.WebView wrapper. WebView throws instead of queueing when a slot is
 * busy, so each View serializes its calls.
 */

export type EngineName = "chrome" | "webkit";

export interface ViewOptions {
  engine: EngineName;
  width?: number;
  height?: number;
  /** Chrome/Chromium binary. Default: Bun's auto-detection. */
  chromePath?: string;
}

export interface Viewport {
  width: number;
  height: number;
}

const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 900 };

export const viewportName = (v: Viewport) => `${v.width}x${v.height}`;

/** `viewports`, else the single `width` × `height` (1280 × 900 when unset). */
export const viewportsOf = (opts: {
  viewports?: Viewport[];
  width?: number;
  height?: number;
}): Viewport[] =>
  opts.viewports?.length
    ? opts.viewports
    : [
        {
          width: opts.width ?? DEFAULT_VIEWPORT.width,
          height: opts.height ?? DEFAULT_VIEWPORT.height,
        },
      ];

export class View {
  readonly engine: EngineName;
  #view: Bun.WebView;
  #size: Viewport;
  #queue: Promise<unknown> = Promise.resolve();
  #navigated = false;

  constructor(opts: ViewOptions) {
    this.engine = opts.engine;
    this.#size = {
      width: opts.width ?? DEFAULT_VIEWPORT.width,
      height: opts.height ?? DEFAULT_VIEWPORT.height,
    };
    this.#view = new Bun.WebView({
      ...this.#size,
      backend:
        opts.engine === "webkit"
          ? "webkit"
          : {
              type: "chrome",
              url: false,
              path: opts.chromePath,
              // As Playwright: scrollbars take no width (otherwise 100% is
              // 15px narrower). One Chrome per process: the first view's
              // options win.
              argv: ["--hide-scrollbars"],
            },
    });
  }

  #run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#queue.then(fn);
    this.#queue = p.catch(() => {});
    return p;
  }

  navigate(url: string): Promise<void> {
    return this.#run(async () => {
      await this.#view.navigate(url);
      this.#navigated = true;
    });
  }

  /** Resizes the viewport when it differs; takes effect for the next page. */
  resize({ width, height }: Viewport): Promise<void> {
    return this.#run(async () => {
      if (width === this.#size.width && height === this.#size.height) return;
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
      if (!this.#navigated) {
        await this.#view.navigate("about:blank");
        this.#navigated = true;
      }
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

/** Emulates `prefers-reduced-motion: reduce` through CDP. */
export const reduceMotion = (view: View) =>
  view.cdp("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });

/**
 * Polls until `selector` matches in the page, up to `timeoutMs`; false on
 * timeout.
 */
export async function waitReady(
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

/** Runs `jobs` over `size` views, each view one job at a time. */
export async function runPool<J, R>(
  jobs: J[],
  size: number,
  makeView: () => View,
  work: (view: View, job: J) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(jobs.length);
  let next = 0;
  const views = Array.from({ length: Math.min(size, jobs.length) }, makeView);
  try {
    await Promise.all(
      views.map(async (view) => {
        while (next < jobs.length) {
          const i = next++;
          // biome-ignore lint/performance/noAwaitInLoops: one job at a time per view
          results[i] = await work(view, jobs[i]);
        }
      }),
    );
  } finally {
    for (const v of views) v.close();
  }
  return results;
}

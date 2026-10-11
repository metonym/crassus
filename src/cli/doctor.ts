// `crassus doctor`: checks what browser runs need before a long one starts,
// and says how to fix each problem.
import { existsSync, readdirSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import type { Config } from "../core/config";
import type { Io } from "./main";

type Level = "ok" | "warn" | "error";
interface Check {
  level: Level;
  what: string;
  /** How to fix it, when it isn't ok. */
  fix?: string;
}

const MB = 1024 * 1024;
const MARK = { ok: "ok   ", warn: "warn ", error: "error" };

async function free(dir: string): Promise<number> {
  const { bavail, bsize } = await statfs(dir);
  return bavail * bsize;
}

const NAME_CHAR_RE = /[\w-]/;

/** Custom properties `css` declares with `prefix`. */
function declared(css: string, prefix: string): Set<string> {
  const out = new Set<string>();
  for (let i = css.indexOf(prefix); i >= 0; i = css.indexOf(prefix, i + 1)) {
    let j = i + prefix.length;
    while (j < css.length && NAME_CHAR_RE.test(css[j])) j++;
    let k = j;
    while (css[k] === " ") k++;
    if (css[k] === ":") out.add(css.slice(i, j));
  }
  return out;
}

/** `crassus doctor`. Exit 1 when a check fails. */
export async function doctorCommand(opts: {
  config: Config;
  configFile?: string;
  io: Io;
}): Promise<number> {
  const { io, config } = opts;
  const { cwd } = io;
  const checks: Check[] = [];
  const add = (level: Level, what: string, fix?: string) =>
    checks.push({ level, what, ...(fix && { fix }) });
  const { browser } = config;
  const cores = availableParallelism();

  add("ok", `Bun ${Bun.version}`);
  if (typeof Bun.WebView !== "function")
    add("error", "Bun.WebView is missing", "upgrade Bun: bun upgrade");

  // The browser.
  const { headlessShell, View } = await import("../browser/view");
  const shell = headlessShell();
  if (browser?.chromePath)
    add(
      existsSync(browser.chromePath) ? "ok" : "error",
      `Chrome: ${browser.chromePath} (browser.chromePath)`,
      existsSync(browser.chromePath)
        ? undefined
        : "point browser.chromePath at a Chrome or Chromium binary",
    );
  else if (shell) add("ok", `Chrome: chrome-headless-shell at ${shell}`);
  else
    add(
      "warn",
      "Chrome: no chrome-headless-shell, so the installed Chrome runs, starting its helpers beside your own browser",
      "bunx playwright install chromium-headless-shell",
    );
  if (typeof Bun.WebView === "function") {
    const started = performance.now();
    try {
      const view = new View({
        engine: browser?.engine ?? "chrome",
        chromePath: browser?.chromePath,
      });
      try {
        await view.navigate("about:blank");
        const two = await view.evaluate<number>("1 + 1");
        add(
          two === 2 ? "ok" : "error",
          `${browser?.engine ?? "chrome"} starts and runs a page in ${Math.round(performance.now() - started)} ms`,
        );
      } finally {
        view.close();
      }
    } catch (e) {
      add(
        "error",
        `${browser?.engine ?? "chrome"} doesn't start: ${(e as Error).message}`,
        "install Chrome, or set browser.chromePath",
      );
    }
  }

  // The machine.
  const tabs = browser?.concurrency ?? Math.min(4, Math.max(1, cores >> 1));
  add(
    tabs > cores / 2 ? "warn" : "ok",
    `${tabs} tab(s) on ${cores} cores${browser?.concurrency ? " (browser.concurrency)" : ""}`,
    tabs > cores / 2
      ? `each tab is a renderer process: keep to ${Math.max(1, cores >> 1)} or fewer beside other work`
      : undefined,
  );
  const [load] = loadavg();
  add(
    load > cores ? "warn" : "ok",
    `load average ${load.toFixed(1)} on ${cores} cores`,
    load > cores
      ? "the machine is busy: runs slow down to one tab until it settles, and timings are noisy"
      : undefined,
  );
  const disks = [
    [cwd, "the project"],
    [tmpdir(), "the temp directory"],
  ] as const;
  const space = await Promise.all(disks.map(([dir]) => free(dir)));
  disks.forEach(([, label], i) => {
    const bytes = space[i];
    add(
      bytes < 512 * MB ? "error" : bytes < 2048 * MB ? "warn" : "ok",
      `${Math.floor(bytes / MB).toLocaleString("en")} MB free for ${label}`,
      bytes < 2048 * MB
        ? "free space: captures stop below 512 MB, and base builds use worktrees in the temp directory"
        : undefined,
    );
  });

  // The project.
  if (!opts.configFile)
    add(
      "warn",
      "no crassus.config.{ts,js,mjs}",
      "add one: see the README's Configuration",
    );
  else add("ok", `config ${relative(cwd, opts.configFile)}`);
  if (!browser) {
    if (opts.configFile)
      add(
        "warn",
        "no `browser` block: capture, compare, bisect and usage need fixture pages",
        "add browser: { fixtures, sheetMarker } to the config",
      );
  } else {
    const fixtures =
      typeof browser.fixtures === "string"
        ? { dir: browser.fixtures, build: undefined }
        : browser.fixtures;
    const dir = resolve(cwd, fixtures.dir);
    const pages = existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith(".html"))
      : [];
    if (pages.length)
      add("ok", `${pages.length} fixture page(s) in ${fixtures.dir}`);
    else
      add(
        fixtures.build ? "warn" : "error",
        `no fixture pages in ${fixtures.dir}`,
        fixtures.build
          ? `browser runs build them with \`${fixtures.build}\`; run it to check it works`
          : "build the fixtures, or set browser.fixtures.build",
      );
    if (!browser.sheetMarker)
      add(
        "warn",
        "no browser.sheetMarker: compare, bisect and usage need it",
        "set it to text only the library stylesheet contains (a class prefix like `.bx--`)",
      );
    else if (pages.length) {
      const { swappedSheet } = await import("../browser/serve");
      try {
        const file = swappedSheet(dir, browser.sheetMarker);
        add(
          "ok",
          `sheetMarker ${JSON.stringify(browser.sheetMarker)} finds ${file}`,
        );
        if (browser.tokens) {
          const css = await Bun.file(resolve(dir, file)).text();
          const names = declared(css, browser.tokens);
          add(
            names.size ? "ok" : "warn",
            `${names.size} ${browser.tokens}* token(s) declared there`,
            names.size
              ? undefined
              : "browser.tokens matches no custom property in the library stylesheet",
          );
        }
      } catch (e) {
        add(
          "error",
          (e as Error).message,
          "set browser.sheetMarker to text the library stylesheet contains",
        );
      }
    }
    if (!browser.readySelector)
      add(
        "ok",
        "no browser.readySelector: pages are read once loaded (set one if they mount late)",
      );
  }

  for (const c of checks)
    io.out(
      `${MARK[c.level]}  ${c.what}${c.fix ? `\n       fix: ${c.fix}` : ""}`,
    );
  const errors = checks.filter((c) => c.level === "error").length;
  const warnings = checks.filter((c) => c.level === "warn").length;
  io.out(
    `\ncrassus doctor: ${errors} error(s), ${warnings} warning(s), ${checks.length - errors - warnings} ok`,
  );
  return errors ? 1 : 0;
}

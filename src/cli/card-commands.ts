// `crassus explain|repro|verify <id>`: one change card from a report
// directory (`compare --report`), for a person or an agent.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Card, Report } from "../core/cards";
import type { Config } from "../core/config";
import { type BrowserFlags, comparer, pick } from "./browser";
import { formatCard } from "./cards";
import type { Io } from "./main";
import { stylesheets, UsageError } from "./project";
import type { Sheet } from "./sources";

/** Where `--report` writes when given no directory, and where these commands look. */
export const DEFAULT_REPORT = ".crassus/report";

interface Inputs {
  command: Report["command"];
  entry?: string;
  themes: string[];
  viewports?: { width: number; height: number }[];
  flags: BrowserFlags;
}

async function load(
  cwd: string,
  dir: string | undefined,
  id: string,
): Promise<{ report: Report & { inputs: Inputs }; card: Card; dir: string }> {
  const at = resolve(cwd, dir ?? DEFAULT_REPORT);
  const file = join(at, "report.json");
  if (!existsSync(file))
    throw new UsageError(
      `no report at ${relative(cwd, at) || "."}: run crassus compare --report first`,
    );
  const report = (await Bun.file(file).json()) as Report & { inputs: Inputs };
  const matches = report.cards.filter((c) => c.id.startsWith(id));
  if (matches.length !== 1)
    throw new UsageError(
      matches.length
        ? `${id} matches ${matches.length} cards: ${matches.map((c) => c.id).join(", ")}`
        : `no card ${id} in ${relative(cwd, file)}`,
    );
  return { report, card: matches[0], dir: at };
}

/** `crassus explain <id>`: the card as Markdown, or JSON. */
export async function explainCommand(opts: {
  ids: string[];
  report?: string;
  format: "human" | "json";
  io: Io;
}): Promise<number> {
  if (opts.ids.length !== 1) throw new UsageError("explain takes one card id");
  const { card } = await load(opts.io.cwd, opts.report, opts.ids[0]);
  opts.io.out(
    opts.format === "json" ? JSON.stringify(card, null, 2) : formatCard(card),
  );
  return 0;
}

/** `crassus repro <id>`: writes repro/<id>.html in the report directory. */
export async function reproCommand(opts: {
  ids: string[];
  report?: string;
  config: Config;
  io: Io;
}): Promise<number> {
  if (opts.ids.length !== 1) throw new UsageError("repro takes one card id");
  const { cwd } = opts.io;
  const { card, dir, report } = await load(cwd, opts.report, opts.ids[0]);
  if (!card.elements.some((e) => e.html))
    throw new UsageError(`card ${card.id} has no markup: rerun with --report`);
  const { reproHtml } = await import("../browser/repro");
  const html = await reproHtml(
    card,
    {
      base: await Bun.file(join(dir, "base.css")).text(),
      head: await Bun.file(join(dir, "head.css")).text(),
    },
    {
      engine: (report.inputs.flags.engine as "chrome" | "webkit") ?? "chrome",
      chromePath: opts.config.browser?.chromePath,
    },
  );
  await mkdir(join(dir, "repro"), { recursive: true });
  const out = join(dir, "repro", `${card.id}.html`);
  await Bun.write(out, html);
  opts.io.out(relative(cwd, out));
  return 0;
}

const PAGE_RE = /^(.+?)\.([^.]+?)(?:\.(\d+x\d+))?$/;

/**
 * `crassus verify <id>`: compares the report's base stylesheet with the
 * project's now, on the card's pages, and checks its elements no longer
 * differ in its properties. Exit 0 when they all match base again.
 */
export async function verifyCommand(opts: {
  ids: string[];
  report?: string;
  config: Config;
  entry: string[];
  io: Io;
}): Promise<number> {
  if (opts.ids.length !== 1) throw new UsageError("verify takes one card id");
  const { io } = opts;
  const { cwd } = io;
  const { card, dir, report } = await load(cwd, opts.report, opts.ids[0]);
  const entry = opts.entry.length
    ? opts.entry
    : report.inputs.entry
      ? [report.inputs.entry]
      : [];
  const now = pick(await stylesheets(cwd, opts.config, entry), entry);
  const base: Sheet = {
    ...now,
    css: await Bun.file(join(dir, "base.css")).text(),
    file: undefined,
    map: undefined,
  };
  const pages = card.pages.map((p) => PAGE_RE.exec(p));
  const fixtures = [...new Set(pages.map((m) => m?.[1] ?? ""))];
  const themes = [...new Set(pages.map((m) => m?.[2] ?? ""))];
  const themed = !(themes.length === 1 && themes[0] === "default");
  const cmp = comparer({
    config: opts.config,
    flags: {
      ...report.inputs.flags,
      ...(themed && { themes: themes.join(",") }),
    },
    cwd,
  });
  const { result } = await cmp.run({ base, head: now }, undefined, fixtures);
  // Per property of the card: its elements that still differ, and how.
  const still = new Map<string, Map<string, number>>();
  let remaining = 0;
  for (const el of card.elements) {
    const page = result.pages.find((p) => p.file === el.page);
    const changes = page?.changed[el.path] ?? [];
    let differs = false;
    for (const property of el.properties) {
      const c = changes.find(
        (x) => x.property === property || x.aliases?.includes(property),
      );
      if (!c) continue;
      differs = true;
      const by = still.get(property) ?? new Map<string, number>();
      const how = `${c.before} -> ${c.after}`;
      by.set(how, (by.get(how) ?? 0) + 1);
      still.set(property, by);
    }
    if (differs) remaining++;
  }
  const properties = [...new Set(card.changes.map((c) => c.property))];
  const lines = properties.map((p) => {
    const by = still.get(p);
    if (!by) return `  ${p}: matches base`;
    return `  ${p}: still differs, ${[...by].map(([how, n]) => `${how} on ${n}`).join("; ")}`;
  });
  io.out(
    [
      remaining === 0
        ? `crassus: ${card.id} is resolved: its ${card.elements.length} element(s) match base again`
        : `crassus: ${card.id} still differs on ${remaining} of ${card.elements.length} element(s)`,
      ...lines,
    ].join("\n"),
  );
  return remaining === 0 ? 0 : 1;
}

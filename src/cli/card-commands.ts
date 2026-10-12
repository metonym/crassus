// `crassus explain|repro|verify <id>`: one change card from a report
// directory (`compare --report`), for a person or an agent.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { approve, type Card, emptyApprovals, type Report } from "../core/cards";
import type { Config } from "../core/config";
import { serializeUnit } from "../core/reduce";
import {
  type BrowserFlags,
  comparer,
  EMULATE,
  fixturePages,
  pick,
  settings,
} from "./browser";
import { APPROVED_FILE, DEFAULT_DIR, formatCard, readApprovals } from "./cards";
import type { Io } from "./main";
import { shownPath, stylesheets, UsageError } from "./project";
import { seconds } from "./report";
import type { Sheet } from "./sources";

interface Inputs {
  command: Report["command"];
  entry?: string;
  themes: string[];
  viewports?: { width: number; height: number }[];
  flags: BrowserFlags;
}

async function readReport(cwd: string, dir: string | undefined) {
  const at = resolve(cwd, dir ?? DEFAULT_DIR);
  const file = join(at, "report.json");
  if (!existsSync(file))
    throw new UsageError(
      `no report at ${shownPath(cwd, at)}: run crassus compare --report first`,
    );
  return {
    report: (await Bun.file(file).json()) as Report & { inputs: Inputs },
    file,
    at,
  };
}

function cardOf(report: Report, id: string, cwd: string, file: string): Card {
  const matches = report.cards.filter((c) => c.id.startsWith(id));
  if (matches.length !== 1)
    throw new UsageError(
      matches.length
        ? `${id} matches ${matches.length} cards: ${matches.map((c) => c.id).join(", ")}`
        : `no card ${id} in ${shownPath(cwd, file)}`,
    );
  return matches[0];
}

/**
 * `crassus approve <id…>`: records the cards as intended in
 * crassus.approved.json, so compare and bisect stop failing on them.
 */
export async function approveCommand(opts: {
  ids: string[];
  report?: string;
  io: Io;
}): Promise<number> {
  if (opts.ids.length === 0)
    throw new UsageError("approve takes the ids of the cards to approve");
  const { cwd } = opts.io;
  const { report, file } = await readReport(cwd, opts.report);
  const cards = opts.ids.map((id) => cardOf(report, id, cwd, file));
  const approvals = approve(
    (await readApprovals(cwd)) ?? emptyApprovals(),
    cards,
  );
  await Bun.write(
    join(cwd, APPROVED_FILE),
    `${JSON.stringify(approvals, null, 2)}\n`,
  );
  opts.io.out(
    [
      `crassus: approved ${cards.length} card(s) in ${APPROVED_FILE}:`,
      ...cards.map((c) => `  ${c.id}  ${c.title}`),
    ].join("\n"),
  );
  return 0;
}

async function load(
  cwd: string,
  dir: string | undefined,
  id: string,
): Promise<{ report: Report & { inputs: Inputs }; card: Card; dir: string }> {
  const { report, file, at } = await readReport(cwd, dir);
  return { report, card: cardOf(report, id, cwd, file), dir: at };
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
  opts.io.out(shownPath(cwd, out));
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
    io,
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

/**
 * `crassus reduce <id>`: delta-debugs the report's stylesheet change down to
 * the fewest declaration edits that still give the card's element its head
 * value, and writes them to reduce/<id>.json.
 */
export async function reduceCommand(opts: {
  ids: string[];
  report?: string;
  property?: string;
  config: Config;
  format: "human" | "json";
  io: Io;
}): Promise<number> {
  if (opts.ids.length !== 1) throw new UsageError("reduce takes one card id");
  const { io } = opts;
  const { cwd } = io;
  const { card, dir, report } = await load(cwd, opts.report, opts.ids[0]);
  const el =
    card.elements.find((e) => e.pixels) ??
    card.elements.find((e) => !e.path.includes("@")) ??
    card.elements[0];
  const property = opts.property ?? card.changes[0].property;
  const page = PAGE_RE.exec(el.page);
  if (!page) throw new UsageError(`can't read the page name ${el.page}`);
  const { browser, pages } = settings(opts.config, report.inputs.flags, io);
  if (!browser.sheetMarker)
    throw new UsageError("reduce needs `browser.sheetMarker`");
  const { path } = await fixturePages(cwd, browser, report.inputs.flags);
  const [width, height] = page[3]?.split("x").map(Number) ?? [];
  const { reduceChange } = await import("../browser/reduce");
  const r = await reduceChange({
    dir: path,
    sheetMarker: browser.sheetMarker,
    base: await Bun.file(join(dir, "base.css")).text(),
    head: await Bun.file(join(dir, "head.css")).text(),
    fixture: page[1],
    theme: page[2],
    themeAttribute: pages.themeAttribute,
    viewport: width && height ? { width, height } : pages.viewports?.[0],
    path: el.path,
    property,
    engine: pages.engine,
    chromePath: pages.chromePath,
    emulate: EMULATE[pages.engine],
    readySelector: pages.readySelector,
    readyTimeoutMs: pages.readyTimeoutMs,
    settleMs: browser.settleMs,
  });
  const out = {
    card: card.id,
    page: el.page,
    path: el.path,
    property,
    ...r,
    edits: r.edits.map(({ op, unit }) => ({
      op: op === "-" ? "removed" : "added",
      ...unit,
      css: serializeUnit(unit),
    })),
  };
  await mkdir(join(dir, "reduce"), { recursive: true });
  await Bun.write(
    join(dir, "reduce", `${card.id}.json`),
    JSON.stringify(out, null, 2),
  );
  if (opts.format === "json") {
    io.out(JSON.stringify(out, null, 2));
    return 0;
  }
  io.out(
    [
      `crassus: ${card.id}: ${property} on ${el.page} ${el.selector ?? el.path} goes ${r.before} -> ${r.after} with ${r.edits.length} of the change's ${r.total} declaration edit(s) (${r.tests} tries, ${seconds(r.ms)}):`,
      ...out.edits.map(
        (e) =>
          `  ${e.op === "removed" ? "-" : "+"} ${e.css}${e.line ? `  (${e.op === "removed" ? "base" : "head"}.css:${e.line})` : ""}`,
      ),
    ].join("\n"),
  );
  return 0;
}

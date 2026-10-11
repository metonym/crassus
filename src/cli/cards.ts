// Change cards from `compare` and `bisect`, rendered: a report directory
// (report.json, an offline index.html, report.md and crops), a terminal
// summary, Markdown and SARIF. The model is `src/core/cards.ts`.
import { existsSync } from "node:fs";
import { mkdir, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { version } from "../../package.json";
import type { Crops } from "../browser/compare";
import type { Card, Report } from "../core/cards";

/** Crops for `card` elements, by run (`commit`, `""` for compare) and page. */
export type RunCrops = Map<string, Crops>;

/** Elements per card written with images. */
const IMAGES_PER_CARD = 3;
const CONTEXT_LINES = 2;

const label = (c: Card) =>
  c.verdict === "visible" && c.deltaE
    ? `visible (ΔE ${c.deltaE.max.toFixed(1)})`
    : c.verdict === "invisible"
      ? `invisible (${c.invisible})`
      : c.verdict;

/** Reads the changed rule's source lines, at the commit its side was built from. */
export async function attachSources(
  report: Report,
  opts: {
    cwd: string;
    /** The commit each side was built from, if any. */
    shas?: (card: Card) => { base?: string; head?: string };
  },
): Promise<void> {
  const remote = await githubUrl(opts.cwd);
  for (const card of report.cards) {
    const rule = card.cause.rule;
    const line = rule?.line;
    if (!rule || !line || !rule.sheet || rule.sheet === "user agent") continue;
    const side = card.cause.kind === "lost" ? "base" : "head";
    const sha = opts.shas?.(card)[side];
    const text = sha
      ? // biome-ignore lint/performance/noAwaitInLoops: a few cards, one git call each
        await $`git show ${`${sha}:${rule.sheet}`}`
          .cwd(opts.cwd)
          .quiet()
          .nothrow()
          .then((r) => (r.exitCode === 0 ? r.text() : null))
      : existsSync(resolve(opts.cwd, rule.sheet))
        ? await Bun.file(resolve(opts.cwd, rule.sheet)).text()
        : null;
    const lines = text?.split("\n");
    const excerpt = lines
      ?.slice(Math.max(0, line - 1 - CONTEXT_LINES), line + CONTEXT_LINES)
      .map(
        (l, i) =>
          `${String(Math.max(1, line - CONTEXT_LINES) + i).padStart(5)} | ${l}`,
      )
      .join("\n");
    card.source = {
      file: rule.sheet,
      line,
      ...(excerpt && { excerpt }),
      vscode: `vscode://file/${resolve(opts.cwd, rule.sheet)}:${line}`,
      ...(remote &&
        sha && { github: `${remote}/blob/${sha}/${rule.sheet}#L${line}` }),
    };
  }
}

const SSH_RE = /^git@([^:]+):(.+?)(?:\.git)?$/;
const HTTPS_RE = /^https:\/\/(github\.com\/.+?)(?:\.git)?$/;

async function githubUrl(cwd: string): Promise<string | null> {
  const r = await $`git remote get-url origin`.cwd(cwd).quiet().nothrow();
  if (r.exitCode !== 0) return null;
  const url = r.text().trim();
  const ssh = SSH_RE.exec(url);
  if (ssh?.[1] === "github.com") return `https://github.com/${ssh[2]}`;
  const https = HTTPS_RE.exec(url);
  return https ? `https://${https[1]}` : null;
}

/** Disk space the report keeps free. */
const RESERVE = 512 * 1024 * 1024;

/**
 * Writes `report` to `dir`: report.json, index.html, report.md, base.css
 * and head.css (for `repro` and `verify`), and up to three elements' crops
 * per card (base, head, and a heatmap of what differs).
 */
export async function writeReport(
  dir: string,
  report: Report,
  extra: { crops: RunCrops; base: string; head: string; inputs: object },
): Promise<void> {
  const { encodePng, heatmap } = await import("../browser/png");
  await mkdir(join(dir, "img"), { recursive: true });
  const { bavail, bsize } = await statfs(dir);
  // Crops are small; the sheets dominate. Stop well short of a full disk.
  const needed = extra.base.length + extra.head.length;
  if (bavail * bsize < needed * 4 + RESERVE)
    throw Object.assign(
      new Error(`not enough disk space for the report in ${dir}`),
      { code: "ENOSPC" },
    );
  for (const card of report.cards) {
    let written = 0;
    // Elements whose pixels differ first: they show the change.
    const order = [
      ...card.elements.entries().filter(([, e]) => e.pixels),
      ...card.elements.entries().filter(([, e]) => !e.pixels),
    ];
    for (const [i, el] of order) {
      if (written >= IMAGES_PER_CARD) break;
      const crop = extra.crops.get(el.commit ?? "")?.[el.page]?.[el.path];
      if (!crop) continue;
      const name = `${card.id}-${i}`;
      el.images = {
        base: `img/${name}-base.png`,
        head: `img/${name}-head.png`,
        diff: `img/${name}-diff.png`,
      };
      // biome-ignore lint/performance/noAwaitInLoops: a few small files
      await Promise.all([
        Bun.write(join(dir, el.images.base), encodePng(crop.base)),
        Bun.write(join(dir, el.images.head), encodePng(crop.head)),
        Bun.write(
          join(dir, el.images.diff),
          encodePng(heatmap(crop.base, crop.head)),
        ),
      ]);
      written++;
    }
  }
  const json = JSON.stringify(
    { ...report, inputs: extra.inputs, crassus: version },
    null,
    2,
  );
  await Promise.all([
    Bun.write(join(dir, "report.json"), json),
    Bun.write(join(dir, "report.md"), formatCardsMarkdown(report)),
    Bun.write(join(dir, "index.html"), reportHtml(report)),
    Bun.write(join(dir, "base.css"), extra.base),
    Bun.write(join(dir, "head.css"), extra.head),
  ]);
}

/** One line per verdict, then one per card: what CI logs and agents read first. */
export function formatCardsSummary(report: Report, dir?: string): string {
  const { visible, imperceptible, invisible } = report.summary;
  const lines = [
    `${visible} visible, ${imperceptible} imperceptible, ${invisible} invisible change card(s)${dir ? ` (report: ${dir})` : ""}`,
  ];
  for (const c of report.cards)
    lines.push(
      `  ${c.id}  ${label(c).padEnd(12)}  ${c.title}  [${c.elements.length} element(s), ${c.pages.length} page(s)]`,
    );
  return lines.join("\n");
}

const fence = (text: string, lang = "") => {
  const ticks = text.includes("```") ? "~~~~" : "```";
  return `${ticks}${lang}\n${text}\n${ticks}`;
};

const trim = (html: string, max = 400) =>
  html.length > max ? `${html.slice(0, max)}…` : html;

/** The element a card shows: one with crops, else one whose pixels differ. */
const shownElement = (card: Card) =>
  card.elements.find((e) => e.images) ??
  card.elements.find((e) => e.pixels) ??
  card.elements[0];

/** One card as Markdown: what `crassus explain <id>` prints. */
export function formatCard(card: Card, images = true): string {
  const lines = [
    `### ${label(card)}: ${card.title}`,
    "",
    `\`${card.id}\` · ${card.elements.length} element(s) on ${card.pages.length} page(s): ${card.pages.slice(0, 6).join(", ")}${card.pages.length > 6 ? ", …" : ""}`,
    "",
    card.alt,
  ];
  if (card.commits?.length)
    lines.push(
      "",
      `Came in with ${card.commits.map((c) => `\`${c.sha.slice(0, 9)}\` ${c.subject}`).join("; ")}.`,
    );
  const shown = shownElement(card);
  if (images && shown.images)
    lines.push(
      "",
      `| base | head | differs |\n|:--|:--|:--|\n| ![base](${shown.images.base}) | ![head](${shown.images.head}) | ![diff](${shown.images.diff}) |`,
    );
  lines.push(
    "",
    "**What**",
    "",
    ...card.changes
      .slice(0, 12)
      .map(
        (c) =>
          `- \`${c.property}: ${c.before} -> ${c.after}\` on ${c.count}${c.aliases ? ` (also ${c.aliases.join(", ")})` : ""}`,
      ),
  );
  if (card.changes.length > 12)
    lines.push(`- and ${card.changes.length - 12} more`);
  const el = shownElement(card);
  lines.push(
    "",
    "**Where**",
    "",
    `- ${el.page}: \`${el.selector ?? el.path}\``,
    `- path: \`${el.path}\``,
  );
  if (el.html) lines.push("", fence(trim(el.html), "html"));
  lines.push("", "**Why**", "");
  const rule = card.cause.rule;
  if (rule)
    lines.push(
      `${card.cause.kind === "lost" ? "Lost on head" : "Won on head"}: \`${rule.selector}\` at ${rule.sheet}${rule.line ? `:${rule.line}` : ""}${card.source?.github ? ` ([source](${card.source.github}))` : ""}`,
    );
  else if (card.cause.kind === "shifted")
    lines.push(
      `The winner moved: ${card.cause.base?.selector ?? "no declaration"} -> ${card.cause.head?.selector ?? "no declaration"}.`,
    );
  else lines.push("Winners unknown: run with --explain.");
  if (card.source?.excerpt) lines.push("", fence(card.source.excerpt));
  if (card.fix) lines.push("", "**Suggested fix**", "", card.fix.text);
  lines.push(
    "",
    "**Act**",
    "",
    fence(
      [
        `crassus explain ${card.id}`,
        `crassus repro ${card.id}`,
        `crassus verify ${card.id}`,
      ].join("\n"),
      "sh",
    ),
  );
  return lines.join("\n");
}

/** The report for a PR: counts, then the cards most worth a look. */
export function formatCardsMarkdown(report: Report, max = 10): string {
  const { visible, imperceptible, invisible } = report.summary;
  const lines = [
    `## crassus: ${report.base} -> ${report.head}`,
    "",
    `${visible} visible, ${imperceptible} imperceptible and ${invisible} invisible change card(s).`,
  ];
  for (const card of report.cards.slice(0, max))
    lines.push(
      "",
      "<details" +
        (card.verdict === "visible" ? " open" : "") +
        `><summary><b>${label(card)}</b>: ${escapeHtml(card.title)} (<code>${card.id}</code>)</summary>\n`,
      formatCard(card),
      "",
      "</details>",
    );
  if (report.cards.length > max)
    lines.push(
      "",
      `And ${report.cards.length - max} more card(s) in report.json.`,
    );
  return `${lines.join("\n")}\n`;
}

/** Cards with a source line, as SARIF results anchored on the changed rule. */
export function formatCardsSarif(report: Report): string {
  const levels = { visible: "error", imperceptible: "note", invisible: "none" };
  return JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "crassus",
              version,
              informationUri: "https://github.com/metonym/crassus",
              rules: ["visible", "imperceptible", "invisible"].map((id) => ({
                id: `change-${id}`,
                name: `Computed-style change (${id})`,
                shortDescription: {
                  text: `A stylesheet change that is ${id} on the fixtures`,
                },
                properties: { claim: "ground truth" },
              })),
            },
          },
          results: report.cards.map((c) => ({
            ruleId: `change-${c.verdict}`,
            level: levels[c.verdict],
            message: { text: `${c.title}. ${c.alt}` },
            partialFingerprints: { crassusCard: c.id },
            locations: c.source
              ? [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: c.source.file },
                      region: { startLine: c.source.line },
                    },
                  },
                ]
              : [],
            properties: { card: c.id, pages: c.pages },
          })),
        },
      ],
    },
    null,
    2,
  );
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );

/** An offline page: cards by root cause, filters, before/after slider, code. */
function reportHtml(report: Report): string {
  const data = JSON.stringify(report).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>crassus: ${escapeHtml(report.base)} -> ${escapeHtml(report.head)}</title>
<style>
:root { color-scheme: light dark; --line: #8884; --mute: #888; --visible: #d6336c; --imperceptible: #c08a00; --invisible: #6c757d; }
body { margin: 0; font: 14px/1.45 system-ui, sans-serif; display: grid; grid-template-columns: 22rem 1fr; height: 100vh; }
aside { border-right: 1px solid var(--line); overflow: auto; padding: .75rem; }
main { overflow: auto; padding: 1rem 1.5rem; }
h1 { font-size: 1rem; margin: 0 0 .5rem; } h2 { font-size: 1.15rem; margin: .25rem 0 .5rem; } h3 { font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; color: var(--mute); margin: 1.25rem 0 .35rem; }
.filters label { margin-right: .6rem; white-space: nowrap; } input[type=search] { width: 100%; margin: .5rem 0; box-sizing: border-box; }
.card { display: block; width: 100%; text-align: left; border: 0; background: none; color: inherit; padding: .45rem .5rem; border-radius: 6px; cursor: pointer; font: inherit; }
.card:hover, .card[aria-current] { background: #8882; }
.badge { display: inline-block; font-size: .7rem; padding: 0 .4rem; border-radius: 1rem; color: #fff; margin-right: .3rem; }
.visible { background: var(--visible); } .imperceptible { background: var(--imperceptible); } .invisible { background: var(--invisible); }
.mute { color: var(--mute); font-size: .85em; }
pre { background: #8881; padding: .6rem; border-radius: 6px; overflow: auto; font-size: 12px; }
code { font-size: .92em; }
table { border-collapse: collapse; } td, th { border-bottom: 1px solid var(--line); padding: .2rem .6rem .2rem 0; text-align: left; vertical-align: top; }
.shots { display: flex; gap: 1rem; flex-wrap: wrap; align-items: flex-start; }
.shots figure { margin: 0; } .shots img { image-rendering: pixelated; border: 1px solid var(--line); zoom: 2; }
.slider { position: relative; display: inline-block; } .slider img { display: block; } .slider .over { position: absolute; inset: 0; overflow: hidden; }
</style></head>
<body>
<aside>
<h1>crassus ${escapeHtml(version)}</h1>
<div class="mute">${escapeHtml(report.base)} → ${escapeHtml(report.head)}</div>
<div class="filters" id="filters"></div>
<input type="search" id="q" placeholder="Filter by page, selector or property">
<nav id="list"></nav>
</aside>
<main id="card"><p class="mute">Pick a card.</p></main>
<script type="application/json" id="data">${data}</script>
<script>
const report = JSON.parse(document.getElementById("data").textContent);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const md = (s) => esc(s).replace(/\`([^\`]+)\`/g, "<code>$1</code>");
const verdicts = ["visible", "imperceptible", "invisible"];
const shown = new Set(["visible", "imperceptible"]);
document.getElementById("filters").innerHTML = verdicts.map((v) =>
  '<label><input type="checkbox" value="' + v + '"' + (shown.has(v) ? " checked" : "") + '> ' + v + " (" + report.summary[v] + ")</label>").join("");
document.getElementById("filters").addEventListener("change", (e) => {
  e.target.checked ? shown.add(e.target.value) : shown.delete(e.target.value); list();
});
document.getElementById("q").addEventListener("input", list);
let current = location.hash.slice(1);
function list() {
  const q = document.getElementById("q").value.toLowerCase();
  const nav = document.getElementById("list");
  nav.innerHTML = "";
  for (const c of report.cards) {
    if (!shown.has(c.verdict)) continue;
    const text = (c.title + " " + c.pages.join(" ") + " " + c.changes.map((x) => x.property).join(" ")).toLowerCase();
    if (q && !text.includes(q)) continue;
    const b = document.createElement("button");
    b.className = "card";
    if (c.id === current) b.setAttribute("aria-current", "true");
    b.innerHTML = '<span class="badge ' + c.verdict + '">' + c.verdict + "</span>" + md(c.title) +
      '<div class="mute">' + c.elements.length + " element(s), " + c.pages.length + " page(s) · " + c.id + "</div>";
    b.onclick = () => { location.hash = c.id; };
    nav.append(b);
  }
}
function show() {
  current = location.hash.slice(1);
  const c = report.cards.find((x) => x.id === current);
  list();
  if (!c) return;
  const el = c.elements.find((e) => e.images) || c.elements.find((e) => e.pixels) || c.elements[0];
  const rule = c.cause.rule;
  let html = '<span class="badge ' + c.verdict + '">' + c.verdict + (c.invisible ? ": " + esc(c.invisible) : "") +
    (c.deltaE ? " · ΔE " + c.deltaE.max.toFixed(1) : "") + "</span><h2>" + md(c.title) + '</h2><p class="mute">' + esc(c.alt) + "</p>";
  if (c.commits) html += "<p>Came in with " + c.commits.map((x) => "<code>" + x.sha.slice(0, 9) + "</code> " + esc(x.subject)).join("; ") + "</p>";
  if (el.images) html += '<div class="shots"><figure><figcaption>base / head (drag)</figcaption><div class="slider"><img src="' + el.images.base +
    '" alt="base"><div class="over" style="width:50%"><img src="' + el.images.head + '" alt="head"></div></div><br><input type="range" min="0" max="100" value="50" oninput="this.previousElementSibling.previousElementSibling.querySelector(\\'.over\\').style.width=this.value+\\'%\\'"></figure>' +
    '<figure><figcaption>base</figcaption><img src="' + el.images.base + '" alt="base"></figure><figure><figcaption>head</figcaption><img src="' + el.images.head +
    '" alt="head"></figure><figure><figcaption>what differs</figcaption><img src="' + el.images.diff + '" alt="' + esc(c.alt) + '"></figure></div>';
  html += "<h3>What</h3><table>" + c.changes.map((x) => "<tr><td><code>" + esc(x.property) + "</code></td><td><code>" + esc(x.before) + "</code> → <code>" + esc(x.after) +
    "</code>" + (x.aliases ? ' <span class="mute">also ' + esc(x.aliases.join(", ")) + "</span>" : "") + "</td><td>" + x.count + "×</td></tr>").join("") + "</table>";
  html += "<h3>Where</h3><p><code>" + esc(el.selector || el.path) + '</code> on ' + esc(el.page) + '</p><p class="mute">' + esc(el.path) + "</p>";
  if (el.html) html += "<pre>" + esc(el.html.length > 1200 ? el.html.slice(0, 1200) + "…" : el.html) + "</pre>";
  html += "<h3>Why</h3>";
  if (rule) html += "<p>" + (c.cause.kind === "lost" ? "No longer applies on head: " : "Now wins on head: ") + "<code>" + esc(rule.selector) + "</code> at " +
    (c.source && c.source.vscode ? '<a href="' + esc(c.source.vscode) + '">' : "") + esc(rule.sheet + (rule.line ? ":" + rule.line : "")) + (c.source && c.source.vscode ? "</a>" : "") +
    (c.source && c.source.github ? ' · <a href="' + esc(c.source.github) + '">GitHub</a>' : "") + "</p>";
  else if (c.cause.kind === "shifted") html += "<p>The winner moved: <code>" + esc(c.cause.base ? c.cause.base.selector : "no declaration") + "</code> → <code>" + esc(c.cause.head ? c.cause.head.selector : "no declaration") + "</code></p>";
  if (c.source && c.source.excerpt) html += "<pre>" + esc(c.source.excerpt) + "</pre>";
  html += "<h3>Blast radius</h3><p>" + c.elements.length + " element(s) on " + c.pages.length + " page(s): " + c.pages.map(esc).join(", ") + "</p>";
  if (c.fix) html += "<h3>Suggested fix</h3><p>" + esc(c.fix.text) + "</p>";
  html += "<h3>Act</h3><pre>crassus explain " + c.id + "\\ncrassus repro " + c.id + "\\ncrassus verify " + c.id + "</pre>";
  document.getElementById("card").innerHTML = html;
}
addEventListener("hashchange", show);
list();
if (!current && report.cards[0]) location.hash = report.cards[0].id; else show();
</script>
</body></html>
`;
}

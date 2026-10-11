// `crassus repro <id>`: one card's element in a page of its own, with each
// side's stylesheet cut down to the rules that can style it, and a toggle.
import type { Card } from "../core/cards";
import { relaxSelector } from "../core/impact";
import { type EngineName, View } from "./view";

const TAG_RE = /^<([a-z][\w-]*)([^>]*)>$/i;

/** The element's markup inside its ancestors' opening tags, `<html>` and `<body>` aside. */
function markup(card: Card): {
  html: string;
  htmlAttrs: string;
  bodyAttrs: string;
} {
  // The element the report shows: one whose pixels differ.
  const el =
    card.elements.find((e) => e.html && e.images) ??
    card.elements.find((e) => e.html && e.pixels) ??
    card.elements.find((e) => e.html) ??
    card.elements[0];
  const tags = (el.ancestors ?? []).map((t) => TAG_RE.exec(t));
  const [html, body, ...rest] = tags;
  let out = el.html ?? "";
  for (const t of rest.reverse())
    if (t) out = `<${t[1]}${t[2]}>${out}</${t[1]}>`;
  return { html: out, htmlAttrs: html?.[2] ?? "", bodyAttrs: body?.[2] ?? "" };
}

/**
 * The rules of `css` that can style the page in `view` (their selectors
 * relaxed as `compare` does: any state, a pseudo-element's element),
 * with the at-rules that hold them, `@font-face`, `@keyframes` and
 * `@property`.
 */
async function minimal(view: View, css: string): Promise<string> {
  const selectors = await view.evaluate<string[]>(`((text) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    const out = [];
    const visit = (list) => { for (const r of list) { if (r.selectorText !== undefined) out.push(r.selectorText); if (r.cssRules) visit(r.cssRules); } };
    visit(sheet.cssRules);
    window.__crSheet = sheet;
    return out;
  })(${JSON.stringify(css)})`);
  const relaxed = selectors.map((s) => {
    try {
      return relaxSelector(s);
    } catch {
      return "*";
    }
  });
  return view.evaluate<string>(`((relaxed) => {
    let i = 0;
    const matches = (s) => { try { return document.querySelector(s) !== null; } catch { return true; } };
    const keep = (list) => {
      const out = [];
      for (const r of list) {
        if (r.selectorText !== undefined) {
          const sel = relaxed[i++];
          // Nested rules come next in order: visit them either way.
          const inner = r.cssRules && r.cssRules.length ? keep(r.cssRules) : "";
          if (matches(sel) || inner) out.push(r.cssText);
          continue;
        }
        if (r.cssRules && !(r instanceof CSSKeyframesRule)) {
          const inner = keep(r.cssRules);
          if (inner) out.push(r.cssText.slice(0, r.cssText.indexOf("{")) + "{\\n" + inner + "\\n}");
          continue;
        }
        out.push(r.cssText);
      }
      return out.join("\\n");
    };
    return keep(window.__crSheet.cssRules);
  })(${JSON.stringify(relaxed)})`);
}

/** A standalone page that shows the card's element under base's rules, and head's at a click. */
export async function reproHtml(
  card: Card,
  css: { base: string; head: string },
  opts: { engine: EngineName; chromePath?: string },
): Promise<string> {
  const { html, htmlAttrs, bodyAttrs } = markup(card);
  const view = new View({ engine: opts.engine, chromePath: opts.chromePath });
  let sheets: { base: string; head: string };
  try {
    await view.navigate("about:blank");
    await view.evaluate(`(() => {
      const doc = new DOMParser().parseFromString(${JSON.stringify(`<!doctype html><html${htmlAttrs}><head></head><body${bodyAttrs}>${html}</body></html>`)}, "text/html");
      document.replaceChild(document.adoptNode(doc.documentElement), document.documentElement);
    })()`);
    sheets = {
      base: await minimal(view, css.base),
      head: await minimal(view, css.head),
    };
  } finally {
    view.close();
  }
  const style = (s: string) => s.replace(/<\/style/gi, "<\\/style");
  return `<!doctype html>
<html${htmlAttrs}><head><meta charset="utf-8">
<title>crassus repro ${card.id}</title>
<!-- ${card.title.replace(/--/g, "- -")} -->
<style id="crassus-base">
${style(sheets.base)}
</style>
<style id="crassus-head" media="not all">
${style(sheets.head)}
</style>
</head><body${bodyAttrs}>${html}<div id="crassus-repro" style="all: initial; position: fixed; right: 8px; bottom: 8px; z-index: 2147483647; font: 13px system-ui, sans-serif; background: #222; color: #fff; padding: 6px 10px; border-radius: 6px">
<button type="button" style="all: revert; cursor: pointer" onclick="const b = document.getElementById('crassus-base'), h = document.getElementById('crassus-head'), head = b.media !== 'not all'; b.media = head ? 'not all' : ''; h.media = head ? '' : 'not all'; this.nextElementSibling.textContent = head ? 'head' : 'base';">Toggle</button> showing <b>base</b> · ${card.id}
</div></body></html>
`;
}

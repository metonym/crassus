/**
 * The `dom` usage engine's page half, bundled to an IIFE by page-script.ts.
 * Matches the library sheet's rules against every element with
 * `Element.matches()`, bucketed by the rightmost compound's id, class or tag
 * as Blink's RuleSet does, and returns compact match lists. Cascade order and
 * declarations are worked out Bun-side.
 */
import {
  type Complex,
  parseComplex,
  parseSelectorList,
  resolveNested,
  serializeList,
  splitList,
} from "../core/selector";
import {
  INTERACTIVE,
  MAX_STATE_DESCENDANTS,
  MAX_STATE_ELEMENTS,
  STATE_SETS,
} from "./states";

const STATE_RE = /:(focus-visible|focus-within|hover|focus|active)(?![\w-])/g;
const PSEUDO_END = /::?(before|after)$/i;

interface Prepared {
  rule: number;
  sel: number;
  host: string;
  pe: "" | "before" | "after";
}

/** [cssomRuleIndex, ...matchingSelectorIndexes] */
type Match = number[];
/** [kind: 0 self | 1 before | 2 after, matches] */
type Observation = [number, Match[]];

let rules: (CSSStyleRule | CSSNestedDeclarations)[] = [];
let active: boolean[] = [];
/** Index of the style rule each rule is nested in, or -1. */
let parents: number[] = [];

/**
 * Selector text with `&` resolved against the enclosing style rules (CSS
 * nesting), from the current selectorText. Nested declarations are `&`.
 */
function resolvedSelectors(): string[] {
  const texts: string[] = [];
  const lists: (Complex[] | undefined)[] = [];
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    const own = r instanceof CSSStyleRule ? r.selectorText : "&";
    const p = parents[i];
    if (p < 0) {
      texts.push(own);
      lists.push(undefined);
      continue;
    }
    lists[p] ??= parseSelectorList(texts[p]);
    const parent = lists[p];
    const list = splitList(own).map(({ text }) =>
      resolveNested(parseComplex(text), parent),
    );
    texts.push(serializeList(list));
    lists.push(list);
  }
  return texts;
}

const CSS_ESCAPE_RE = /\\([0-9a-fA-F]{1,6}\s?|[\s\S])/g;
const HEX_ESCAPE_RE = /^[0-9a-fA-F]+\s?$/;
const PAREN_GROUP_RE = /\((?:[^()]|\([^()]*\))*\)/g;
const ATTRIBUTE_RE = /\[[^\]]*\]/g;
const IDENT = "((?:\\\\[\\s\\S]|[\\w\\u0080-\\uffff-])+)";
const ID_RE = new RegExp(`#${IDENT}`);
const CLASS_RE = new RegExp(`\\.${IDENT}`);
const TAG_RE = /^([a-zA-Z][\w-]*)/;
const REDUCED_MOTION_RE = /prefers-reduced-motion/;
const NO_PREFERENCE_RE = /no-preference/;
const TRAILING_COMBINATOR_RE = /[\s>+~]$/;
const OTHER_PSEUDO_ELEMENT_RE = /::|:(first-line|first-letter|before|after)\b/i;

function unescapeIdent(s: string): string {
  return s.replace(CSS_ESCAPE_RE, (_, e: string) =>
    HEX_ESCAPE_RE.test(e) ? String.fromCodePoint(Number.parseInt(e, 16)) : e,
  );
}

/** Rightmost compound start (after the last top-level combinator). */
function rightmostStart(sel: string): number {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && (c === " " || c === ">" || c === "+" || c === "~"))
      start = i + 1;
  }
  return start;
}

function bucketKey(host: string): string {
  const compound = host
    .slice(rightmostStart(host))
    .replace(PAREN_GROUP_RE, "")
    .replace(ATTRIBUTE_RE, "");
  const id = ID_RE.exec(compound);
  if (id) return `#${unescapeIdent(id[1])}`;
  const cls = CLASS_RE.exec(compound);
  if (cls) return `.${unescapeIdent(cls[1])}`;
  const tag = TAG_RE.exec(compound);
  if (tag) return tag[1].toLowerCase();
  return "*";
}

function collectRules(
  sheet: CSSStyleSheet,
): { ctx: string[]; sel: string; active: boolean }[] {
  const out: { ctx: string[]; sel: string; active: boolean }[] = [];
  rules = [];
  active = [];
  parents = [];
  const add = (
    r: CSSStyleRule | CSSNestedDeclarations,
    ctx: string[],
    on: boolean,
    parent: number,
  ) => {
    rules.push(r);
    active.push(on);
    parents.push(parent);
    out.push({ ctx, sel: "", active: on });
  };
  // `parent`: index of the enclosing style rule (CSS nesting), or -1.
  const visit = (
    list: CSSRuleList,
    ctx: string[],
    on: boolean,
    parent: number,
  ) => {
    for (const r of Array.from(list)) {
      if (r instanceof CSSStyleRule) {
        add(r, ctx, on, parent);
        if (r.cssRules?.length) visit(r.cssRules, ctx, on, rules.length - 1);
      } else if (
        typeof CSSNestedDeclarations !== "undefined" &&
        r instanceof CSSNestedDeclarations
      ) {
        if (parent >= 0) add(r, ctx, on, parent);
      } else if (r instanceof CSSMediaRule) {
        visit(
          r.cssRules,
          [...ctx, `@media ${r.media.mediaText}`],
          on && matchMedia(r.media.mediaText).matches,
          parent,
        );
      } else if (r instanceof CSSSupportsRule) {
        visit(
          r.cssRules,
          [...ctx, `@supports ${r.conditionText}`],
          on && CSS.supports(r.conditionText),
          parent,
        );
      } else if (
        typeof CSSContainerRule !== "undefined" &&
        r instanceof CSSContainerRule
      ) {
        // Container conditions can't be evaluated from outside: inactive.
        visit(
          r.cssRules,
          [...ctx, `@container ${r.conditionText}`],
          false,
          parent,
        );
      } else if ("cssRules" in r && !(r instanceof CSSKeyframesRule)) {
        visit((r as CSSGroupingRule).cssRules, ctx, on, parent);
      }
    }
  };
  visit(sheet.cssRules, [], true, -1);
  const texts = resolvedSelectors();
  for (let i = 0; i < out.length; i++) out[i].sel = texts[i];
  return out;
}

const api = {
  /** Each sheet's index and href, and its text if inline and containing `marker`. */
  sheets(marker: string) {
    return Array.from(document.styleSheets).map((s, i) => {
      const inline = s.href
        ? null
        : ((s.ownerNode as HTMLElement | null)?.textContent ?? "");
      return {
        i,
        href: s.href,
        inline: inline?.includes(marker) ? inline : null,
      };
    });
  },

  inventory(sheetIndex: number) {
    return collectRules(document.styleSheets[sheetIndex]);
  },

  /** Engine-native shorthand expansion and value validity. */
  declInfo(pairs: [string, string][]) {
    const el = document.createElement("div");
    const longhands: Record<string, string[]> = {};
    const valid: boolean[] = [];
    for (const [prop, value] of pairs) {
      if (!(prop in longhands)) {
        if (prop.startsWith("--")) longhands[prop] = [prop];
        else {
          el.removeAttribute("style");
          el.style.setProperty(prop, "initial");
          longhands[prop] = Array.from(el.style);
        }
      }
      valid.push(
        prop.startsWith("--") ||
          (longhands[prop].length > 0 && CSS.supports(prop, value)),
      );
    }
    return { longhands, valid };
  },

  /** Emulates prefers-reduced-motion: reduce by rewriting media rules. */
  reducedMotion() {
    for (const sheet of Array.from(document.styleSheets)) {
      const visit = (list: CSSRuleList) => {
        for (const r of Array.from(list)) {
          if (
            r instanceof CSSMediaRule &&
            REDUCED_MOTION_RE.test(r.media.mediaText)
          )
            r.media.mediaText = NO_PREFERENCE_RE.test(r.media.mediaText)
              ? "not all"
              : "all";
          if ("cssRules" in r) visit((r as CSSGroupingRule).cssRules);
        }
      };
      try {
        visit(sheet.cssRules);
      } catch {}
    }
  },

  run(states: boolean) {
    const t0 = performance.now();
    // Forced states: state pseudo-classes become `[data-cr-*]` in place (same
    // specificity and order), toggled below.
    if (states) {
      for (const r of rules) {
        if (r instanceof CSSStyleRule && STATE_RE.test(r.selectorText)) {
          STATE_RE.lastIndex = 0;
          r.selectorText = r.selectorText.replace(
            STATE_RE,
            (_, s) => `[data-cr-${s}]`,
          );
        }
        STATE_RE.lastIndex = 0;
      }
    }
    const buckets = new Map<string, Prepared[]>();
    let skipped = 0;
    resolvedSelectors().forEach((selectorText, ri) => {
      splitList(selectorText).forEach(({ text }, si) => {
        let host = text;
        let pe: Prepared["pe"] = "";
        const m = PSEUDO_END.exec(host);
        if (m) {
          pe = m[1].toLowerCase() as Prepared["pe"];
          host = host.slice(0, m.index).trim();
          if (!host || TRAILING_COMBINATOR_RE.test(host)) host += "*";
        }
        if (OTHER_PSEUDO_ELEMENT_RE.test(host)) {
          skipped++;
          return; // other pseudo-elements: not element matches
        }
        const key = bucketKey(host);
        const list = buckets.get(key);
        const p = { rule: ri, sel: si, host, pe };
        if (list) list.push(p);
        else buckets.set(key, [p]);
      });
    });
    const tPrep = performance.now();

    const bad = new Set<string>();
    let matchCalls = 0;
    const observe = (el: Element, out: Observation[]) => {
      const lists: Prepared[][] = [];
      const add = (k: string) => {
        const l = buckets.get(k);
        if (l) lists.push(l);
      };
      if (el.id) add(`#${el.id}`);
      for (const c of Array.from(el.classList)) add(`.${c}`);
      add(el.localName);
      add("*");
      const byKind: Map<number, number[]>[] = [new Map(), new Map(), new Map()];
      for (const list of lists) {
        for (const p of list) {
          if (!active[p.rule] || bad.has(p.host)) continue;
          let ok = false;
          matchCalls++;
          try {
            ok = el.matches(p.host);
          } catch {
            bad.add(p.host);
          }
          if (!ok) continue;
          const kind = p.pe === "" ? 0 : p.pe === "before" ? 1 : 2;
          const sels = byKind[kind].get(p.rule);
          if (sels) {
            if (!sels.includes(p.sel)) sels.push(p.sel);
          } else byKind[kind].set(p.rule, [p.sel]);
        }
      }
      byKind.forEach((m, kind) => {
        if (m.size === 0) return;
        out.push([
          kind,
          [...m].map(([r, sels]) => [r, ...sels.sort((a, b) => a - b)]),
        ]);
      });
    };

    const out: Observation[] = [];
    const body = document.body;
    const all = Array.from(body.querySelectorAll("*"));
    for (const el of all) observe(el, out);

    if (states) {
      const targets = Array.from(body.querySelectorAll(INTERACTIVE)).slice(
        0,
        MAX_STATE_ELEMENTS,
      );
      for (const el of targets) {
        for (const names of Object.values(STATE_SETS)) {
          // Forced focus also makes ancestors match :focus-within (CDP parity).
          const within: Element[] = [];
          if (names.includes("focus"))
            for (let a: Element | null = el; a; a = a.parentElement)
              within.push(a);
          for (const n of names) el.setAttribute(`data-cr-${n}`, "");
          for (const a of within) a.setAttribute("data-cr-focus-within", "");
          observe(el, out);
          if (el.parentElement && el.parentElement !== body)
            observe(el.parentElement, out);
          const queue = Array.from(el.children);
          let n = 0;
          while (queue.length > 0 && n < MAX_STATE_DESCENDANTS) {
            const d = queue.shift() as Element;
            n++;
            observe(d, out);
            queue.push(...Array.from(d.children));
          }
          for (const n2 of names) el.removeAttribute(`data-cr-${n2}`);
          for (const a of within) a.removeAttribute("data-cr-focus-within");
        }
      }
    }
    return {
      observations: out,
      stats: {
        elements: all.length,
        skippedSelectors: skipped,
        invalid: bad.size,
        matchCalls,
        prepMs: tPrep - t0,
        matchMs: performance.now() - tPrep,
      },
    };
  },
};

(window as unknown as { __crDom: typeof api }).__crDom = api;

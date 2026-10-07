import { cascadeDiff, deadDeclarations, parseRules } from "crassus";
import { type CssNode, generate, parse, walk } from "css-tree";
import { canonicalText, type Node, parseStylesheet } from "../src/core/parse";
import { canonicalSelector } from "../src/core/selector";
import { generator, loose } from "./fuzz-gen";

// FUZZ_SEED=n FUZZ_RUNS=n for longer runs.
const SEED = Number(process.env.FUZZ_SEED ?? 12345);
const RUNS = Number(process.env.FUZZ_RUNS ?? 2000);

const STRAY_RE = /[;}]/;

interface Shape {
  preludes: string[];
  decls: string[];
}

interface Decl {
  start: number;
  text: string;
}

const inSourceOrder = (decls: Decl[]) =>
  decls.sort((a, b) => a.start - b.start).map((d) => d.text);

/** Style rule preludes and declarations in source order, as crassus reads them. */
function ours(css: string): Shape {
  const preludes: string[] = [];
  const decls: Decl[] = [];
  const visit = (list: Node[]) => {
    for (const node of list) {
      for (const d of node.decls ?? [])
        decls.push({
          start: d.start,
          // css-tree drops comments from values except custom properties'.
          text: `${d.property}|${d.important}|${loose(d.property.startsWith("--") ? d.raw : canonicalText(d.raw))}`,
        });
      if (node.kind === "rule") {
        let text = node.prelude;
        try {
          text = canonicalSelector(node.prelude);
        } catch {}
        preludes.push(loose(text));
      }
      if (node.rules) visit(node.rules);
    }
  };
  visit(parseStylesheet(css));
  return { preludes, decls: inSourceOrder(decls) };
}

/** The same, as css-tree reads them. */
function reference(css: string): Shape {
  const preludes: string[] = [];
  const decls: Decl[] = [];
  walk(parse(css, { positions: true }), {
    enter(node: CssNode) {
      // `@supports (display: grid)` is a condition, not a declaration.
      if (node.type === "AtrulePrelude") return walk.skip;
      if (node.type === "Rule") {
        // css-tree keeps a rule whose prelude swallowed a stray `;` or `}`;
        // browsers drop it (tests/parser.test.ts checks we do).
        const prelude = generate(node.prelude);
        if (node.prelude.type === "Raw" && STRAY_RE.test(prelude))
          return walk.skip;
        preludes.push(loose(prelude));
      } else if (node.type === "Declaration")
        decls.push({
          start: node.loc?.start.offset ?? 0,
          text: `${node.property}|${Boolean(node.important)}|${loose(generate(node.value))}`,
        });
    },
  });
  return { preludes, decls: inSourceOrder(decls) };
}

test(`fuzz against css-tree (seed ${SEED}, ${RUNS} sheets)`, () => {
  // css-tree doesn't read CSS nesting the way browsers do; the Chrome fuzz
  // in browser.test.ts covers it.
  const sheet = generator(SEED, {
    nesting: false,
    junk: true,
    truncate: true,
  });
  let matched = 0;
  let diverged = 0;
  for (let i = 0; i < RUNS; i++) {
    const { css, truncated, stray } = sheet();
    // Never throws, on anything.
    const rules = parseRules(css, true);
    deadDeclarations(css, true);
    cascadeDiff(rules, parseRules(css));
    for (const r of rules) {
      if (!r.loc || r.loc.line < 1 || r.loc.column < 0)
        throw new Error(`bad position in ${JSON.stringify(css)}`);
    }
    // css-tree skips a stray top-level token; browsers fold it into the
    // next rule's prelude and drop that rule (the Chrome fuzz covers it).
    if (stray) {
      diverged++;
      continue;
    }
    const a = ours(css);
    const b = reference(css);
    // A value cut off at the end: css-tree closes it (`url(x` -> `url(x)`)
    // or drops it (`red!`).
    if (truncated) {
      if (a.decls.length > b.decls.length) a.decls.pop();
      else if (a.decls.length === b.decls.length) {
        a.decls.pop();
        b.decls.pop();
      }
    }
    if (!Bun.deepEquals(a, b))
      console.error(`fuzz: differs for ${JSON.stringify(css)}`);
    expect(a).toEqual(b);
    matched++;
  }
  console.log(
    `fuzz: ${matched} matched css-tree, ${diverged} known divergences`,
  );
  expect(matched).toBeGreaterThan(RUNS * 0.8);
}, 600_000);

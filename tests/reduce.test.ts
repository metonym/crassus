// Delta debugging a stylesheet change: units, the edit script between two
// sheets, any subset applied, and ddmin's 1-minimal result.

import {
  applyEdits,
  cssUnits,
  ddmin,
  diffUnits,
  type Unit,
} from "../src/core/reduce";

const BASE = `@font-face { font-family: x; src: url(x.woff) }
.a { color: red; top: 0 }
@media (min-width: 1px) { .b { color: blue } }
@keyframes k { from { opacity: 0 } to { opacity: 1 } }
.c, .d { margin: 0 }`;
const HEAD = `@font-face { font-family: x; src: url(x.woff) }
.a { color: red }
@media (min-width: 1px) { .b { color: green } }
@keyframes k { from { opacity: 0 } to { opacity: 1 } }
.c, .d { margin: 0 }
.e { left: 1px !important }`;

const keyOf = (u: Unit) =>
  u.block ?? `${u.contexts.join("/")}|${u.selector}|${u.property}|${u.value}`;

describe("cssUnits", () => {
  it("splits a sheet into one declaration per selector, keyframes whole", () => {
    const { prelude, units } = cssUnits(BASE);
    expect(prelude).toBe("@font-face { font-family: x; src: url(x.woff) }");
    expect(units.map(keyOf)).toEqual([
      "|.a|color|red",
      "|.a|top|0",
      "@media (min-width:1px)|.b|color|blue",
      "@keyframes k { from { opacity: 0 }to { opacity: 1 } }",
      "|.c|margin|0",
      "|.d|margin|0",
    ]);
    expect(units[0].line).toBe(2);
  });
});

describe("diffUnits and applyEdits", () => {
  const base = cssUnits(BASE);
  const head = cssUnits(HEAD);
  const script = diffUnits(base.units, head.units);
  const edits = script.filter((s) => s.op !== "=");

  it("finds the declarations removed and added, in place", () => {
    expect(edits.map((s) => `${s.op} ${keyOf(s.unit)}`)).toEqual([
      "- |.a|top|0",
      "- @media (min-width:1px)|.b|color|blue",
      "+ @media (min-width:1px)|.b|color|green",
      "+ |.e|left|1px !important",
    ]);
  });

  it("applies none of them as base, all as head, any subset in between", () => {
    const all = new Set(edits.map((_, i) => i));
    expect(
      cssUnits(applyEdits(base.prelude, script, new Set())).units.map(keyOf),
    ).toEqual(base.units.map(keyOf));
    expect(
      cssUnits(applyEdits(base.prelude, script, all)).units.map(keyOf),
    ).toEqual(head.units.map(keyOf));
    const one = applyEdits(base.prelude, script, new Set([3]));
    expect(one).toContain(".e { left: 1px !important }");
    expect(one).toContain(".a { top: 0 }");
  });

  it("is a correct script on random sequences (seeded)", () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const unit = (n: number): Unit => ({
      contexts: [],
      selector: `.u${n}`,
      property: "color",
      value: "red",
    });
    const units = () =>
      Array.from({ length: Math.floor(rand() * 30) }, () =>
        unit(Math.floor(rand() * 8)),
      );
    for (let run = 0; run < 200; run++) {
      const a = units();
      const b = units();
      const steps = diffUnits(a, b);
      expect(
        steps.filter((s) => s.op !== "+").map((s) => keyOf(s.unit)),
      ).toEqual(a.map(keyOf));
      expect(
        steps.filter((s) => s.op !== "-").map((s) => keyOf(s.unit)),
      ).toEqual(b.map(keyOf));
    }
  });
});

describe("ddmin", () => {
  it("finds a 1-minimal subset that still fails", async () => {
    let tests = 0;
    const needs = new Set([3, 17, 40]);
    const items = Array.from({ length: 64 }, (_, i) => i);
    const fails = async (s: number[]) => {
      tests++;
      return [...needs].every((n) => s.includes(n));
    };
    expect(await ddmin(items, fails)).toEqual([3, 17, 40]);
    expect(tests).toBeLessThan(200);
  });

  it("returns a single cause in a few tests", async () => {
    let tests = 0;
    const r = await ddmin(
      Array.from({ length: 4224 }, (_, i) => i),
      async (s) => {
        tests++;
        return s.includes(2999);
      },
    );
    expect(r).toEqual([2999]);
    expect(tests).toBeLessThan(30);
  });
});

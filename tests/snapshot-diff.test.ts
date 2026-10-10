// Expectations follow carbon-components-svelte's `e2e/cascade-snapshot.ts
// diff`, run on seeded capture pairs: paths on one side only are counted,
// not diffed; changes group by (property, before -> after), most frequent
// first, ties in first-seen order, with the first three paths as examples.
// Unlike it, a property one side didn't record is listed, not a change.
import {
  decodeSnapshot,
  encodeSnapshot,
  parseSnapshotFile,
} from "../src/browser/snapshot";
import {
  diffSnapshot,
  groupChanges,
  type Snapshot,
} from "../src/core/snapshot-diff";

const WHITE = "rgb(255, 255, 255)";

describe("diffSnapshot", () => {
  it("is empty for identical snapshots", () => {
    const s: Snapshot = { "body>div": { color: "red", "margin-top": "0px" } };
    expect(diffSnapshot(s, structuredClone(s))).toEqual({
      changed: {},
      removed: [],
      added: [],
      uncompared: { onlyBase: [], onlyHead: [] },
    });
  });

  it("lists paths on one side without diffing them", () => {
    const base: Snapshot = {
      "body>div": { color: "red" },
      "body>div>p": { color: "red" },
    };
    const head: Snapshot = {
      "body>div": { color: "red" },
      "body>div>span": { color: "blue" },
    };
    expect(diffSnapshot(base, head)).toEqual({
      changed: {},
      removed: ["body>div>p"],
      added: ["body>div>span"],
      uncompared: { onlyBase: [], onlyHead: [] },
    });
  });

  it("compares only the properties both sides recorded", () => {
    // Head's stylesheets stopped declaring margin-top and started declaring
    // text-wrap: neither side has a value for the other's.
    const base: Snapshot = {
      a: { color: WHITE, "margin-top": "0px", top: "0px" },
      b: { color: WHITE, "margin-top": "0px", top: "0px" },
    };
    const head: Snapshot = {
      a: { color: "rgb(1, 2, 3)", top: "0px", "text-wrap": "balance" },
      b: { color: WHITE, top: "0px", "text-wrap": "wrap" },
    };
    expect(diffSnapshot(base, head)).toEqual({
      changed: {
        a: [{ property: "color", before: WHITE, after: "rgb(1, 2, 3)" }],
      },
      removed: [],
      added: [],
      uncompared: { onlyBase: ["margin-top"], onlyHead: ["text-wrap"] },
    });
  });
});

describe("groupChanges", () => {
  const recolor = (path: string) => ({
    [path]: [{ property: "color", before: WHITE, after: "rgb(1, 2, 3)" }],
  });

  it("groups a systematic change once, across pages", () => {
    const groups = groupChanges([
      {
        page: "button.g100.json",
        changed: {
          ...recolor("body>div>button.bx--btn--secondary"),
          "body>div": [{ property: "margin-top", before: "0px", after: "7px" }],
        },
      },
      {
        page: "button.white.json",
        changed: {
          ...recolor("body>div>button.bx--btn--primary@hover"),
          ...recolor("body>div>button.bx--btn--primary@focus"),
          "body>div>button.bx--btn--disabled": [
            { property: "color", before: "rgb(141, 141, 141)", after: WHITE },
          ],
        },
      },
    ]);
    expect(groups).toEqual([
      {
        property: "color",
        before: WHITE,
        after: "rgb(1, 2, 3)",
        count: 3,
        pages: ["button.g100.json", "button.white.json"],
        examples: [
          {
            page: "button.g100.json",
            path: "body>div>button.bx--btn--secondary",
          },
          {
            page: "button.white.json",
            path: "body>div>button.bx--btn--primary@hover",
          },
          {
            page: "button.white.json",
            path: "body>div>button.bx--btn--primary@focus",
          },
        ],
      },
      // Ties keep first-seen order.
      {
        property: "margin-top",
        before: "0px",
        after: "7px",
        count: 1,
        pages: ["button.g100.json"],
        examples: [{ page: "button.g100.json", path: "body>div" }],
      },
      {
        property: "color",
        before: "rgb(141, 141, 141)",
        after: WHITE,
        count: 1,
        pages: ["button.white.json"],
        examples: [
          {
            page: "button.white.json",
            path: "body>div>button.bx--btn--disabled",
          },
        ],
      },
    ]);
  });

  it("caps examples, not counts", () => {
    const changed = Object.assign(
      {},
      ...Array.from({ length: 5 }, (_, i) => recolor(`p[${i}]`)),
    );
    const [g] = groupChanges([{ page: "x.white.json", changed }], 2);
    expect(g.count).toBe(5);
    expect(g.examples.map((e) => e.path)).toEqual(["p[0]", "p[1]"]);
  });
});

describe("parseSnapshotFile", () => {
  it("reads fixture, theme and an optional viewport", () => {
    expect(parseSnapshotFile("button.g100.json")).toEqual({
      fixture: "button",
      theme: "g100",
    });
    expect(parseSnapshotFile("data-table.white.320x640.json.gz")).toEqual({
      fixture: "data-table",
      theme: "white",
      viewport: "320x640",
    });
  });
});

describe("encodeSnapshot", () => {
  it("round-trips, storing each distinct style once", () => {
    const red = { color: "red", "margin-top": "0px" };
    const snap: Snapshot = {
      "body>div": red,
      "body>div>p": { ...red },
      "body>div>p::before": { color: "blue", content: '"x"' },
      "body>div>p[1]": { ...red },
    };
    const bytes = encodeSnapshot(snap);
    const decoded = decodeSnapshot(bytes);
    expect(decoded).toEqual(snap);
    expect(Object.keys(decoded)).toEqual(Object.keys(snap));
    const file = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(bytes)));
    expect(file.props).toEqual(["color", "margin-top", "content"]);
    expect(file.styles).toEqual([
      ["red", "0px", null],
      ["blue", null, '"x"'],
    ]);
    expect(file.elements).toEqual([
      ["body>div", 0],
      ["body>div>p", 0],
      ["body>div>p::before", 1],
      ["body>div>p[1]", 0],
    ]);
  });
});

describe("folding", () => {
  const SIDES = ["top", "right", "bottom", "left"];
  const LOGICAL = ["block-start", "inline-end", "block-end", "inline-start"];
  const border = (color: string, width = "1px") =>
    Object.fromEntries(
      SIDES.flatMap((side, i) => [
        [`border-${side}-color`, color],
        [`border-${LOGICAL[i]}-color`, color],
        [`border-${side}-width`, width],
        [`border-${side}-style`, "solid"],
      ]),
    );
  const diff = (
    before: Record<string, string>,
    after: Record<string, string>,
  ) => diffSnapshot({ a: before }, { a: after }).changed.a;

  it("folds logical twins and a full longhand set into one change", () => {
    // One border color change: 8 changes before folding.
    expect(
      diff(
        { color: "black", ...border("red") },
        { color: "black", ...border("blue") },
      ),
    ).toEqual([
      {
        property: "border-color",
        before: "red",
        after: "blue",
        aliases: [
          "border-block-end-color",
          "border-block-start-color",
          "border-bottom-color",
          "border-inline-end-color",
          "border-inline-start-color",
          "border-left-color",
          "border-right-color",
          "border-top-color",
        ],
      },
    ]);
  });

  it("names a partial set by its shorthand, and follows direction", () => {
    const pad = (v: string, dir = "ltr") => ({
      direction: dir,
      "padding-top": v,
      "padding-block-start": v,
      "padding-bottom": v,
      "padding-right": "0px",
      "padding-inline-start": "0px",
    });
    expect(diff(pad("1px"), pad("2px"))).toEqual([
      {
        property: "padding-block",
        before: "1px",
        after: "2px",
        aliases: ["padding-block-start", "padding-bottom", "padding-top"],
      },
    ]);
    // In rtl, inline-start is the right side.
    const rtl = (v: string) => ({
      direction: "rtl",
      "padding-right": v,
      "padding-inline-start": v,
    });
    expect(diff(rtl("1px"), rtl("2px"))).toEqual([
      {
        property: "padding-right",
        before: "1px",
        after: "2px",
        aliases: ["padding-inline-start"],
      },
    ]);
    // A vertical writing mode: no physical twin to fold into.
    const vertical = (v: string) => ({
      "writing-mode": "vertical-rl",
      "padding-top": v,
      "padding-block-start": v,
    });
    expect(
      diff(vertical("1px"), vertical("2px")).map((c) => c.property),
    ).toEqual(["padding-top", "padding-block-start"]);
  });

  it("folds currentColor followers into the color change", () => {
    const el = (color: string) => ({
      color,
      "caret-color": color,
      "outline-color": color,
      "outline-style": "solid",
      ...border(color),
      "text-decoration-color": "green",
    });
    const [change, ...others] = diff(el("red"), el("blue"));
    expect(others).toEqual([]);
    expect(change).toMatchObject({
      property: "color",
      before: "red",
      after: "blue",
    });
    expect(change.aliases).toContain("caret-color");
    expect(change.aliases).toContain("outline-color");
    expect(change.aliases).toContain("border-inline-start-color");
    expect(change.aliases).toHaveLength(10);
  });

  it("marks changes no one can see", () => {
    const hidden = (color: string) => ({
      visibility: "hidden",
      color,
      width: color === "red" ? "1px" : "2px",
    });
    expect(diff(hidden("red"), hidden("blue"))).toEqual([
      {
        property: "color",
        before: "red",
        after: "blue",
        invisible: "visibility: hidden",
      },
      // Still takes space.
      { property: "width", before: "1px", after: "2px" },
    ]);
    const lines = (top: string, outline: string) => ({
      color: "black",
      "border-top-color": top,
      "border-top-width": "0px",
      "outline-color": outline,
      "outline-style": "none",
    });
    expect(diff(lines("red", "red"), lines("blue", "blue"))).toEqual([
      {
        property: "border-top-color",
        before: "red",
        after: "blue",
        invisible: "no border",
      },
      {
        property: "outline-color",
        before: "red",
        after: "blue",
        invisible: "outline-style: none",
      },
    ]);
    // Under an undisplayed ancestor, in a forced state too.
    const page = (color: string): Snapshot => ({
      "body>div.menu": { display: "none", color: "black" },
      "body>div.menu>ul>li@hover": { display: "block", color },
    });
    expect(
      diffSnapshot(page("red"), page("blue")).changed[
        "body>div.menu>ul>li@hover"
      ],
    ).toEqual([
      {
        property: "color",
        before: "red",
        after: "blue",
        invisible: "display: none",
      },
    ]);
  });

  it("groups invisible changes apart, and unions aliases", () => {
    const groups = groupChanges([
      {
        page: "p",
        changed: {
          a: [
            {
              property: "color",
              before: "red",
              after: "blue",
              aliases: ["caret-color"],
            },
          ],
          b: [
            {
              property: "color",
              before: "red",
              after: "blue",
              aliases: ["outline-color"],
            },
          ],
          c: [
            {
              property: "color",
              before: "red",
              after: "blue",
              invisible: "display: none",
            },
          ],
        },
      },
    ]);
    expect(groups.map((g) => [g.count, g.aliases, g.invisible])).toEqual([
      [2, ["caret-color", "outline-color"], undefined],
      [1, undefined, "display: none"],
    ]);
  });
});

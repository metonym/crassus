// Expectations follow carbon-components-svelte's `e2e/cascade-snapshot.ts
// diff`, run on seeded capture pairs: paths on one side only are counted,
// not diffed; a property gone in head reads as a change to nothing; changes
// group by (property, before -> after), most frequent first, ties in
// first-seen order, with the first three paths as examples.
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
    });
  });

  it("reports changed, dropped and new properties", () => {
    const base: Snapshot = {
      a: { color: WHITE, "margin-top": "0px", top: "0px" },
    };
    const head: Snapshot = {
      a: { color: "rgb(1, 2, 3)", top: "0px", "text-wrap": "balance" },
    };
    expect(diffSnapshot(base, head).changed).toEqual({
      a: [
        { property: "color", before: WHITE, after: "rgb(1, 2, 3)" },
        { property: "margin-top", before: "0px", after: null },
        // Not in the original tool, which only reads base's properties: a
        // property head's stylesheets start declaring is a change too.
        { property: "text-wrap", before: null, after: "balance" },
      ],
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
            { property: "color", before: "rgb(141, 141, 141)", after: null },
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
        after: null,
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

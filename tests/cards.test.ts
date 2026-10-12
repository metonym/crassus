// Change cards: one per root cause (the changed rule among the winners),
// with stable ids, a verdict and a fix from provenance.

import {
  approve,
  blocking,
  buildCards,
  buildReport,
  emptyApprovals,
  isApproved,
} from "../src/core/cards";
import {
  diffTokens,
  type PropertyChange,
  type Winner,
} from "../src/core/snapshot-diff";
import { shortHash } from "../src/core/util";

const rule = (selector: string, line: number, changed = false): Winner => ({
  selector,
  sheet: "css/_a.scss",
  line,
  ...(changed && { changed: true as const }),
});
const ID_RE = /^[0-9a-z]{6,10}$/;
const UA: Winner = { selector: "button", sheet: "user agent" };
const LOST = rule(".t .trigger", 148, true);

function page(
  file: string,
  elements: Record<
    string,
    {
      changes: PropertyChange[];
      explain?: Record<string, [Winner | null, Winner | null]>;
      pixels?: boolean;
      max?: number;
    }
  >,
) {
  return {
    file,
    changed: Object.fromEntries(
      Object.entries(elements).map(([p, e]) => [p, e.changes]),
    ),
    explain: Object.fromEntries(
      Object.entries(elements).map(([p, e]) => [
        p,
        Object.fromEntries(
          Object.entries(e.explain ?? {}).map(([prop, [base, head]]) => [
            prop,
            { base, head },
          ]),
        ),
      ]),
    ),
    pixels: Object.fromEntries(
      Object.entries(elements)
        .filter(([, e]) => e.pixels !== undefined)
        .map(([p, e]) => [p, Boolean(e.pixels)]),
    ),
    deltaE: Object.fromEntries(
      Object.entries(elements)
        .filter(([, e]) => e.max !== undefined)
        .map(([p, e]) => [p, { max: e.max ?? 0, mean: (e.max ?? 0) / 2 }]),
    ),
  };
}

/** Cards from one page, a.white. */
const cardsOn = (elements: Parameters<typeof page>[1]) =>
  buildCards([{ pages: [page("a.white", elements)] }]);

const color = (before = "rgb(22, 22, 22)", after = "rgb(0, 0, 0)") => ({
  property: "color",
  before,
  after,
});

describe("buildCards", () => {
  it("groups one lost rule's changes, over elements and pages, into one card", () => {
    const cards = buildCards([
      {
        pages: [
          page("a.white", {
            "body>button": {
              changes: [
                color(),
                { property: "position", before: "relative", after: "static" },
                // No winner of its own: it follows the element's position.
                { property: "inset", before: "0px", after: "auto" },
              ],
              explain: {
                color: [LOST, UA],
                position: [LOST, null],
                inset: [null, null],
              },
              pixels: true,
              max: 4.3,
            },
          }),
          page("b.white", {
            "body>div>button": {
              changes: [color()],
              explain: { color: [{ ...LOST, inherited: true }, UA] },
              pixels: true,
              max: 4.3,
            },
          }),
        ],
      },
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      verdict: "visible",
      cause: { kind: "lost", rule: LOST },
      pages: ["a.white", "b.white"],
      changes: [
        { property: "color", count: 2 },
        { property: "position", count: 1 },
        { property: "inset", count: 1 },
      ],
      deltaE: { max: 4.3 },
      fix: {
        file: "css/_a.scss",
        line: 148,
        selector: ".t .trigger",
        add: { color: "rgb(22, 22, 22)", position: "relative", inset: "0px" },
      },
    });
    expect(cards[0].title).toBe(
      "`.t .trigger` (css/_a.scss:148) no longer sets color, position, inset",
    );
  });

  it("calls a rule edited in place what it is, not lost to itself", () => {
    const tag = rule(".bx--tag", 20, true);
    const [card] = cardsOn({
      "body>span": {
        changes: [
          {
            property: "background-color",
            before: "rgb(255, 215, 217)",
            after: "rgb(255, 0, 0)",
          },
        ],
        explain: { "background-color": [tag, tag] },
        pixels: true,
      },
    });
    expect(card.cause).toEqual({ kind: "edited", rule: tag });
    expect(card.title).toBe(
      "`.bx--tag` (css/_a.scss:20) changes background-color from rgb(255, 215, 217) to rgb(255, 0, 0)",
    );
    expect(card.fix?.add).toEqual({ "background-color": "rgb(255, 215, 217)" });
  });

  it("names a rule that now wins, and the one it beat", () => {
    const won = rule(".override", 3, true);
    const [card] = cardsOn({
      "body>p": {
        changes: [color("rgb(1, 1, 1)", "rgb(2, 2, 2)")],
        explain: { color: [rule(".p", 1), won] },
      },
    });
    expect(card.cause).toEqual({ kind: "won", rule: won });
    expect(card.title).toBe(
      "`.override` (css/_a.scss:3) now sets color over `.p`",
    );
  });

  it("sets apart what no one can see, and what no one can tell apart", () => {
    const cards = cardsOn({
      "body>p": {
        changes: [color()],
        explain: { color: [LOST, UA] },
        pixels: true,
        max: 0.4,
      },
      "body>div": {
        changes: [{ ...color(), invisible: "display: none" }],
        explain: { color: [LOST, UA] },
      },
    });
    expect(cards.map((c) => [c.verdict, c.invisible])).toEqual([
      ["imperceptible", undefined],
      ["invisible", "display: none"],
    ]);
    expect(buildReport("compare", "a", "b", cards).summary).toEqual({
      "token-detached": 0,
      visible: 0,
      imperceptible: 1,
      invisible: 1,
      approved: 0,
    });
  });

  it("keeps a rule one cause whichever of its selectors matched", () => {
    const matchedBy = (selector: string) => {
      const of: Winner = {
        ...rule(selector, 17, true),
        list: ".assistive, .hidden",
      };
      return {
        changes: [{ ...color(), invisible: "clip: rect(0 0 0 0)" }],
        explain: { color: [of, of] } as Record<string, [Winner, Winner]>,
      };
    };
    const cards = cardsOn({
      "body>span": matchedBy(".hidden"),
      "body>span[1]": matchedBy(".hidden"),
      "body>div": matchedBy(".assistive"),
    });
    expect(cards).toHaveLength(1);
    expect(
      cards[0].title.startsWith("`.hidden, .assistive` (css/_a.scss:17)"),
    ).toBe(true);
    expect(cards[0].selectors).toEqual({ ".hidden": 2, ".assistive": 1 });
  });

  it("keeps one invisible card per cause, whatever hides each element", () => {
    const hidden = (why: string) => ({
      changes: [{ ...color(), invisible: why }],
      explain: { color: [LOST, UA] } as Record<string, [Winner, Winner]>,
    });
    const cards = cardsOn({
      "body>span": hidden("offscreen"),
      "body>span[1]": hidden("offscreen"),
      "body>label>span": hidden("clip: rect(0 0 0 0)"),
      "body>div>span": hidden("display: none"),
    });
    expect(
      cards.map((c) => [c.verdict, c.invisible, c.elements.length]),
    ).toEqual([
      ["invisible", "offscreen; clip: rect(0 0 0 0); display: none", 4],
    ]);
  });

  it("falls back to the winners, then to the values, without a changed rule", () => {
    const cards = buildCards([
      {
        pages: [
          page("a.white", {
            "body>p": {
              changes: [color()],
              explain: { color: [rule(".p", 1), rule(".q", 2)] },
            },
          }),
          { file: "b.white", changed: { "body>i": [color()] } },
        ],
      },
    ]);
    expect(cards.map((c) => c.cause.kind).sort()).toEqual(["shifted", "value"]);
    expect(cards.find((c) => c.cause.kind === "value")?.title).toBe(
      "color: rgb(22, 22, 22) -> rgb(0, 0, 0)",
    );
  });

  it("keeps a card's id when its rule moves to another line", () => {
    const at = (line: number) =>
      cardsOn({
        "body>p": {
          changes: [color()],
          explain: { color: [rule(".t .trigger", line, true), UA] },
        },
      })[0].id;
    expect(at(148)).toBe(at(160));
    expect(at(148)).toMatch(ID_RE);
  });

  it("carries bisect's commits", () => {
    const [card] = buildCards([
      {
        commits: [{ sha: "7e301af6f", subject: "chore(css): prune" }],
        commit: "7e301af6f",
        pages: [
          page("a.white", {
            "body>p": { changes: [color()], explain: { color: [LOST, UA] } },
          }),
        ],
      },
    ]);
    expect(card.commits).toEqual([
      { sha: "7e301af6f", subject: "chore(css): prune" },
    ]);
    expect(card.elements[0].commit).toBe("7e301af6f");
  });
});

it("shortHash is stable and short", () => {
  expect(shortHash("a")).toBe(shortHash("a"));
  expect(shortHash("a")).not.toBe(shortHash("b"));
});

describe("approvals", () => {
  const cards = () =>
    cardsOn({
      "body>p": { changes: [color()], explain: { color: [LOST, UA] } },
      "body>i": {
        changes: [{ property: "top", before: "0px", after: "1px" }],
        explain: { top: [rule(".i", 9, true), null] },
      },
    });

  it("approve records a card's changes, and covers only those", () => {
    const all = cards();
    const first = all.find((c) => c.changes[0].property === "color") ?? all[0];
    const second = all.find((c) => c !== first) ?? all[1];
    const approvals = approve(emptyApprovals(), [first]);
    expect(approvals.approved).toEqual([
      {
        id: first.id,
        title: first.title,
        changes: [color()],
      },
    ]);
    expect(isApproved(first, approvals)).toBe(true);
    expect(isApproved(second, approvals)).toBe(false);
    // Same cause, new values: not what was approved.
    const moved = {
      ...first,
      changes: [{ ...first.changes[0], after: "rgb(1, 1, 1)" }],
    };
    expect(isApproved(moved, approvals)).toBe(false);
    // Approving again replaces the entry.
    expect(approve(approvals, [moved, second]).approved).toHaveLength(2);
  });

  it("only visible, unapproved cards block", () => {
    const all = cards();
    const report = buildReport(
      "compare",
      "a",
      "b",
      all,
      approve(emptyApprovals(), [all[0]]),
    );
    expect(report.summary.approved).toBe(1);
    expect(blocking(report.cards).map((c) => c.id)).toEqual([all[1].id]);
  });
});

describe("token tracing", () => {
  it("diffTokens keeps what stopped following a token or follows others", () => {
    expect(
      diffTokens(
        {
          a: { color: ["--x-text"], "background-color": ["--x-bg"] },
          b: { color: ["--x-text"] },
          c: { color: ["--x-text"] },
        },
        { a: { color: ["--x-text"] }, b: { color: ["--x-ink"] } },
        { a: { "background-color": "rgb(1, 1, 1)" } },
      ),
    ).toEqual({
      a: {
        "background-color": {
          base: ["--x-bg"],
          head: [],
          value: "rgb(1, 1, 1)",
        },
      },
      b: { color: { base: ["--x-text"], head: ["--x-ink"] } },
      c: { color: { base: ["--x-text"], head: [] } },
    });
  });

  it("makes token-detached cards, even where the element is hidden, and blocks on them", () => {
    const traced = {
      ...page("a.white", {
        "body>p": {
          changes: [color()],
          explain: { color: [LOST, UA] },
        },
        "body>div": {
          changes: [{ ...color(), invisible: "display: none" }],
          explain: { color: [LOST, UA] },
        },
      }),
      tokens: {
        "body>p": { color: { base: ["--x-text"], head: [] } },
        "body>div": { color: { base: ["--x-text"], head: [] } },
        // No value change: a card of its own.
        "body>i": {
          "border-top-color": {
            base: ["--x-line"],
            head: [],
            value: "rgb(0, 0, 0)",
          },
        },
      },
    };
    const cards = buildCards([{ pages: [traced] }]);
    expect(cards.map((c) => [c.verdict, c.elements.length, c.title])).toEqual([
      [
        "token-detached",
        2,
        "`.t .trigger` (css/_a.scss:148) no longer sets color; `button` wins instead",
      ],
      ["token-detached", 1, "border-top-color no longer follows --x-line"],
    ]);
    expect(cards[0].tokens).toEqual({
      detached: 2,
      retokened: 0,
      from: ["--x-text"],
      to: [],
    });
    expect(blocking(cards)).toHaveLength(2);
  });
});

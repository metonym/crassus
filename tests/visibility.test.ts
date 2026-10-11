// What no one can see, analytically (computed values and recorded box
// geometry), and how far apart two screenshots look (CIEDE2000).

import { deflateSync } from "node:zlib";
import { crop, decodePng, difference } from "../src/browser/png";
import { ciede2000, deltaE, parseColor } from "../src/core/color";
import { diffSnapshot, type Snapshot } from "../src/core/snapshot-diff";

const BLACK = "rgb(0, 0, 0)";
const GRAY = "rgb(22, 22, 22)";

/** The reason each changed property of `key` is invisible ("" when it shows). */
function verdicts(
  base: Snapshot,
  head: Snapshot,
  key: string,
): Record<string, string> {
  return Object.fromEntries(
    (diffSnapshot(base, head).changed[key] ?? []).map((c) => [
      c.property,
      c.invisible ?? "",
    ]),
  );
}

describe("invisible changes", () => {
  // Screen-reader-only text, clipped to nothing and out of flow, moved.
  const assistive = (top: string, color: string) => ({
    "body>span": { position: "relative", color: BLACK, opacity: "1" },
    "body>span>div.bx--assistive-text": {
      position: "absolute",
      clip: "rect(0px, 0px, 0px, 0px)",
      top,
      color,
      width: "1px",
      height: "1px",
      "overflow-x": "hidden",
      "overflow-y": "hidden",
    },
    "body>span>div.bx--assistive-text>b": {
      position: "static",
      top: "auto",
      color,
    },
  });

  it("drops every change in an out-of-flow box clipped to nothing", () => {
    const base = assistive("-7px", GRAY);
    const head = assistive("876px", BLACK);
    const r = verdicts(base, head, "body>span>div.bx--assistive-text");
    expect(r).toEqual({
      top: "clip: rect(0 0 0 0)",
      color: "clip: rect(0 0 0 0)",
    });
    // Off the page too: still read as its clip, the same reason wherever it sits.
    const away = (top: string, color: string): Snapshot => {
      const r: Snapshot = assistive(top, color);
      r["body>span>div.bx--assistive-text"]["--cr-hidden"] = "offscreen";
      return r;
    };
    expect(
      verdicts(
        away("-7px", GRAY),
        away("-9999px", BLACK),
        "body>span>div.bx--assistive-text",
      ).color,
    ).toBe("clip: rect(0 0 0 0)");
    // Its contents are clipped with it.
    expect(
      verdicts(base, head, "body>span>div.bx--assistive-text>b").color,
    ).toBe("clip: rect(0 0 0 0)");
    // Unclipped on one side: it shows.
    const shown = assistive("876px", BLACK);
    Object.assign(shown["body>span>div.bx--assistive-text"], {
      clip: "auto",
      width: "120px",
      height: "40px",
    });
    expect(verdicts(base, shown, "body>span>div.bx--assistive-text").top).toBe(
      "",
    );
  });

  it("knows 1px boxes with hidden overflow and clip-path: inset(50%)", () => {
    const sr = (top: string, clip: string) => ({
      "body>p": {
        position: "absolute",
        clip,
        width: "1px",
        height: "1px",
        "overflow-x": "hidden",
        "overflow-y": "hidden",
        top,
      },
    });
    expect(verdicts(sr("0px", "auto"), sr("9px", "auto"), "body>p").top).toBe(
      "1px box, overflow: hidden",
    );
    // In flow, a box clipped by clip-path still takes its space.
    const inset = (top: string, color: string) => ({
      "body>p": { position: "static", "clip-path": "inset(50%)", top, color },
    });
    expect(verdicts(inset("0px", GRAY), inset("1px", BLACK), "body>p")).toEqual(
      { top: "", color: "clip-path: inset(50%)" },
    );
  });

  it("hides painted changes under opacity: 0, on it or an ancestor", () => {
    const page = (color: string, width: string) => ({
      "body>div": { opacity: "0", position: "static" },
      "body>div>p": { color, width, opacity: "1" },
    });
    expect(
      verdicts(page(GRAY, "10px"), page(BLACK, "20px"), "body>div>p"),
    ).toEqual({ color: "opacity: 0", width: "" });
  });

  it("hides a 0 × 0 box's own background and border", () => {
    const box = (bg: string, color: string) => ({
      "body>i": {
        width: "0px",
        height: "0px",
        "padding-top": "0px",
        "padding-right": "0px",
        "padding-bottom": "0px",
        "padding-left": "0px",
        "border-top-width": "0px",
        "border-right-width": "0px",
        "border-bottom-width": "0px",
        "border-left-width": "0px",
        "background-color": bg,
        color,
      },
    });
    expect(verdicts(box(GRAY, GRAY), box(BLACK, BLACK), "body>i")).toEqual({
      "background-color": "0×0 box",
      color: "",
    });
  });

  it("hides text drawn in its background's color", () => {
    const page = (color: string, bg: string) => ({
      "body>div": { "background-color": bg, "background-image": "none" },
      "body>div>p": {
        color,
        "background-color": "rgba(0, 0, 0, 0)",
        "background-image": "none",
      },
    });
    expect(
      verdicts(page(GRAY, GRAY), page(BLACK, BLACK), "body>div>p").color,
    ).toBe("text color equals the background");
    // Shown on one side.
    expect(
      verdicts(page(GRAY, GRAY), page(BLACK, GRAY), "body>div>p").color,
    ).toBe("");
  });

  it("takes the recorded geometry: offscreen, or clipped by an overflow ancestor", () => {
    const page = (color: string, top: string, position: string) => ({
      "body>p": { color, top, position, "--cr-hidden": "offscreen" },
    });
    expect(
      verdicts(
        page(GRAY, "1px", "static"),
        page(BLACK, "2px", "static"),
        "body>p",
      ),
    ).toEqual({ color: "offscreen", top: "" });
    expect(
      verdicts(
        page(GRAY, "1px", "absolute"),
        page(BLACK, "2px", "absolute"),
        "body>p",
      ),
    ).toEqual({ color: "offscreen", top: "offscreen" });
    // Not a style: never a change itself.
    const a = page(GRAY, "1px", "static");
    const b = page(GRAY, "1px", "static");
    b["body>p"]["--cr-hidden"] = "clipped by an overflow ancestor";
    expect(diffSnapshot(a, b).changed).toEqual({});
  });
});

describe("color", () => {
  it("parses computed colors", () => {
    expect(parseColor("rgb(1, 2, 3)")).toEqual([1, 2, 3, 1]);
    expect(parseColor("rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3, 0.5]);
    expect(parseColor("transparent")).toEqual([0, 0, 0, 0]);
    expect(parseColor("oklch(0.5 0.1 20)")).toBeNull();
  });

  it("matches Sharma, Wu and Dalal's CIEDE2000 test pairs", () => {
    const pairs: [
      [number, number, number],
      [number, number, number],
      number,
    ][] = [
      [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
      [[50, 0, 0], [50, -1, 2], 2.3669],
      [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
      [[50, 2.5, 0], [73, 25, -18], 27.1492],
      [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
      [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
    ];
    for (const [a, b, expected] of pairs)
      expect(ciede2000(a, b)).toBeCloseTo(expected, 4);
  });

  it("puts #161616 -> #000 at about 4", () => {
    expect(deltaE([22, 22, 22], [0, 0, 0])).toBeCloseTo(4.28, 2);
  });
});

/** A PNG with every scanline filter, as Chrome may write them. */
function png(width: number, rows: number[][], channels: 3 | 4): Uint8Array {
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(body, 8);
    return out; // the CRC isn't checked
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, rows.length);
  ihdr.set([8, channels === 4 ? 6 : 2, 0, 0, 0], 8);
  const stride = width * channels;
  const raw: number[] = [];
  rows.forEach((row, y) => {
    const filter = y % 5;
    raw.push(filter);
    const prev = y > 0 ? rows[y - 1] : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      const p = a + b - c;
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      const pred = [0, a, b, (a + b) >> 1, paeth][filter];
      raw.push((row[i] - pred) & 255);
    }
  });
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(new Uint8Array(raw))),
    chunk("IEND", new Uint8Array()),
  ];
  return Buffer.concat(parts);
}

describe("png", () => {
  const rows = (channels: number) =>
    Array.from({ length: 6 }, (_, y) =>
      Array.from({ length: 3 * channels }, (_, i) => (y * 37 + i * 91) & 255),
    );

  it("decodes RGBA through every filter", () => {
    const image = decodePng(png(3, rows(4), 4));
    expect(image).toMatchObject({ width: 3, height: 6 });
    expect([...image.data]).toEqual(rows(4).flat());
  });

  it("decodes RGB as opaque RGBA", () => {
    const image = decodePng(png(3, rows(3), 3));
    expect([...image.data.subarray(0, 8)]).toEqual([
      ...rows(3)[0].slice(0, 3),
      255,
      ...rows(3)[0].slice(3, 6),
      255,
    ]);
  });

  it("crops, and scores the pixels that differ", () => {
    const solid = (r: number, g: number, b: number) =>
      decodePng(
        png(
          4,
          Array.from({ length: 4 }, () =>
            Array.from({ length: 4 }, () => [r, g, b, 255]).flat(),
          ),
          4,
        ),
      );
    const gray = solid(22, 22, 22);
    const black = solid(0, 0, 0);
    expect(difference(gray, solid(22, 22, 22))).toBeNull();
    const d = difference(crop(gray, 1, 1, 2, 2), crop(black, 1, 1, 2, 2));
    expect(d?.pixels).toBe(4);
    expect(d?.max).toBeCloseTo(4.28, 2);
    expect(d?.mean).toBeCloseTo(4.28, 2);
    // Outside the image is transparent.
    expect([...crop(gray, 3, 3, 2, 1).data]).toEqual([
      22, 22, 22, 255, 0, 0, 0, 0,
    ]);
  });
});

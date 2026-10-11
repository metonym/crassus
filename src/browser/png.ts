// Decodes the PNGs Chrome's screenshots produce (8-bit RGB or RGBA,
// non-interlaced) into RGBA pixels, to crop and compare in memory.
import { deflateSync, inflateSync } from "node:zlib";
import { ciede2000, lab } from "../core/color";

export interface Image {
  width: number;
  height: number;
  /** RGBA, row by row. */
  data: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function decodePng(png: Uint8Array): Image {
  if (!SIGNATURE.every((b, i) => png[i] === b)) throw new Error("not a PNG");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const [depth, color, , , interlace] = body.subarray(8, 13);
      channels = color === 6 ? 4 : color === 2 ? 3 : 0;
      if (depth !== 8 || channels === 0 || interlace !== 0)
        throw new Error(
          `unsupported PNG: depth ${depth}, color type ${color}, interlace ${interlace}`,
        );
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rows.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rows.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[i] = v;
    }
  }
  if (channels === 4) return { width, height, data: rows };
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < rows.length; i += 3, j += 4) {
    data[j] = rows[i];
    data[j + 1] = rows[i + 1];
    data[j + 2] = rows[i + 2];
    data[j + 3] = 255;
  }
  return { width, height, data };
}

/** A rectangle of `image`, clamped to it; outside pixels are transparent. */
export function crop(
  image: Image,
  x: number,
  y: number,
  width: number,
  height: number,
): Image {
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const sy = y + row;
    if (sy < 0 || sy >= image.height) continue;
    const from = Math.max(0, x);
    const to = Math.min(image.width, x + width);
    if (to <= from) continue;
    data.set(
      image.data.subarray(
        (sy * image.width + from) * 4,
        (sy * image.width + to) * 4,
      ),
      (row * width + (from - x)) * 4,
    );
  }
  return { width, height, data };
}

export interface Difference {
  /** Pixels that differ. */
  pixels: number;
  /** CIEDE2000 over the pixels that differ: the largest, and the mean. */
  max: number;
  mean: number;
}

/** How two same-size images differ, pixel by pixel; null when they're the same. */
export function difference(a: Image, b: Image): Difference | null {
  const labs = new Map<number, [number, number, number]>();
  const labOf = (d: Uint8Array, i: number) => {
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    let v = labs.get(key);
    if (!v) {
      v = lab(d[i], d[i + 1], d[i + 2]);
      labs.set(key, v);
    }
    return v;
  };
  let pixels = 0;
  let max = 0;
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      a.data[i] === b.data[i] &&
      a.data[i + 1] === b.data[i + 1] &&
      a.data[i + 2] === b.data[i + 2] &&
      a.data[i + 3] === b.data[i + 3]
    )
      continue;
    pixels++;
    const d = ciede2000(labOf(a.data, i), labOf(b.data, i));
    sum += d;
    if (d > max) max = d;
  }
  return pixels === 0 ? null : { pixels, max, mean: sum / pixels };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** An RGBA PNG of `image` (each row filtered with "up"). */
export function encodePng(image: Image): Uint8Array {
  const { width, height, data } = image;
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 2;
    for (let i = 0; i < stride; i++)
      raw[y * (stride + 1) + 1 + i] =
        data[y * stride + i] - (y > 0 ? data[(y - 1) * stride + i] : 0);
  }
  return Buffer.concat([
    new Uint8Array(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}

/**
 * `head` faded to gray, with the pixels that differ from `base` in red,
 * stronger the farther apart they look. Sizes may differ: the overlap is
 * compared, the rest marked.
 */
export function heatmap(base: Image, head: Image): Image {
  const width = Math.max(base.width, head.width);
  const height = Math.max(base.height, head.height);
  const data = new Uint8Array(width * height * 4);
  const px = (im: Image, x: number, y: number) =>
    x < im.width && y < im.height ? (y * im.width + x) * 4 : -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const a = px(base, x, y);
      const b = px(head, x, y);
      const gray =
        b < 0
          ? 255
          : Math.round(
              (head.data[b] * 0.3 +
                head.data[b + 1] * 0.59 +
                head.data[b + 2] * 0.11) *
                0.35 +
                166,
            );
      let d = a < 0 || b < 0 ? 100 : 0;
      if (
        a >= 0 &&
        b >= 0 &&
        !(
          base.data[a] === head.data[b] &&
          base.data[a + 1] === head.data[b + 1] &&
          base.data[a + 2] === head.data[b + 2]
        )
      )
        d = ciede2000(
          lab(base.data[a], base.data[a + 1], base.data[a + 2]),
          lab(head.data[b], head.data[b + 1], head.data[b + 2]),
        );
      const t = d === 0 ? 0 : Math.min(1, 0.35 + d / 20);
      data.set(
        [
          Math.round(gray * (1 - t) + 230 * t),
          Math.round(gray * (1 - t) + 20 * t),
          Math.round(gray * (1 - t) + 40 * t),
          255,
        ],
        o,
      );
    }
  return { width, height, data };
}

// Colors as computed styles spell them, and how far apart two look:
// CIEDE2000 over CIELAB (D65), after Sharma, Wu and Dalal (2005).

export type Rgba = [r: number, g: number, b: number, a: number];

const RGB_RE =
  /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/;

/** `rgb()`/`rgba()` as `getComputedStyle` returns them (0–255, alpha 0–1); `transparent` too. */
export function parseColor(text: string): Rgba | null {
  const t = text.trim().toLowerCase();
  if (t === "transparent") return [0, 0, 0, 0];
  const m = RGB_RE.exec(t);
  if (!m) return null;
  const alpha =
    m[4] === undefined
      ? 1
      : m[4].endsWith("%")
        ? Number(m[4].slice(0, -1)) / 100
        : Number(m[4]);
  return [Number(m[1]), Number(m[2]), Number(m[3]), alpha];
}

const linear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const f = (t: number) =>
  t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116;

/** sRGB (0–255) to CIELAB, D65 white. */
export function lab(r: number, g: number, b: number): [number, number, number] {
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883;
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const DEG = Math.PI / 180;
const POW25_7 = 25 ** 7;

/** CIEDE2000 between two CIELAB colors (kL = kC = kH = 1). */
export function ciede2000(
  [l1, a1, b1]: [number, number, number],
  [l2, a2, b2]: [number, number, number],
): number {
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar7 = ((c1 + c2) / 2) ** 7;
  const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + POW25_7)));
  const ap1 = (1 + g) * a1;
  const ap2 = (1 + g) * a2;
  const cp1 = Math.hypot(ap1, b1);
  const cp2 = Math.hypot(ap2, b2);
  const hue = (b: number, ap: number) => {
    if (b === 0 && ap === 0) return 0;
    const h = Math.atan2(b, ap) / DEG;
    return h < 0 ? h + 360 : h;
  };
  const hp1 = hue(b1, ap1);
  const hp2 = hue(b2, ap2);
  const dL = l2 - l1;
  const dC = cp2 - cp1;
  let dh = 0;
  if (cp1 * cp2 !== 0) {
    dh = hp2 - hp1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin((dh / 2) * DEG);
  const lBar = (l1 + l2) / 2;
  const cBar = (cp1 + cp2) / 2;
  let hBar = hp1 + hp2;
  if (cp1 * cp2 !== 0) {
    if (Math.abs(hp1 - hp2) > 180) hBar += hBar < 360 ? 360 : -360;
    hBar /= 2;
  }
  const t =
    1 -
    0.17 * Math.cos((hBar - 30) * DEG) +
    0.24 * Math.cos(2 * hBar * DEG) +
    0.32 * Math.cos((3 * hBar + 6) * DEG) -
    0.2 * Math.cos((4 * hBar - 63) * DEG);
  const dTheta = 30 * Math.exp(-(((hBar - 275) / 25) ** 2));
  const cBarP7 = cBar ** 7;
  const rc = 2 * Math.sqrt(cBarP7 / (cBarP7 + POW25_7));
  const l50 = (lBar - 50) ** 2;
  const sl = 1 + (0.015 * l50) / Math.sqrt(20 + l50);
  const sc = 1 + 0.045 * cBar;
  const sh = 1 + 0.015 * cBar * t;
  const rt = -Math.sin(2 * dTheta * DEG) * rc;
  return Math.sqrt(
    (dL / sl) ** 2 +
      (dC / sc) ** 2 +
      (dH / sh) ** 2 +
      rt * (dC / sc) * (dH / sh),
  );
}

/** How far apart two sRGB colors look (CIEDE2000). */
export const deltaE = (
  x: [number, number, number],
  y: [number, number, number],
): number => ciede2000(lab(...x), lab(...y));

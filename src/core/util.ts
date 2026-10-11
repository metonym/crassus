export function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function intersects<T>(
  a: Iterable<T>,
  b: { has(value: T): boolean },
): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/** A short, stable id for `text` (FNV-1a, 64 bits as two 32-bit halves, base 36). */
export function shortHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (a >>> 7);
  }
  return ((a >>> 0).toString(36) + (b >>> 0).toString(36)).slice(0, 10);
}

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

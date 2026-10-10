/** What `resolvePath` needs of a DOM element: any DOM (browser, jsdom, linkedom). */
export interface PathElement {
  tagName: string;
  className: unknown;
  children: ArrayLike<PathElement>;
}

/**
 * The element a snapshot path names: `body>div.a.b[2]>p`, where `[n]` counts
 * earlier siblings with the same tag and class set, and a `@hover`,
 * `@focus^` or `::before` suffix is dropped. `root` is the `<html>` element
 * (`document.documentElement`). Self-contained, so it can be passed to
 * `page.evaluate` as it is.
 */
export function resolvePath<T extends PathElement>(
  path: string,
  root: T,
): T | null {
  // biome-ignore lint/performance/useTopLevelRegex: self-contained for page.evaluate
  const suffix = /(@(hover|focus|active)\^?)?(::before|::after)?$/;
  // biome-ignore lint/performance/useTopLevelRegex: self-contained for page.evaluate
  const space = /\s+/;
  const target = path.replace(suffix, "");
  const sig = (el: PathElement) => {
    const cls = typeof el.className === "string" ? el.className.trim() : "";
    return (
      el.tagName.toLowerCase() +
      (cls ? `.${cls.split(space).sort().join(".")}` : "")
    );
  };
  // Tried against the real children, as a class name may contain `>`.
  const walk = (el: T, rest: string): T | null => {
    const seen = new Map<string, number>();
    for (let i = 0; i < el.children.length; i++) {
      const child = el.children[i] as T;
      const s = sig(child);
      const nth = seen.get(s) ?? 0;
      seen.set(s, nth + 1);
      const part = nth ? `${s}[${nth}]` : s;
      if (rest === part) return child;
      if (rest.startsWith(`${part}>`)) {
        const found = walk(child, rest.slice(part.length + 1));
        if (found) return found;
      }
    }
    return null;
  };
  return walk(root, target);
}

/** The library sheet among a page's sheets: the largest that contains `marker`. */
export function librarySheet<T extends { text: string | null | undefined }>(
  sheets: T[],
  marker: string,
): (T & { text: string }) | undefined {
  let best: (T & { text: string }) | undefined;
  for (const s of sheets)
    if (s.text?.includes(marker) && (!best || s.text.length > best.text.length))
      best = s as T & { text: string };
  return best;
}

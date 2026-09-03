export const DEFAULT_CONTEXT_BUDGET_CHARS = 120_000;

/**
 * Retains the newest part of text with an explicit marker instead of silently
 * dropping context. This is intentionally character based: it is provider
 * neutral and avoids claiming token precision we do not have.
 */
export function compactContextText(text: string, maxCharacters = DEFAULT_CONTEXT_BUDGET_CHARS): string {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) {
    throw new Error("Context budget must be a positive integer.");
  }
  if (text.length <= maxCharacters) return text;
  const markerFor = (omitted: number): string => `[context compacted; omitted ${omitted} characters]\n`;
  if (maxCharacters < markerFor(text.length).length) return markerFor(text.length).slice(0, maxCharacters);
  let retained = Math.max(0, maxCharacters - markerFor(text.length).length);
  for (;;) {
    const omitted = text.length - retained;
    const marker = markerFor(omitted);
    const nextRetained = Math.max(0, maxCharacters - marker.length);
    if (nextRetained === retained) return `${marker}${text.slice(-retained)}`;
    retained = nextRetained;
  }
}

export function compactContextParts(parts: readonly string[], maxCharacters = DEFAULT_CONTEXT_BUDGET_CHARS): string[] {
  let remaining = maxCharacters;
  const result: string[] = [];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const compacted = compactContextText(parts[index] ?? "", Math.max(1, remaining));
    result.unshift(compacted);
    remaining -= compacted.length;
    if (remaining <= 0) {
      for (let omitted = index - 1; omitted >= 0; omitted -= 1) result.unshift("[context compacted; omitted earlier item]");
      break;
    }
  }
  return result;
}

export function normalizeMemoryLookupText(text: string): string {
  let normalized = text.trim();
  if (!normalized) return "";

  const firstNonEmptyLine = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstNonEmptyLine) normalized = firstNonEmptyLine;

  normalized = normalized.replace(/^\S+\s+\[[^\]]+\]\s+/u, "");
  normalized = normalized.replace(/^(\[[^\]]+\])\s+\1(\s+|$)/, "$1 ");

  return normalized.trim();
}

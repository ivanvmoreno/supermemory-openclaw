export function normalizeEntityAliasText(text: string): string {
  return text
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

export function foldEntityAliasText(text: string): string {
  return normalizeEntityAliasText(text)
    .normalize("NFD")
    .replace(/\p{Mark}+/gu, "");
}

export function tokenizeEntityAliasText(text: string): string[] {
  return foldEntityAliasText(text)
    .split(/[^-\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

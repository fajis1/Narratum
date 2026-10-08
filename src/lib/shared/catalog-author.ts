/** Catalog placeholders are not author suggestions and must not replace a name. */
export function catalogAuthor(value: unknown): string {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  return /^(?:unknown(?: author)?|n\/a)$/iu.test(name) ? '' : name;
}

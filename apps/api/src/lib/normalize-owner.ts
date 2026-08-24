/**
 * Normalize owner to simple title case ("jane doe" → "Jane Doe").
 * Returns null if input is null/undefined/empty.
 */
export function normalizeOwner(owner: string | null | undefined): string | null {
  if (!owner) return null;
  return owner
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

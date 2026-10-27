import type { DisplayMode } from '../types/domain';

/** "Shreya Mehta" → "S. M."; null for an empty name. Matches public.name_initials() in SQL. */
export function initialsOf(fullName: string): string | null {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return parts.map((part) => `${part.charAt(0).toUpperCase()}.`).join(' ');
}

/**
 * The name other investors see for a review or signature: the full name, initials, or nothing
 * for anonymous entries (they are counted but never identified).
 */
export function displayNameFor(fullName: string, mode: DisplayMode): string | null {
  const name = fullName.trim();
  if (mode === 'ANONYMOUS' || name === '') return null;
  return mode === 'FULL_NAME' ? name : initialsOf(name);
}

/**
 * The theme registry: every theme the Settings control offers. Each id names
 * one `[data-theme='…']` token block in `src/index.css`; adding a theme is a
 * block there plus an entry here.
 */
export const THEMES = [
  { id: 'brand', label: 'Brand', note: 'follows the system light/dark setting' },
  { id: 'matrix', label: 'Matrix', note: 'dark only' },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

export const DEFAULT_THEME: ThemeId = 'brand';

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

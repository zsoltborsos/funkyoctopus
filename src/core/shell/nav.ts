import type { ShellView } from './shell.types.ts';

export interface NavItem {
  view: ShellView;
  label: string;
  glyph: string;
}

/** The views, as the rail and the switcher name them. */
export const NAV: NavItem[] = [
  { view: 'chat', label: 'Chat', glyph: '›_' },
  { view: 'jobs', label: 'Helmraiser', glyph: '⧉' },
  { view: 'prompts', label: 'Prompts', glyph: '❯' },
  { view: 'settings', label: 'Settings', glyph: '⚙' },
];

/**
 * Light / dark theme.
 *
 * The choice is a browser preference, not project data, so it lives here and
 * not in the editor store: it must not end up in a saved project, an export or
 * a run snapshot.
 *
 * Light is the default: it is the look Aparecium is designed around, so a first
 * visit always shows the intended thing rather than depending on an operating
 * system setting the user may not associate with this app. Once someone picks a
 * theme, that choice wins on every later visit.
 */
import { create } from 'zustand';

export type ThemeName = 'light' | 'dark';

const STORAGE_KEY = 'aparecium.theme';

function readStored(): ThemeName | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    // Private browsing can refuse localStorage; fall through to the default.
    return null;
  }
}

export function resolveInitialTheme(): ThemeName {
  return readStored() ?? 'light';
}

/** Light is the absence of the attribute, so the default needs no JavaScript. */
export function applyTheme(theme: ThemeName): void {
  const root = document.documentElement;
  if (theme === 'dark') root.dataset.theme = 'dark';
  else delete root.dataset.theme;
}

interface ThemeState {
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;
  toggle: () => void;
}

export const useTheme = create<ThemeState>((set, get) => ({
  theme: 'light',
  setTheme(theme) {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Not being able to remember the choice is not worth failing over.
    }
    set({ theme });
  },
  toggle() {
    get().setTheme(get().theme === 'dark' ? 'light' : 'dark');
  },
}));

/** Called once at start-up, before React renders, to avoid a flash. */
export function initTheme(): void {
  const theme = resolveInitialTheme();
  applyTheme(theme);
  useTheme.setState({ theme });
}

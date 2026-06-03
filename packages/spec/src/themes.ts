export interface ThemeCatalogEntry {
  brand: string;
  mode: string;
  /** Theme CSS filename within the tokens directory (e.g. theme-retail-light.css). */
  cssFile: string;
}

export interface ThemeSelection {
  brand: string;
  mode: string;
}

/** Repo theme tokens discovered at connect time — not tied to a specific design system. */
export interface ThemeCatalog {
  /** Repo-relative tokens directory containing primitives + theme CSS files. */
  tokensDir?: string;
  /** HTML attributes used to activate a theme (e.g. data-brand, data-theme). */
  attributes: string[];
  entries: ThemeCatalogEntry[];
  default?: ThemeSelection;
}

export interface PreviewThemeContext {
  brand?: string;
  mode?: string;
}

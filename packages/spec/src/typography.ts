/** A single typography token from the team repo (size, weight, family, etc.). */
export interface TypographyScaleEntry {
  name: string;
  usage: string;
  fontSize?: number;
  fontWeight?: number;
  lineHeight?: number;
  letterSpacing?: number;
  fontFamily?: string;
}

export interface TypographyCatalog {
  fontPaths: string[];
  families: Record<string, string>;
  scales: TypographyScaleEntry[];
}

export interface TypographyConfig {
  fontPaths: string[];
  catalog: TypographyCatalog;
}

/** Raw typography read from a Figma TEXT node before token matching. */
export interface FigmaTextTypography {
  fontSize?: number;
  fontWeight?: number;
  fontFamily?: string;
  fontStyle?: string;
  lineHeight?: number;
  letterSpacing?: number;
}

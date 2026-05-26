import type { FigmaTextTypography, TypographyCatalog } from "@fig2code/spec";

const FONT_SIZE_TOLERANCE_PX = 1;
const LINE_HEIGHT_TOLERANCE_PX = 1;
const LETTER_SPACING_TOLERANCE_PX = 0.5;

export function matchTypographyToTokens(
  typography: FigmaTextTypography,
  catalog: TypographyCatalog | undefined,
): Record<string, string> {
  if (!catalog) {
    return rawTypographyTokens(typography);
  }

  const tokens: Record<string, string> = {};

  if (typography.fontSize != null) {
    const match = findClosestScale(catalog.scales, "fontSize", typography.fontSize, FONT_SIZE_TOLERANCE_PX);
    tokens.fontSize = match
      ? `token:typography/${match.name}`
      : `token:typography/raw/${round(typography.fontSize)}px`;
  }

  if (typography.fontWeight != null) {
    const match = findClosestScale(
      catalog.scales,
      "fontWeight",
      typography.fontWeight,
      0,
      typography.fontSize,
    );
    tokens.fontWeight = match
      ? `token:typography/${match.name}`
      : `token:typography/raw/${typography.fontWeight}`;
  }

  if (typography.fontFamily) {
    const familyMatch = matchFontFamily(typography.fontFamily, catalog);
    if (familyMatch?.scale) {
      tokens.fontFamily = `token:typography/${familyMatch.name}`;
    } else if (familyMatch) {
      tokens.fontFamily = `token:typography/family/${familyMatch.name}`;
    } else {
      tokens.fontFamily = `token:typography/raw/${sanitizeFamily(typography.fontFamily)}`;
    }
  }

  if (typography.lineHeight != null) {
    const match = findClosestScale(
      catalog.scales,
      "lineHeight",
      typography.lineHeight,
      LINE_HEIGHT_TOLERANCE_PX,
    );
    tokens.lineHeight = match
      ? `token:typography/${match.name}`
      : `token:typography/raw/${round(typography.lineHeight)}px`;
  }

  if (typography.letterSpacing != null) {
    const match = findClosestScale(
      catalog.scales,
      "letterSpacing",
      typography.letterSpacing,
      LETTER_SPACING_TOLERANCE_PX,
    );
    tokens.letterSpacing = match
      ? `token:typography/${match.name}`
      : `token:typography/raw/${round(typography.letterSpacing)}px`;
  }

  return tokens;
}

function rawTypographyTokens(typography: FigmaTextTypography): Record<string, string> {
  const tokens: Record<string, string> = {};

  if (typography.fontSize != null) {
    tokens.fontSize = `token:typography/raw/${round(typography.fontSize)}px`;
  }
  if (typography.fontWeight != null) {
    tokens.fontWeight = `token:typography/raw/${typography.fontWeight}`;
  }
  if (typography.fontFamily) {
    tokens.fontFamily = `token:typography/raw/${sanitizeFamily(typography.fontFamily)}`;
  }
  if (typography.lineHeight != null) {
    tokens.lineHeight = `token:typography/raw/${round(typography.lineHeight)}px`;
  }
  if (typography.letterSpacing != null) {
    tokens.letterSpacing = `token:typography/raw/${round(typography.letterSpacing)}px`;
  }

  return tokens;
}

function findClosestScale(
  scales: TypographyCatalog["scales"],
  key: "fontSize" | "fontWeight" | "lineHeight" | "letterSpacing",
  value: number,
  tolerance: number,
  fontSizeHint?: number,
): TypographyCatalog["scales"][number] | undefined {
  let best: TypographyCatalog["scales"][number] | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const scale of scales) {
    const candidate = scale[key];
    if (candidate == null) continue;
    if (key === "fontWeight" && fontSizeHint != null && scale.fontSize != null) {
      if (Math.abs(scale.fontSize - fontSizeHint) > FONT_SIZE_TOLERANCE_PX) {
        continue;
      }
    }

    const distance = Math.abs(candidate - value);
    if (distance > tolerance && key !== "fontWeight") continue;
    if (distance < bestDistance) {
      best = scale;
      bestDistance = distance;
    }
  }

  return best;
}

function matchFontFamily(
  family: string,
  catalog: TypographyCatalog,
): { name: string; scale?: true } | undefined {
  const normalized = primaryFontFamily(family);

  const familyScale = catalog.scales.find(
    (scale) =>
      scale.fontFamily && primaryFontFamily(scale.fontFamily) === normalized,
  );
  if (familyScale) {
    return { name: familyScale.name, scale: true };
  }

  for (const [name, value] of Object.entries(catalog.families)) {
    if (primaryFontFamily(value) === normalized) {
      return { name };
    }
  }

  return undefined;
}

function primaryFontFamily(value: string): string {
  return sanitizeFamily(value.split(",")[0] ?? value);
}

function sanitizeFamily(value: string): string {
  return value.trim().replace(/['"]/g, "").toLowerCase();
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function parseFontWeightFromStyle(style?: string): number | undefined {
  if (!style) return undefined;

  const normalized = style.toLowerCase();
  if (normalized.includes("thin")) return 100;
  if (normalized.includes("extra light") || normalized.includes("extralight")) return 200;
  if (normalized.includes("light")) return 300;
  if (normalized.includes("regular") || normalized === "normal") return 400;
  if (normalized.includes("medium")) return 500;
  if (normalized.includes("semi bold") || normalized.includes("semibold")) return 600;
  if (normalized.includes("bold")) return 700;
  if (normalized.includes("extra bold") || normalized.includes("extrabold")) return 800;
  if (normalized.includes("black")) return 900;

  const numeric = Number.parseInt(normalized, 10);
  return Number.isFinite(numeric) ? numeric : undefined;
}

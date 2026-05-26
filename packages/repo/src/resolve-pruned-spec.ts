import type { LayoutNode, PrunedSpec, StyleSystem, TokenCatalog } from "@fig2code/spec";
import { findColorEntryByHex, rgbToHex } from "./tokens.js";

const TOKEN_REF = /token:[^\s]+/g;

export interface ResolvePrunedSpecOptions {
  styleSystem?: StyleSystem;
  tokenCatalog?: TokenCatalog;
}

/** Replace token: references in pruned_spec with Tailwind classes before LLM codegen. */
export function resolvePrunedSpecTokens(
  spec: PrunedSpec,
  tokenResolver: Record<string, string>,
  options: ResolvePrunedSpecOptions = {},
): PrunedSpec {
  const { styleSystem, tokenCatalog } = options;

  return {
    ...spec,
    styles: spec.styles ? resolveStyleMap(spec.styles, tokenResolver, styleSystem, tokenCatalog) : undefined,
    typography: spec.typography
      ? resolveStyleMap(spec.typography, tokenResolver, styleSystem, tokenCatalog)
      : undefined,
    layout: spec.layout ? resolveLayoutNode(spec.layout, tokenResolver, styleSystem, tokenCatalog) : undefined,
  };
}

function resolveStyleMap(
  styles: Record<string, Record<string, string>>,
  tokenResolver: Record<string, string>,
  styleSystem?: StyleSystem,
  tokenCatalog?: TokenCatalog,
): Record<string, Record<string, string>> {
  const resolved: Record<string, Record<string, string>> = {};

  for (const [variantKey, styleEntry] of Object.entries(styles)) {
    resolved[variantKey] = resolveTokenRecord(styleEntry, tokenResolver, styleSystem, tokenCatalog);
  }

  return resolved;
}

function resolveLayoutNode(
  node: LayoutNode,
  tokenResolver: Record<string, string>,
  styleSystem?: StyleSystem,
  tokenCatalog?: TokenCatalog,
): LayoutNode {
  return {
    ...node,
    typography: node.typography
      ? resolveTokenRecord(node.typography, tokenResolver, styleSystem, tokenCatalog)
      : undefined,
    children: node.children?.map((child) =>
      resolveLayoutNode(child, tokenResolver, styleSystem, tokenCatalog),
    ),
  };
}

function resolveTokenRecord(
  record: Record<string, string>,
  tokenResolver: Record<string, string>,
  styleSystem?: StyleSystem,
  tokenCatalog?: TokenCatalog,
): Record<string, string> {
  const resolved: Record<string, string> = {};

  for (const [property, value] of Object.entries(record)) {
    resolved[property] = resolveTokenString(value, property, tokenResolver, styleSystem, tokenCatalog);
  }

  return resolved;
}

function resolveTokenString(
  value: string,
  propertyKey: string,
  tokenResolver: Record<string, string>,
  styleSystem?: StyleSystem,
  tokenCatalog?: TokenCatalog,
): string {
  return value.replace(TOKEN_REF, (ref) =>
    resolveTokenReference(ref, propertyKey, tokenResolver, styleSystem, tokenCatalog),
  );
}

function resolveTokenReference(
  ref: string,
  propertyKey: string,
  tokenResolver: Record<string, string>,
  styleSystem?: StyleSystem,
  tokenCatalog?: TokenCatalog,
): string {
  if (!ref.startsWith("token:")) {
    return ref;
  }

  const key = ref.slice("token:".length);
  const mapped = tokenResolver[key];

  if (key.startsWith("color/")) {
    if (mapped) {
      const prefix = colorUtilityPrefix(propertyKey);
      return `${prefix}-${mapped}`;
    }
    return resolveColor(key, propertyKey, styleSystem, tokenCatalog);
  }

  if (mapped) {
    return mapped;
  }

  if (key.startsWith("spacing/")) {
    return resolveSpacing(key, propertyKey, styleSystem);
  }

  if (key.startsWith("radius/")) {
    return resolveRadius(key, styleSystem);
  }

  return ref;
}

function resolveColor(
  key: string,
  propertyKey: string,
  styleSystem?: StyleSystem,
  tokenCatalog?: TokenCatalog,
): string {
  const prefix = colorUtilityPrefix(propertyKey);

  if (key.startsWith("color/raw/")) {
    const raw = key.slice("color/raw/".length);
    const channels = raw.split("-").map((part) => Number.parseInt(part, 10));
    if (channels.length === 3 && channels.every((ch) => Number.isFinite(ch))) {
      if (tokenCatalog) {
        const hex = rgbToHex(channels[0]!, channels[1]!, channels[2]!);
        const entry = findColorEntryByHex(hex, tokenCatalog);
        if (entry) {
          return styleSystem === "tailwind" ? `${prefix}-${entry.usage}` : entry.usage;
        }
      }
      return `${prefix}-[rgb(${channels[0]},${channels[1]},${channels[2]})]`;
    }
    return `${prefix}-${raw}`;
  }

  // Variable name was captured directly from Figma — use it as the class name
  const tokenName = key.slice("color/".length);
  return `${prefix}-${tokenName}`;
}

function resolveSpacing(
  key: string,
  propertyKey: string,
  styleSystem?: StyleSystem,
): string {
  if (key.startsWith("spacing/raw/")) {
    const raw = key.slice("spacing/raw/".length);
    if (styleSystem === "tailwind") {
      const px = Number.parseInt(raw, 10);
      if (Number.isFinite(px)) {
        return `[${px}px]`;
      }
    }
    return raw;
  }

  // Variable name from Figma — use directly as the Tailwind spacing value
  const tokenName = key.slice("spacing/".length);
  if (propertyKey === "gap") {
    return `gap-${tokenName}`;
  }
  return tokenName;
}

function resolveRadius(key: string, styleSystem?: StyleSystem): string {
  if (key.startsWith("radius/raw/")) {
    const raw = key.slice("radius/raw/".length);
    if (styleSystem === "tailwind") {
      return `rounded-[${raw}]`;
    }
    return raw;
  }

  // Variable name from Figma — use directly
  const tokenName = key.slice("radius/".length);
  return `rounded-${tokenName}`;
}

function colorUtilityPrefix(propertyKey: string): string {
  if (propertyKey === "bg") return "bg";
  if (propertyKey === "border") return "border";
  return "text";
}

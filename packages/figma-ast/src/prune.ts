import type { LayoutNode, PrunedSpec, TokenCatalog, TypographyCatalog } from "@fig2code/spec";
import {
  camelCase,
  isIconPropertyName,
  normalizePropertyDefinitions,
  parseVariantName,
  propertyBaseName,
  sanitizeComponentName,
  slugifyValue,
} from "./property-utils.js";
import type { FigmaNodeSnapshot } from "./snapshot.js";
import { matchTypographyToTokens } from "./typography.js";
import { matchColorToToken, matchRadiusToToken, matchSpacingToToken } from "./token-match.js";

export type { FigmaNodeSnapshot } from "./snapshot.js";

export interface PruneOptions {
  /** Drop invisible / zero-opacity nodes. Default true. */
  dropHidden?: boolean;
  /** Max depth for layout tree. Default 5. */
  maxLayoutDepth?: number;
  /** Team typography catalog from setup — used to map Figma text styles to tokens. */
  typography?: TypographyCatalog;
  /** Team design token catalog from setup — colors, spacing, radius, etc. */
  tokenCatalog?: TokenCatalog;
}

const LAYOUT_SKIP_TYPES = new Set([
  "VECTOR",
  "STAR",
  "LINE",
  "ELLIPSE",
  "POLYGON",
  "BOOLEAN_OPERATION",
]);

/**
 * Transforms raw Figma node trees into a clean PrunedSpec.
 * Generic rules only — no component-name branches.
 */
export function pruneNodeTree(
  root: FigmaNodeSnapshot,
  options: PruneOptions = {},
): PrunedSpec {
  const { dropHidden = true, maxLayoutDepth = 5, typography, tokenCatalog } = options;
  const propertyDefs = normalizePropertyDefinitions(root.componentPropertyDefinitions);

  const variants = extractVariants(propertyDefs);
  const props = extractProps(propertyDefs);
  const slots = extractSlots(root, propertyDefs, props, dropHidden);
  const styles = extractStyles(root, propertyDefs, variants, typography, tokenCatalog);
  const textTypography = extractTextTypography(root, props, dropHidden, typography, tokenCatalog);
  const layout = extractLayout(root, dropHidden, maxLayoutDepth, typography, props, tokenCatalog);

  return {
    name: sanitizeComponentName(root.name),
    kind: "component",
    variants: Object.keys(variants).length > 0 ? variants : undefined,
    props: Object.keys(props).length > 0 ? props : undefined,
    slots: Object.keys(slots).length > 0 ? slots : undefined,
    styles: Object.keys(styles).length > 0 ? styles : undefined,
    typography: Object.keys(textTypography).length > 0 ? textTypography : undefined,
    layout,
    metadata: {
      figmaNodeId: root.id,
    },
  };
}

type PropertyDefEntry = ReturnType<typeof normalizePropertyDefinitions>[number];

function extractVariants(
  propertyDefs: PropertyDefEntry[],
): NonNullable<PrunedSpec["variants"]> {
  const result: NonNullable<PrunedSpec["variants"]> = {};

  for (const { propName, def } of propertyDefs) {
    if (def.type === "VARIANT" && def.variantOptions?.length) {
      result[propName] = def.variantOptions.map(String);
    }
  }

  return result;
}

function extractProps(
  propertyDefs: PropertyDefEntry[],
): NonNullable<PrunedSpec["props"]> {
  const props: NonNullable<PrunedSpec["props"]> = {};

  for (const { propName, def } of propertyDefs) {
    if (def.type === "BOOLEAN") {
      props[propName] = {
        type: "boolean",
        default: def.defaultValue ?? false,
      };
    }

    if (def.type === "TEXT") {
      props[propName] = {
        type: "text",
        default: def.defaultValue ?? "",
      };
    }
  }

  return props;
}

function extractSlots(
  root: FigmaNodeSnapshot,
  propertyDefs: PropertyDefEntry[],
  props: NonNullable<PrunedSpec["props"]>,
  dropHidden: boolean,
): NonNullable<PrunedSpec["slots"]> {
  const slots: NonNullable<PrunedSpec["slots"]> = {};

  for (const { baseName, propName, def } of propertyDefs) {
    if (def.type !== "INSTANCE_SWAP") continue;

    const defaultKey =
      typeof def.defaultValue === "string" ? def.defaultValue : undefined;
    const preferred = def.preferredValues?.[0];

    slots[propName] = {
      type: isIconPropertyName(baseName) ? "icon" : "instance",
      optional: true,
      componentKey: defaultKey ?? preferred?.key,
      componentName: preferred?.name
        ? sanitizeComponentName(preferred.name)
        : undefined,
    };
  }

  walk(root, dropHidden, (child) => {
    if (child.type === "TEXT" && child.characters) {
      const slotName = inferTextSlotName(child, props);
      if (slotName && !slots[slotName]) {
        slots[slotName] = { type: "text", required: !props[slotName] };
      }
    }

    if (child.type === "INSTANCE" && child.mainComponent?.name) {
      const slotName = camelCase(child.name);
      if (slots[slotName]) return;

      slots[slotName] = {
        type: isIconPropertyName(child.name) ? "icon" : "instance",
        optional: true,
        componentName: sanitizeComponentName(child.mainComponent.name),
        componentKey: child.mainComponent.key,
      };
    }
  });

  return slots;
}

function inferTextSlotName(
  node: FigmaNodeSnapshot,
  props: NonNullable<PrunedSpec["props"]>,
): string | undefined {
  const refs = node.componentPropertyReferences ?? {};
  for (const refKey of Object.keys(refs)) {
    if (refs[refKey] !== "characters") continue;
    const propName = camelCase(propertyBaseName(refKey));
    if (props[propName]?.type === "text") {
      return propName;
    }
  }

  const layerName = camelCase(node.name);
  if (layerName && layerName !== "text") {
    return layerName;
  }

  if (!Object.values(props).some((p) => p.type === "text")) {
    return "label";
  }

  return undefined;
}

function extractStyles(
  root: FigmaNodeSnapshot,
  propertyDefs: PropertyDefEntry[],
  variants: NonNullable<PrunedSpec["variants"]>,
  typography?: TypographyCatalog,
  tokenCatalog?: TokenCatalog,
): NonNullable<PrunedSpec["styles"]> {
  const variantComponents = (root.children ?? []).filter(
    (child) => child.type === "COMPONENT",
  );

  if (variantComponents.length > 0) {
    const styles: NonNullable<PrunedSpec["styles"]> = {};

    for (const variantNode of variantComponents) {
      const parsed =
        variantNode.variantValues ?? parseVariantName(variantNode.name);
      const styleKey = buildVariantStyleKey(parsed, propertyDefs, variants);
      const styleEntry = {
        ...readNodeStyles(variantNode, tokenCatalog),
        ...readDominantTextStyle(variantNode, typography, tokenCatalog),
      };

      if (Object.keys(styleEntry).length > 0) {
        styles[styleKey] = styleEntry;
      }
    }

    if (Object.keys(styles).length > 0) {
      return styles;
    }
  }

  return readFallbackStyles(root, propertyDefs, variants, typography, tokenCatalog);
}

function buildVariantStyleKey(
  parsed: Record<string, string>,
  propertyDefs: PropertyDefEntry[],
  variants: NonNullable<PrunedSpec["variants"]>,
): string {
  const variantPropNames = propertyDefs
    .filter(({ def }) => def.type === "VARIANT")
    .map(({ propName }) => propName);

  if (variantPropNames.length === 0) {
    const values = Object.values(parsed).map(slugifyValue).filter(Boolean);
    return values.length > 0 ? values.join("+") : "default";
  }

  const parts = variantPropNames.map((propName) => {
    const raw = parsed[propName];
    if (raw) return slugifyValue(raw);

    const options = variants[propName];
    return options?.[0] ? slugifyValue(String(options[0])) : "default";
  });

  return parts.join("+");
}

function readFallbackStyles(
  root: FigmaNodeSnapshot,
  propertyDefs: PropertyDefEntry[],
  variants: NonNullable<PrunedSpec["variants"]>,
  typography?: TypographyCatalog,
  tokenCatalog?: TokenCatalog,
): NonNullable<PrunedSpec["styles"]> {
  const styles: NonNullable<PrunedSpec["styles"]> = {};
  const variantPropNames = propertyDefs
    .filter(({ def }) => def.type === "VARIANT")
    .map(({ propName }) => propName);
  const variantCombo =
    variantPropNames.length > 0
      ? variantPropNames
          .map((name) => {
            const first = variants[name]?.[0];
            return first ? slugifyValue(String(first)) : "default";
          })
          .join("+")
      : "default";

  const styleEntry = {
    ...readNodeStyles(root, tokenCatalog),
    ...readDominantTextStyle(root, typography, tokenCatalog),
  };
  if (Object.keys(styleEntry).length > 0) {
    styles[`${variantCombo}+default`] = styleEntry;
  }

  return styles;
}

function readDominantTextStyle(
  node: FigmaNodeSnapshot,
  typography?: TypographyCatalog,
  tokenCatalog?: TokenCatalog,
): Record<string, string> {
  let target: FigmaNodeSnapshot | undefined;

  walk(node, false, (child) => {
    if (child.type === "TEXT" && child.typography && !target) {
      target = child;
    }
  });

  if (!target?.typography) {
    return {};
  }

  const styleTokens = matchTypographyToTokens(target.typography, typography);
  const fill = target.fills?.find((entry) => entry.type === "SOLID" && entry.color);
  if (fill?.color) {
    styleTokens.text = matchColorToToken(fill.color, tokenCatalog, fill.colorToken);
  }

  return styleTokens;
}

function extractTextTypography(
  root: FigmaNodeSnapshot,
  props: NonNullable<PrunedSpec["props"]>,
  dropHidden: boolean,
  typography?: TypographyCatalog,
  tokenCatalog?: TokenCatalog,
): NonNullable<PrunedSpec["typography"]> {
  const roles: NonNullable<PrunedSpec["typography"]> = {};

  walk(root, dropHidden, (child) => {
    if (child.type !== "TEXT" || !child.typography) return;

    const role = inferTextSlotName(child, props);
    if (!role || roles[role]) return;

    const styleTokens = matchTypographyToTokens(child.typography, typography);
    const fill = child.fills?.find((entry) => entry.type === "SOLID" && entry.color);
    if (fill?.color) {
      styleTokens.text = matchColorToToken(fill.color, tokenCatalog, fill.colorToken);
    }

    if (Object.keys(styleTokens).length > 0) {
      roles[role] = styleTokens;
    }
  });

  return roles;
}

function readNodeStyles(
  node: FigmaNodeSnapshot,
  tokenCatalog?: TokenCatalog,
): Record<string, string> {
  const styleEntry: Record<string, string> = {};

  const fill = node.fills?.find((f) => f.type === "SOLID" && f.color);
  if (fill?.color) {
    styleEntry.bg = matchColorToToken(fill.color, tokenCatalog, fill.colorToken);
  }

  if (node.cornerRadius != null) {
    styleEntry.radius = matchRadiusToToken(node.cornerRadius, tokenCatalog, node.cornerRadiusToken);
  }

  if (
    node.paddingTop != null ||
    node.paddingRight != null ||
    node.paddingBottom != null ||
    node.paddingLeft != null
  ) {
    const pt = node.paddingTokens?.top;
    const pr = node.paddingTokens?.right;
    const pb = node.paddingTokens?.bottom;
    const pl = node.paddingTokens?.left;
    styleEntry.padding = [
      matchSpacingToToken(node.paddingTop ?? 0, tokenCatalog, pt),
      matchSpacingToToken(node.paddingRight ?? 0, tokenCatalog, pr),
      matchSpacingToToken(node.paddingBottom ?? 0, tokenCatalog, pb),
      matchSpacingToToken(node.paddingLeft ?? 0, tokenCatalog, pl),
    ].join(" ");
  }

  if (node.layoutMode && node.layoutMode !== "NONE") {
    styleEntry.layout = node.layoutMode.toLowerCase();
  }

  if (node.itemSpacing != null) {
    styleEntry.gap = matchSpacingToToken(node.itemSpacing, tokenCatalog, node.itemSpacingToken);
  }

  return styleEntry;
}

function extractLayout(
  root: FigmaNodeSnapshot,
  dropHidden: boolean,
  maxDepth: number,
  typography: TypographyCatalog | undefined,
  props: NonNullable<PrunedSpec["props"]>,
  tokenCatalog?: TokenCatalog,
): LayoutNode | undefined {
  return buildLayoutNode(root, dropHidden, maxDepth, 0, typography, props, tokenCatalog);
}

function buildLayoutNode(
  node: FigmaNodeSnapshot,
  dropHidden: boolean,
  maxDepth: number,
  depth: number,
  typography: TypographyCatalog | undefined,
  props: NonNullable<PrunedSpec["props"]>,
  tokenCatalog?: TokenCatalog,
): LayoutNode | undefined {
  if (dropHidden && node.visible === false) {
    return undefined;
  }

  const layoutNode: LayoutNode = {
    name: node.name,
    type: node.type,
    role: camelCase(node.name) || undefined,
    hidden: node.visible === false ? true : undefined,
  };

  if (node.type === "TEXT" && node.typography) {
    const role = inferTextSlotName(node, props);
    if (role) {
      layoutNode.role = role;
    }
    const styleTokens = matchTypographyToTokens(node.typography, typography);
    const fill = node.fills?.find((entry) => entry.type === "SOLID" && entry.color);
    if (fill?.color) {
      styleTokens.text = matchColorToToken(fill.color, tokenCatalog, fill.colorToken);
    }
    if (Object.keys(styleTokens).length > 0) {
      layoutNode.typography = styleTokens;
    }
  }

  if (depth >= maxDepth) {
    return layoutNode;
  }

  const childLayouts: LayoutNode[] = [];
  for (const child of node.children ?? []) {
    if (LAYOUT_SKIP_TYPES.has(child.type)) continue;

    const childLayout = buildLayoutNode(
      child,
      dropHidden,
      maxDepth,
      depth + 1,
      typography,
      props,
      tokenCatalog,
    );
    if (childLayout) {
      childLayouts.push(childLayout);
    }
  }

  if (childLayouts.length > 0) {
    layoutNode.children = childLayouts;
  }

  return layoutNode;
}

function walk(
  node: FigmaNodeSnapshot,
  dropHidden: boolean,
  visit: (node: FigmaNodeSnapshot) => void,
): void {
  if (dropHidden && node.visible === false) return;

  visit(node);
  for (const child of node.children ?? []) {
    walk(child, dropHidden, visit);
  }
}

export { sanitizeComponentName } from "./property-utils.js";
export { pruneNodeTree as default };

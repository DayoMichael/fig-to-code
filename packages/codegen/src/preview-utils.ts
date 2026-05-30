import type { JobBuildPreview } from "@fig2code/spec";

export interface StoryPreviewTarget {
  componentName: string;
  args: Record<string, unknown>;
  storyName: string;
}

const COMPONENT_NAME_UTILITY_SUFFIX_RE =
  /(Variants?|Styles?|Classes?|ClassName|Config|Defaults?|Tokens?|Theme|Schema|Map|Registry|Options?|Recipe)$/i;

const PASCAL_CASE_RE = /^[A-Z][A-Za-z0-9_]*$/;

const TYPE_ONLY_EXPORT_SUFFIX_RE = /(?:Props|Element|Type|Ref)$/;

const COMPOUND_SUBPART_SUFFIX_RE =
  /(?:Trigger|Content|Viewport|Header|Footer|Title|Description|Item|Group|Panel|Handle|Indicator|Label|Value|Anchor|Arrow|Close|Cancel|Action|Overlay|Portal|List|Input|Separator|Thumb|Track|Icon|Smart|Field|Form)$/;

/**
 * Identify the React component declaration the preview should render.
 *
 * Compound files (Select, Dialog, Tooltip, …) often declare sub-part
 * forwardRefs before the root export. Prefer the export block / filename
 * fallback over the first forwardRef match.
 */
export function extractComponentName(source: string, fallback: string): string {
  const exportNames = parseExportBlockNames(source);

  const fallbackFromExports = pickExportName(exportNames, fallback, source);
  if (fallbackFromExports) {
    return fallbackFromExports;
  }

  const strongPatterns: RegExp[] = [
    /export\s+const\s+([A-Z]\w*)\s*=\s*(?:React\.)?forwardRef\b/,
    /export\s+const\s+([A-Z]\w*)\s*=\s*(?:React\.)?memo\b/,
    /(?:^|\n)\s*const\s+([A-Z]\w*)\s*=\s*(?:React\.)?forwardRef\b/,
    /(?:^|\n)\s*const\s+([A-Z]\w*)\s*=\s*(?:React\.)?memo\b/,
    /export\s+function\s+([A-Z]\w*)/,
    /export\s+default\s+function\s+([A-Z]\w*)/,
    /(?:^|\n)\s*function\s+([A-Z]\w*)/,
    /(?:^|\n)\s*class\s+([A-Z]\w*)/,
  ];

  for (const pattern of strongPatterns) {
    const match = source.match(pattern);
    const name = match?.[1];
    if (
      name &&
      !looksLikeUtility(name) &&
      !isCompoundSubpartName(name, fallback, exportNames)
    ) {
      return name;
    }
  }

  const defaultIdentifier = source.match(/export\s+default\s+([A-Z]\w*)\s*;?/);
  if (defaultIdentifier?.[1] && !looksLikeUtility(defaultIdentifier[1])) {
    return defaultIdentifier[1];
  }

  const pascalConstPattern =
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Z]\w*)\s*=/g;
  for (
    let match = pascalConstPattern.exec(source);
    match;
    match = pascalConstPattern.exec(source)
  ) {
    const name = match[1];
    if (
      name &&
      !looksLikeUtility(name) &&
      !isCompoundSubpartName(name, fallback, exportNames)
    ) {
      return name;
    }
  }

  if (PASCAL_CASE_RE.test(fallback) && sourceDeclaresIdentifier(source, fallback)) {
    return fallback;
  }

  return fallback;
}

/** Parse `export { A, B, type C }` names in source order. */
export function parseExportBlockNames(source: string): string[] {
  const blockMatch = source.match(/export\s*\{([\s\S]*?)\}\s*;?/);
  if (!blockMatch?.[1]) {
    return [];
  }

  const names: string[] = [];
  for (const match of blockMatch[1].matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)) {
    const name = match[1]!;
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

function pickExportName(
  exportNames: string[],
  fallback: string,
  source: string,
): string | null {
  if (exportNames.length === 0) {
    return null;
  }

  const exact = exportNames.find((name) => name === fallback);
  if (exact && isExportableComponentName(exact) && isLikelyRootComponent(source, exact)) {
    return exact;
  }

  const caseInsensitive = exportNames.find(
    (name) => name.toLowerCase() === fallback.toLowerCase(),
  );
  if (
    caseInsensitive &&
    isExportableComponentName(caseInsensitive) &&
    isLikelyRootComponent(source, caseInsensitive)
  ) {
    return caseInsensitive;
  }

  const prefixMatch = exportNames.find(
    (name) =>
      name.startsWith(fallback) &&
      isExportableComponentName(name) &&
      isLikelyRootComponent(source, name),
  );
  if (prefixMatch) {
    return prefixMatch;
  }

  for (const name of exportNames) {
    if (
      isExportableComponentName(name) &&
      !isProviderOrContextExport(name) &&
      !isCompoundSubpartName(name, fallback, exportNames) &&
      isLikelyRootComponent(source, name)
    ) {
      return name;
    }
  }

  return null;
}

function isExportableComponentName(name: string): boolean {
  if (!PASCAL_CASE_RE.test(name)) {
    return false;
  }
  if (looksLikeUtility(name)) {
    return false;
  }
  if (TYPE_ONLY_EXPORT_SUFFIX_RE.test(name)) {
    return false;
  }
  return true;
}

function isProviderOrContextExport(name: string): boolean {
  return /(?:Provider|Context|Consumer)$/.test(name);
}

function isCompoundSubpartName(
  name: string,
  fallback: string,
  exportNames: string[],
): boolean {
  if (name === fallback) {
    return false;
  }
  if (exportNames.includes(fallback)) {
    return COMPOUND_SUBPART_SUFFIX_RE.test(name);
  }
  return COMPOUND_SUBPART_SUFFIX_RE.test(name) && name !== fallback;
}

function isLikelyRootComponent(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rootPattern = new RegExp(
    `(?:const|let|var)\\s+${escaped}\\s*=\\s*[\\w.]+(?:\\.Root|Primitive\\.Root)\\b`,
  );
  if (rootPattern.test(source)) {
    return true;
  }
  return sourceDeclaresIdentifier(source, name);
}

function looksLikeUtility(name: string): boolean {
  if (!PASCAL_CASE_RE.test(name)) return true;
  return COMPONENT_NAME_UTILITY_SUFFIX_RE.test(name);
}

function sourceDeclaresIdentifier(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|\\W)(?:const|let|var|function|class)\\s+${escaped}\\b`);
  return pattern.test(source);
}

/** Returns true if the component source uses a default export for the main component. */
export function isDefaultExport(source: string, componentName: string): boolean {
  if (/export\s+default\s+(?:function|class)\s/.test(source)) return true;
  const defaultIdRe = new RegExp(`export\\s+default\\s+${componentName}\\s*;?`);
  return defaultIdRe.test(source);
}

export function argsFromVariants(variants?: Record<string, string[]>): Record<string, unknown> {
  if (!variants) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(variants).map(([key, values]) => [key, values[0] ?? ""]),
  );
}

export function argsFromVariantSelection(
  variants: Record<string, string[]> | undefined,
  selected: Record<string, string> | undefined,
): Record<string, unknown> {
  if (!variants) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(variants).map(([key, values]) => {
      const picked = selected?.[key];
      const value = picked && values.includes(picked) ? picked : (values[0] ?? "");
      return [key, value];
    }),
  );
}

export function parsePreviewVariantQuery(
  query: Record<string, string | undefined>,
  variants?: Record<string, string[]>,
): Record<string, string> | undefined {
  if (!variants || Object.keys(variants).length === 0) {
    return undefined;
  }

  const selected: Record<string, string> = {};
  for (const [key, allowed] of Object.entries(variants)) {
    const value = query[key];
    if (value && allowed.includes(value)) {
      selected[key] = value;
    } else if (allowed[0]) {
      selected[key] = allowed[0];
    }
  }

  return selected;
}

export function formatVariantSelectionLabel(selected: Record<string, string>): string {
  return Object.entries(selected)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

export function enrichPreviewArgs(
  fromVariants: Record<string, unknown>,
  componentName: string,
): Record<string, unknown> {
  if (Object.keys(fromVariants).length === 0) {
    return { children: componentName };
  }

  return {
    ...fromVariants,
    title: fromVariants.title ?? "Preview title",
    message: fromVariants.message ?? "Preview message",
    label: fromVariants.label ?? "Preview label",
    children: fromVariants.children ?? componentName,
  };
}

export function defaultPreviewArgs(preview: JobBuildPreview): Record<string, unknown> {
  const args = resolveInitialPreviewArgs(
    preview.variants ?? {},
    preview.propControls ?? [],
    preview.componentContent,
    preview.storyContent,
  );
  return enrichPreviewArgs(args, preview.componentName);
}

/** Pick the primary story export to preview (Default first, then first Story export). */
export function pickDefaultStoryExportName(storyContent: string): string {
  if (/\bexport const Default\b/.test(storyContent)) {
    return "Default";
  }

  for (const match of storyContent.matchAll(
    /\bexport const ([A-Z][A-Za-z0-9_]*)\s*:\s*Story\b/g,
  )) {
    const name = match[1]!;
    if (name !== "Default") {
      return name;
    }
  }

  for (const match of storyContent.matchAll(
    /\bexport const ([A-Z][A-Za-z0-9_]*)\s*=\s*\{/g,
  )) {
    const name = match[1]!;
    if (!name.endsWith("Props") && name !== "meta") {
      return name;
    }
  }

  return "Default";
}

export function extractHandlerPropNames(source: string): string[] {
  const names = new Set<string>();

  for (const match of source.matchAll(/\bon([A-Z][A-Za-z0-9_]*)\b/g)) {
    names.add(`on${match[1]}`);
  }

  return [...names].sort();
}

/** Keep only valid CSS blocks from mixed token excerpts (config JS + CSS variables). */
export function extractInjectedTokenCss(tokenCss: string): string {
  const blocks = tokenCss.match(/:root\s*\{[\s\S]*?\}/g) ?? [];
  return blocks.join("\n\n");
}

export function collectCssVariableNames(tokenCss: string): string[] {
  const names = new Set<string>();

  const declPattern = /--([\w-]+)\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = declPattern.exec(tokenCss)) !== null) {
    names.add(match[1]!);
  }

  const refPattern = /var\(--([\w-]+)\)/g;
  while ((match = refPattern.exec(tokenCss)) !== null) {
    names.add(match[1]!);
  }

  return [...names];
}

const TAILWIND_COLOR_CLASS_PATTERN =
  /\b(?:bg|text|border|from|to|via|ring|outline|decoration|fill|stroke|caret|accent)-[\w-]+/g;

const COLOR_UTILITY_PROPERTIES: Record<string, string> = {
  bg: "background-color",
  text: "color",
  border: "border-color",
  from: "--tw-gradient-from",
  to: "--tw-gradient-to",
  via: "--tw-gradient-via",
  ring: "--tw-ring-color",
  outline: "outline-color",
  decoration: "text-decoration-color",
  fill: "fill",
  stroke: "stroke",
  caret: "caret-color",
  accent: "accent-color",
};

export function extractTailwindColorClasses(...sources: string[]): string[] {
  const classes = new Set<string>();

  for (const source of sources) {
    for (const match of source.matchAll(TAILWIND_COLOR_CLASS_PATTERN)) {
      classes.add(match[0]!);
    }
  }

  return [...classes];
}

export function buildTokenColorUtilityCss(tokenCss: string, sources: string[]): string {
  const varNames = new Set(collectCssVariableNames(tokenCss));
  if (varNames.size === 0) {
    return "";
  }

  const rules: string[] = [];
  for (const className of extractTailwindColorClasses(...sources)) {
    const rule = colorUtilityRuleForClass(className, varNames);
    if (rule) {
      rules.push(rule);
    }
  }

  return rules.join("\n");
}

function colorUtilityRuleForClass(className: string, varNames: Set<string>): string | null {
  const match = className.match(
    /^(bg|text|border|from|to|via|ring|outline|decoration|fill|stroke|caret|accent)-(.+)$/,
  );
  if (!match) {
    return null;
  }

  const utility = match[1]!;
  const tokenName = match[2]!;
  if (!varNames.has(tokenName)) {
    return null;
  }

  const property = COLOR_UTILITY_PROPERTIES[utility];
  if (!property) {
    return null;
  }

  return `.${className} { ${property}: var(--${tokenName}); }`;
}

export function buildTailwindConfigFromTokenCss(tokenCss: string, safelistClasses: string[] = []): string {
  const colors: Record<string, string> = {};

  for (const varName of collectCssVariableNames(tokenCss)) {
    colors[varName] = `var(--${varName})`;
  }

  if (Object.keys(colors).length === 0 && safelistClasses.length === 0) {
    return "{}";
  }

  return JSON.stringify({
    safelist: safelistClasses,
    theme: {
      extend: {
        colors,
      },
    },
  });
}

function skipString(source: string, start: number): number {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") {
    return start;
  }
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === quote && source[i - 1] !== "\\") {
      return i + 1;
    }
  }
  return source.length;
}

function extractBalancedBraces(source: string, start: number): string | null {
  if (source[start] !== "{") {
    return null;
  }

  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(source, i) - 1;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  return null;
}

function extractObjectLiteralAfterKey(source: string, key: string): string | null {
  const keyIndex = source.indexOf(key);
  if (keyIndex === -1) {
    return null;
  }
  const braceStart = source.indexOf("{", keyIndex + key.length);
  if (braceStart === -1) {
    return null;
  }
  return extractBalancedBraces(source, braceStart);
}

function parseObjectLiteralKeys(objectLiteral: string): string[] {
  const body = objectLiteral.trim().replace(/^\{/, "").replace(/\}$/, "");
  const keys: string[] = [];
  const pattern = /(?:^|[,{])\s*([A-Za-z_][\w]*)\s*:/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    keys.push(match[1]!);
  }
  return keys;
}

function parseTopLevelVariantAxes(objectLiteral: string): Record<string, string[]> {
  const body = objectLiteral.trim().replace(/^\{/, "").replace(/\}$/, "");
  const axes: Record<string, string[]> = {};
  const axisPattern = /([\w-]+)\s*:\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = axisPattern.exec(body)) !== null) {
    const axis = match[1]!;
    const braceStart = match.index! + match[0].length - 1;
    const nested = extractBalancedBraces(body, braceStart);
    if (!nested) {
      continue;
    }
    const values = parseObjectLiteralKeys(nested);
    if (values.length > 0) {
      axes[axis] = values;
    }
    axisPattern.lastIndex = braceStart + nested.length;
  }

  return axes;
}

/** Extract CVA variant axes from a component source file. */
export function extractCvaVariantAxes(source: string): Record<string, string[]> {
  const named = source.match(/\w+Variants\s*=\s*cva\s*\(/);
  const generic = source.match(/\bcva\s*\(/);
  const anchor = named?.index ?? generic?.index;
  if (anchor == null) {
    return {};
  }

  const slice = source.slice(anchor);
  const variantsBlock = extractObjectLiteralAfterKey(slice, "variants:");
  if (!variantsBlock) {
    return {};
  }

  return parseTopLevelVariantAxes(variantsBlock);
}

/** Extract CVA default variant values from a component source file. */
export function extractCvaDefaultVariants(source: string): Record<string, string> {
  const named = source.match(/\w+Variants\s*=\s*cva\s*\(/);
  const generic = source.match(/\bcva\s*\(/);
  const anchor = named?.index ?? generic?.index;
  if (anchor == null) {
    return {};
  }

  const slice = source.slice(anchor);
  const defaultsBlock = extractObjectLiteralAfterKey(slice, "defaultVariants:");
  if (!defaultsBlock) {
    return {};
  }

  const defaults: Record<string, string> = {};
  for (const match of defaultsBlock.matchAll(
    /([\w-]+)\s*:\s*(['"])(.*?)\2/g,
  )) {
    defaults[match[1]!] = match[3]!;
  }
  return defaults;
}

/** Extract Storybook argTypes select options from a story file. */
export function extractStoryArgTypeOptions(source: string): Record<string, string[]> {
  const metaIndex = source.search(/\bconst\s+meta\b/);
  const slice = metaIndex >= 0 ? source.slice(metaIndex) : source;
  const argTypesBlock = extractObjectLiteralAfterKey(slice, "argTypes:");
  if (!argTypesBlock) {
    return {};
  }

  const options: Record<string, string[]> = {};
  for (const match of argTypesBlock.matchAll(
    /([\w-]+)\s*:\s*\{[\s\S]*?options\s*:\s*\[([\s\S]*?)\]/g,
  )) {
    const values =
      match[2]!.match(/['"]([^'"]+)['"]/g)?.map((entry) => entry.slice(1, -1)) ??
      [];
    if (values.length > 0) {
      options[match[1]!] = values;
    }
  }
  return options;
}

/** Extract default args from a Storybook meta block or named story export. */
export function extractStoryDefaultArgs(source: string): Record<string, unknown> {
  const metaIndex = source.search(/\bconst\s+meta\b/);
  const metaSlice = metaIndex >= 0 ? source.slice(metaIndex) : source;
  const metaArgs = parseStoryArgsObject(
    extractObjectLiteralAfterKey(metaSlice, "args:") ?? "",
  );

  const storyExportMatch = source.match(
    /export\s+const\s+(?:Default|[A-Z][A-Za-z0-9_]*)\s*=\s*\{[\s\S]*?\bargs\s*:\s*\{/,
  );
  const storySlice = storyExportMatch?.[0] ? source.slice(source.indexOf(storyExportMatch[0])) : "";
  const storyArgs = parseStoryArgsObject(
    extractObjectLiteralAfterKey(storySlice, "args:") ?? "",
  );

  return { ...storyArgs, ...metaArgs };
}

function parseStoryArgsObject(argsBlock: string): Record<string, unknown> {
  if (!argsBlock.trim()) {
    return {};
  }

  const args: Record<string, unknown> = {};
  for (const match of argsBlock.matchAll(
    /([\w-]+)\s*:\s*(['"])(.*?)\2/g,
  )) {
    args[match[1]!] = match[3]!;
  }
  for (const match of argsBlock.matchAll(/([\w-]+)\s*:\s*(true|false|null)\b/g)) {
    const value = match[2]!;
    args[match[1]!] = value === "null" ? null : value === "true";
  }
  for (const match of argsBlock.matchAll(
    /([\w-]+)\s*:\s*(-?\d+(?:\.\d+)?)\b/g,
  )) {
    args[match[1]!] = Number(match[2]);
  }
  for (const match of argsBlock.matchAll(/([\w-]+)\s*:\s*(\[[\s\S]*?\]|\{[\s\S]*?\})/g)) {
    const raw = match[2]!.trim();
    try {
      args[match[1]!] = JSON.parse(raw.replace(/'/g, '"').replace(/(\w+)\s*:/g, '"$1":'));
    } catch {
      args[match[1]!] = raw;
    }
  }
  return args;
}

export type PreviewPropControlType = "select" | "text" | "boolean" | "number";

export interface PreviewPropControl {
  name: string;
  control: PreviewPropControlType;
  options?: string[];
}

const SKIP_INTERFACE_PROPS = new Set([
  "className",
  "style",
  "ref",
  "key",
  "children",
  "as",
  "asChild",
  "id",
  "role",
  "icon",
]);

function parseTopLevelObjectEntries(
  objectLiteral: string,
): Array<{ key: string; value: string }> {
  const body = objectLiteral.trim().replace(/^\{/, "").replace(/\}$/, "");
  const entries: Array<{ key: string; value: string }> = [];
  const keyPattern = /([\w-]+)\s*:/g;
  let match: RegExpExecArray | null;

  while ((match = keyPattern.exec(body)) !== null) {
    const key = match[1]!;
    let valueStart = match.index! + match[0].length;
    while (valueStart < body.length && /\s/.test(body[valueStart]!)) {
      valueStart++;
    }
    if (valueStart >= body.length) {
      continue;
    }

    const first = body[valueStart]!;
    if (first === "{") {
      const nested = extractBalancedBraces(body, valueStart);
      if (!nested) {
        continue;
      }
      entries.push({ key, value: nested });
      keyPattern.lastIndex = valueStart + nested.length;
    } else if (first === '"' || first === "'") {
      const end = skipString(body, valueStart);
      entries.push({ key, value: body.slice(valueStart, end) });
      keyPattern.lastIndex = end;
    } else {
      let end = valueStart;
      let depth = 0;
      while (end < body.length) {
        const ch = body[end]!;
        if (ch === '"' || ch === "'" || ch === "`") {
          end = skipString(body, end);
          continue;
        }
        if (ch === "{" || ch === "[") {
          depth++;
        } else if (ch === "}" || ch === "]") {
          depth--;
        } else if (ch === "," && depth === 0) {
          break;
        }
        end++;
      }
      entries.push({ key, value: body.slice(valueStart, end).trim() });
      keyPattern.lastIndex = end;
    }
  }

  return entries;
}

function mapStoryControlType(raw: string | undefined): PreviewPropControlType | null {
  switch (raw) {
    case "select":
    case "multi-select":
    case "radio":
    case "inline-radio":
      return "select";
    case "boolean":
      return "boolean";
    case "number":
    case "range":
      return "number";
    case "text":
    case "color":
    case "date":
      return "text";
    default:
      return raw ? "text" : "text";
  }
}

/** Extract editable prop controls from Storybook argTypes (excluding variant axes). */
export function extractStoryPropControls(
  source: string,
  variantAxisNames: Set<string> = new Set(),
): PreviewPropControl[] {
  const metaIndex = source.search(/\bconst\s+meta\b/);
  const slice = metaIndex >= 0 ? source.slice(metaIndex) : source;
  const argTypesBlock = extractObjectLiteralAfterKey(slice, "argTypes:");
  if (!argTypesBlock) {
    return [];
  }

  const controls: PreviewPropControl[] = [];
  for (const { key, value } of parseTopLevelObjectEntries(argTypesBlock)) {
    if (variantAxisNames.has(key)) {
      continue;
    }
    if (/^on[A-Z]/.test(key)) {
      continue;
    }
    if (/\baction\s*:/.test(value)) {
      continue;
    }

    const controlMatch = value.match(/control\s*:\s*['"](\w+(?:-\w+)*)['"]/);
    const control = mapStoryControlType(controlMatch?.[1]);
    if (!control) {
      continue;
    }

    if (control === "select") {
      const options =
        value.match(/['"]([^'"]+)['"]/g)?.map((entry) => entry.slice(1, -1)) ??
        [];
      if (options.length === 0) {
        continue;
      }
      controls.push({ name: key, control, options });
      continue;
    }

    controls.push({ name: key, control });
  }

  return controls;
}

/** Extract default prop values from component destructuring defaults. */
export function extractComponentDefaultPropValues(
  source: string,
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  const paramMatch = source.match(/forwardRef[^(]*\(\s*\(\s*\{([\s\S]*?)\}\s*,/);
  if (!paramMatch) {
    return defaults;
  }

  const params = paramMatch[1]!;
  for (const match of params.matchAll(/(\w+)\s*=\s*(['"])(.*?)\2/g)) {
    defaults[match[1]!] = match[3]!;
  }
  for (const match of params.matchAll(/(\w+)\s*=\s*(true|false)\b/g)) {
    defaults[match[1]!] = match[2] === "true";
  }
  for (const match of params.matchAll(/(\w+)\s*=\s*(-?\d+(?:\.\d+)?)\b/g)) {
    defaults[match[1]!] = Number(match[2]);
  }
  return defaults;
}

function inferControlTypeFromPropType(type: string): PreviewPropControlType | null {
  const normalized = type.trim();
  if (/\bboolean\b/.test(normalized)) {
    return "boolean";
  }
  if (/\bnumber\b/.test(normalized)) {
    return "number";
  }
  if (/\bstring\b/.test(normalized)) {
    return "text";
  }
  if (/React\.ReactNode/.test(normalized)) {
    return "text";
  }
  if (/CSSProperties\[['"](?:width|height)['"]\]/.test(normalized)) {
    return "text";
  }
  return null;
}

/** Extract editable prop controls from a component props interface. */
export function extractComponentPropControls(
  source: string,
  existingNames: Set<string> = new Set(),
  variantAxisNames: Set<string> = new Set(),
): PreviewPropControl[] {
  const handlerNames = new Set(extractHandlerPropNames(source));
  const propsBlock = source.match(
    /export\s+interface\s+\w+Props[\s\S]*?\{([\s\S]*?)\n\}/,
  )?.[1];
  if (!propsBlock) {
    return [];
  }

  const controls: PreviewPropControl[] = [];
  for (const match of propsBlock.matchAll(/(\w+)\??\s*:\s*([^;\n]+)/g)) {
    const name = match[1]!;
    const type = match[2]!;
    if (
      SKIP_INTERFACE_PROPS.has(name) ||
      existingNames.has(name) ||
      variantAxisNames.has(name) ||
      handlerNames.has(name)
    ) {
      continue;
    }

    const control = inferControlTypeFromPropType(type);
    if (control) {
      controls.push({ name, control });
    }
  }

  return controls;
}

export function buildPreviewPropControls(
  componentContent: string,
  storyContent?: string,
  variantAxisNames: Set<string> = new Set(),
): PreviewPropControl[] {
  const fromStory = storyContent
    ? extractStoryPropControls(storyContent, variantAxisNames)
    : [];
  const storyNames = new Set(fromStory.map((control) => control.name));
  const fromComponent = extractComponentPropControls(
    componentContent,
    storyNames,
    variantAxisNames,
  );
  return [...fromStory, ...fromComponent];
}

export function resolveInitialPreviewArgs(
  variants: Record<string, string[]>,
  propControls: PreviewPropControl[],
  componentContent?: string,
  storyContent?: string,
): Record<string, unknown> {
  const variantSelection = resolveInitialVariantSelection(
    variants,
    componentContent,
    storyContent,
  );
  const storyArgs = storyContent ? extractStoryDefaultArgs(storyContent) : {};
  const componentDefaults = componentContent
    ? extractComponentDefaultPropValues(componentContent)
    : {};
  const args: Record<string, unknown> = {
    ...componentDefaults,
    ...storyArgs,
    ...variantSelection,
  };

  for (const control of propControls) {
    if (control.name in args) {
      continue;
    }
    if (control.control === "boolean") {
      args[control.name] = false;
    } else if (control.control === "number") {
      args[control.name] = 0;
    } else if (control.control === "select") {
      args[control.name] = control.options?.[0] ?? "";
    } else {
      args[control.name] = "";
    }
  }

  return args;
}

function mergeVariantAxes(
  fromCva: Record<string, string[]>,
  fromStory: Record<string, string[]>,
): Record<string, string[]> {
  const merged = { ...fromCva };
  for (const [key, values] of Object.entries(fromStory)) {
    merged[key] = values;
  }
  return merged;
}

export function resolveInitialVariantSelection(
  variants: Record<string, string[]>,
  componentContent?: string,
  storyContent?: string,
): Record<string, string> {
  const storyArgs = storyContent ? extractStoryDefaultArgs(storyContent) : {};
  const cvaDefaults = componentContent
    ? extractCvaDefaultVariants(componentContent)
    : {};
  const selected: Record<string, string> = {};

  for (const [key, values] of Object.entries(variants)) {
    const preferred = storyArgs[key] ?? cvaDefaults[key];
    selected[key] =
      typeof preferred === "string" && values.includes(preferred)
        ? preferred
        : (values[0] ?? "");
  }

  return selected;
}

/** Build preview variant metadata for an existing repo component. */
export function extractExistingPreviewMetadata(
  componentContent: string,
  storyContent?: string,
): {
  variants: Record<string, string[]>;
  variantLabel: string;
  propControls: PreviewPropControl[];
} {
  const variants = mergeVariantAxes(
    extractCvaVariantAxes(componentContent),
    storyContent ? extractStoryArgTypeOptions(storyContent) : {},
  );
  const variantAxisNames = new Set(Object.keys(variants));
  const propControls = buildPreviewPropControls(
    componentContent,
    storyContent,
    variantAxisNames,
  );
  const selection = resolveInitialVariantSelection(
    variants,
    componentContent,
    storyContent,
  );
  return {
    variants,
    variantLabel: formatVariantSelectionLabel(selection) || "Default",
    propControls,
  };
}

/** Extract bare (non-relative) import specifiers from component source. */
export function extractBareImportSpecifiers(source: string): string[] {
  const imports = new Set<string>();
  const pattern = /import\s+[\s\S]*?\s+from\s+['"]([^./][^'"]*)['"]/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const specifier = match[1]!;
    const packageName = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0]!;
    if (packageName !== "react" && packageName !== "react-dom") {
      imports.add(packageName);
    }
  }
  return [...imports];
}

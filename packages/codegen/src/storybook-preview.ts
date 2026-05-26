import { Buffer } from "node:buffer";
import type { JobBuildPreview } from "@fig2code/spec";
import { storyFormatLabel } from "./preview.js";

export interface StoryPreviewTarget {
  componentName: string;
  args: Record<string, unknown>;
  storyName: string;
}

export function extractComponentName(source: string, fallback: string): string {
  const patterns = [
    /export function (\w+)/,
    /export const (\w+)\s*=\s*forwardRef/,
    /export const (\w+)\s*=\s*memo/,
    /export default function (\w+)/,
    /export default (\w+)\s*;/,
    /(?:^|\n)\s*function (\w+)/,
    /(?:^|\n)\s*const (\w+)\s*=\s*forwardRef/,
    /(?:^|\n)\s*const (\w+)\s*=\s*memo/,
    /export const (\w+)\s*=/,
    /(?:^|\n)\s*const (\w+)\s*=/,
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) return match[1];
  }

  return fallback;
}

export function extractFirstStoryPreview(storyContent: string): StoryPreviewTarget | null {
  const nameMatch = storyContent.match(/export const (\w+):\s*Story(?:Obj<[^>]+>)?\s*=/);
  if (!nameMatch?.[1]) {
    return null;
  }

  return {
    componentName: "",
    args: extractArgsObject(storyContent),
    storyName: nameMatch[1],
  };
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

export function defaultPreviewArgs(preview: JobBuildPreview): Record<string, unknown> {
  return enrichPreviewArgs(argsFromVariants(preview.variants), preview.componentName);
}

export function extractHandlerPropNames(source: string): string[] {
  const names = new Set<string>();

  for (const match of source.matchAll(/\bon([A-Z][A-Za-z0-9_]*)\b/g)) {
    names.add(`on${match[1]}`);
  }

  return [...names].sort();
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

function previewArgsForSelection(
  preview: JobBuildPreview,
  selectedVariants?: Record<string, string>,
): Record<string, unknown> {
  const variantArgs = selectedVariants
    ? argsFromVariantSelection(preview.variants, selectedVariants)
    : argsFromVariants(preview.variants);

  return enrichPreviewArgs(variantArgs, preview.componentName);
}

function extractArgsObject(source: string): Record<string, unknown> {
  const argsIndex = source.indexOf("args:");
  if (argsIndex === -1) {
    return {};
  }

  const start = source.indexOf("{", argsIndex);
  if (start === -1) {
    return {};
  }

  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = new Function(`return (${source.slice(start, index + 1)})`)();
          return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
        } catch {
          return {};
        }
      }
    }
  }

  return {};
}

const PREVIEW_RUNTIME_SHIMS = `
const forwardRef = React.forwardRef;
const useState = React.useState;
const useEffect = React.useEffect;
const useMemo = React.useMemo;
const useCallback = React.useCallback;
const useRef = React.useRef;
const Fragment = React.Fragment;
const memo = React.memo;
function cn(...inputs) {
  const out = [];
  for (const input of inputs) {
    if (!input) continue;
    if (typeof input === "string") out.push(input);
    else if (Array.isArray(input)) out.push(cn(...input));
    else if (typeof input === "object") {
      for (const [key, value] of Object.entries(input)) {
        if (value) out.push(key);
      }
    }
  }
  return out.join(" ");
}
const clsx = cn;
function createPreviewStub(name) {
  const isIcon = /Icon$/.test(name);
  function Stub(props) {
    if (isIcon) {
      return React.createElement(
        "svg",
        {
          ...props,
          viewBox: "0 0 16 16",
          width: props.width ?? 16,
          height: props.height ?? 16,
          className: cn("shrink-0 text-current", props.className),
          "aria-hidden": props["aria-hidden"] ?? true,
        },
        React.createElement("circle", {
          cx: 8,
          cy: 8,
          r: 6,
          fill: "currentColor",
          opacity: 0.25,
        }),
      );
    }
    return React.createElement(
      "span",
      {
        ...props,
        className: cn(
          "inline-flex items-center rounded border border-dashed border-gray-300 px-1 text-[10px] text-gray-500",
          props.className,
        ),
        title: name,
      },
      name,
    );
  }
  Stub.displayName = name;
  return Stub;
}
function isPreviewComponent(type) {
  if (type == null) return false;
  if (typeof type === "string") return true;
  if (typeof type === "function") return true;
  if (typeof type === "object" && "$$typeof" in type) return true;
  return false;
}
function parseInlineStyleString(css) {
  const style = {};
  for (const declaration of String(css).split(";")) {
    const trimmed = declaration.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(":");
    if (separator === -1) continue;
    const property = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!property || !value) continue;
    style[property.replace(/-([a-z])/g, function (_, letter) { return letter.toUpperCase(); })] = value;
  }
  return style;
}
function normalizePreviewArgs(args) {
  if (!args || typeof args !== "object") return args;
  const next = { ...args };
  if (typeof next.style === "string") {
    next.style = parseInlineStyleString(next.style);
  }
  for (const key of Object.keys(next)) {
    if (/^on[A-Z]/.test(key)) {
      const value = next[key];
      if (typeof value === "function") {
        next[key] = function () {
          logPreviewAction(key, Array.from(arguments));
          return value.apply(this, arguments);
        };
      } else if (value == null) {
        next[key] = createPreviewAction(key);
      }
    }
  }
  return next;
}
const __previewActionLog = [];
function formatPreviewActionArgs(args) {
  return args.map(function (arg) {
    if (arg == null) return String(arg);
    if (typeof arg === "string") return JSON.stringify(arg);
    if (typeof arg === "number" || typeof arg === "boolean") return String(arg);
    if (arg && (arg.nativeEvent || arg.target)) return "SyntheticEvent";
    try {
      return JSON.stringify(arg);
    } catch (_error) {
      return Object.prototype.toString.call(arg);
    }
  }).join(", ");
}
function logPreviewAction(name, args) {
  const entry = {
    name: name,
    detail: formatPreviewActionArgs(args),
    at: Date.now(),
  };
  __previewActionLog.unshift(entry);
  if (__previewActionLog.length > 20) {
    __previewActionLog.length = 20;
  }
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: "fig2code-preview-action", action: entry }, "*");
  }
}
function createPreviewAction(name) {
  return function () {
    logPreviewAction(name, Array.from(arguments));
  };
}
function ensurePreviewHandlers(args, handlerProps) {
  const next = normalizePreviewArgs(args);
  for (const key of handlerProps) {
    if (!(key in next) || next[key] == null) {
      next[key] = createPreviewAction(key);
    }
  }
  return next;
}
`.trim();

const PREVIEW_SHIM_NAMES = new Set([
  "forwardRef",
  "useState",
  "useEffect",
  "useMemo",
  "useCallback",
  "useRef",
  "Fragment",
  "memo",
  "cn",
  "clsx",
  "createPreviewStub",
  "isPreviewComponent",
]);

export function extractImportBindings(source: string): string[] {
  const bindings: string[] = [];
  let index = 0;

  while (index < source.length) {
    const rest = source.slice(index);
    const importMatch = rest.match(/^import\s+(?:type\s+)?[\s\S]*?from\s+["'][^"']+["'];?\s*/);
    if (importMatch) {
      collectImportBindings(importMatch[0], bindings);
      index += importMatch[0].length;
      continue;
    }

    const sideEffectImportMatch = rest.match(/^import\s+["'][^"']+["'];?\s*/);
    if (sideEffectImportMatch) {
      index += sideEffectImportMatch[0].length;
      continue;
    }

    index += 1;
  }

  return [...new Set(bindings)];
}

function collectImportBindings(statement: string, bindings: string[]): void {
  if (/^import\s+type\b/.test(statement) || /import\s+\*\s+as\s+/.test(statement)) {
    return;
  }

  const defaultAndNamedMatch = statement.match(
    /^import\s+(?!type\b)(\w+)\s*,\s*\{([\s\S]*?)\}\s+from/,
  );
  if (defaultAndNamedMatch) {
    bindings.push(defaultAndNamedMatch[1]);
    collectNamedImportBindings(defaultAndNamedMatch[2], bindings);
    return;
  }

  const namedMatch = statement.match(/^import\s+(?!type\b)\{([\s\S]*?)\}\s+from/);
  if (namedMatch) {
    collectNamedImportBindings(namedMatch[1], bindings);
    return;
  }

  const defaultMatch = statement.match(/^import\s+(?!type\b)(\w+)\s+from/);
  if (defaultMatch) {
    bindings.push(defaultMatch[1]);
  }
}

function collectNamedImportBindings(specifier: string, bindings: string[]): void {
  for (const part of specifier.split(",")) {
    const trimmed = part.trim();
    if (!trimmed || trimmed.startsWith("type ")) {
      continue;
    }

    const withoutType = trimmed.replace(/^type\s+/, "");
    const asMatch = withoutType.match(/^(\w+)\s+as\s+(\w+)$/);
    if (asMatch) {
      bindings.push(asMatch[2]);
      continue;
    }

    const name = withoutType.match(/^(\w+)/)?.[1];
    if (name) {
      bindings.push(name);
    }
  }
}

export function buildImportStubs(source: string, skipBindings: ReadonlySet<string> = new Set()): string {
  const bindings = extractImportBindings(source).filter(
    (name) => !PREVIEW_SHIM_NAMES.has(name) && !skipBindings.has(name),
  );
  if (bindings.length === 0) {
    return "";
  }

  return bindings
    .map((name) => `const ${name} = createPreviewStub(${JSON.stringify(name)});`)
    .join("\n");
}

function removeTypeScriptBlocks(source: string, keyword: "interface" | "enum"): string {
  const pattern = new RegExp(`(?:export\\s+)?${keyword}\\s+`, "g");
  let result = source;

  for (let match = pattern.exec(result); match; match = pattern.exec(result)) {
    const start = match.index;
    const braceIndex = result.indexOf("{", match.index + match[0].length);
    if (braceIndex === -1) {
      pattern.lastIndex = match.index + match[0].length;
      continue;
    }

    let depth = 0;
    let end = braceIndex;
    for (let index = braceIndex; index < result.length; index += 1) {
      const char = result[index];
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }

    result = result.slice(0, start) + result.slice(end);
    pattern.lastIndex = start;
  }

  return result;
}

function camelCaseCssProperty(property: string): string {
  return property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

export function parseInlineStyleString(css: string): Record<string, string> {
  const style: Record<string, string> = {};

  for (const declaration of css.split(";")) {
    const trimmed = declaration.trim();
    if (!trimmed) continue;

    const separator = trimmed.indexOf(":");
    if (separator === -1) continue;

    const property = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!property || !value) continue;

    style[camelCaseCssProperty(property)] = value;
  }

  return style;
}

function formatInlineStyleObject(style: Record<string, string>): string {
  const entries = Object.entries(style).map(
    ([key, value]) => `${key}: ${JSON.stringify(value)}`,
  );
  return `{ ${entries.join(", ")} }`;
}

/** Convert HTML-style JSX style strings to React style objects for browser preview. */
export function fixReactStyleProps(source: string): string {
  let result = source;

  result = result.replace(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/g, (_match, _quote, css: string) => {
    const styleObject = parseInlineStyleString(css);
    return `style={${formatInlineStyleObject(styleObject)}}`;
  });

  result = result.replace(
    /\bstyle\s*=\s*\{\s*(["'])([\s\S]*?)\1\s*\}/g,
    (_match, _quote, css: string) => {
      const styleObject = parseInlineStyleString(css);
      return `style={${formatInlineStyleObject(styleObject)}}`;
    },
  );

  return result;
}

function preparePreviewModuleSource(source: string): string {
  return fixReactStyleProps(
    normalizePreviewReactHooks(
      stripCallTypeParameters(
        stripExportStatements(stripImportStatements(stripTypeScriptForPreview(source))),
      ),
    ),
  );
}

/** Babel TSX parses forwardRef<...> as JSX/comparison — strip generic args for preview. */
export function stripCallTypeParameters(source: string): string {
  let result = source;

  for (const callee of ["React.forwardRef", "React.memo", "forwardRef", "memo"]) {
    result = stripTypeParametersAfterCallee(result, callee);
  }

  return result;
}

function stripTypeParametersAfterCallee(source: string, callee: string): string {
  const escaped = callee.replace(/\./g, "\\.");
  const pattern = new RegExp(`\\b${escaped}\\s*<`, "g");
  let result = source;

  for (let match = pattern.exec(result); match; match = pattern.exec(result)) {
    const openIndex = match.index + match[0].length - 1;
    let depth = 0;
    let closeIndex = -1;

    for (let index = openIndex; index < result.length; index += 1) {
      const char = result[index];
      if (char === "<") depth += 1;
      if (char === ">") {
        depth -= 1;
        if (depth === 0) {
          closeIndex = index + 1;
          break;
        }
      }
    }

    if (closeIndex === -1) {
      break;
    }

    result = result.slice(0, openIndex) + result.slice(closeIndex);
    pattern.lastIndex = match.index;
  }

  return result;
}

function normalizePreviewReactHooks(source: string): string {
  return source.replace(/\bReact\.forwardRef\b/g, "forwardRef").replace(/\bReact\.memo\b/g, "memo");
}

export function stripTypeScriptForPreview(source: string): string {
  return removeTypeScriptBlocks(removeTypeScriptBlocks(source, "interface"), "enum")
    .replace(/export\s+type\s+[^;]+;\s*/g, "")
    .replace(/type\s+\w+\s*=[^;]+;\s*/g, "")
    .replace(/\s+as\s+const/g, "")
    .replace(/\s+as\s+[A-Za-z_$][\w$.[\]|&<>,\s]*/g, "")
    .replace(/\s+satisfies\s+[A-Za-z_$][\w$.[\]|&<>,\s]*/g, "")
    .trim();
}

export function stripImportStatements(source: string): string {
  let result = "";
  let index = 0;

  while (index < source.length) {
    const rest = source.slice(index);
    const importMatch = rest.match(/^import\s+(?:type\s+)?[\s\S]*?from\s+["'][^"']+["'];?\s*/);
    if (importMatch) {
      index += importMatch[0].length;
      continue;
    }

    const sideEffectImportMatch = rest.match(/^import\s+["'][^"']+["'];?\s*/);
    if (sideEffectImportMatch) {
      index += sideEffectImportMatch[0].length;
      continue;
    }

    result += source[index];
    index += 1;
  }

  return result;
}

export function stripExportStatements(source: string): string {
  return source
    .replace(/^\s*export\s+\*\s+from\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/^\s*export\s+\{[\s\S]*?\}\s*from\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/^\s*export\s+\{[\s\S]*?\};?\s*$/gm, "")
    .replace(/^\s*export\s+default\s+(\w+)\s*;?\s*$/gm, "")
    .replace(/^\s*export\s+default\s+/gm, "")
    .replace(/^\s*export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm, "")
    .trim();
}

export interface PreviewDependencyBundle {
  sources: string[];
  resolvedBindings: string[];
}

export interface PreparePreviewBundleOptions {
  dependencySources?: string[];
  resolvedBindings?: string[];
}

export function prepareDependencyModule(source: string): string {
  return preparePreviewModuleSource(source);
}

export function preparePreviewBundle(
  componentContent: string,
  options: PreparePreviewBundleOptions = {},
): string {
  const resolvedBindings = new Set(options.resolvedBindings ?? []);
  const parts = [PREVIEW_RUNTIME_SHIMS];

  for (const dependency of options.dependencySources ?? []) {
    parts.push(preparePreviewModuleSource(dependency));
  }

  const stubs = buildImportStubs(componentContent, resolvedBindings);
  if (stubs) {
    parts.push(stubs);
  }

  parts.push(preparePreviewModuleSource(componentContent));

  return parts.join("\n\n").trim();
}

function preparePreviewShims(
  componentContent: string,
  options: PreparePreviewBundleOptions = {},
): string {
  const resolvedBindings = new Set(options.resolvedBindings ?? []);
  const parts = [PREVIEW_RUNTIME_SHIMS];

  for (const dependency of options.dependencySources ?? []) {
    parts.push(preparePreviewModuleSource(dependency));
  }

  const stubs = buildImportStubs(componentContent, resolvedBindings);
  if (stubs) {
    parts.push(stubs);
  }

  return parts.join("\n\n").trim();
}

function preparePreviewModuleSourceOnly(source: string): string {
  return preparePreviewModuleSource(source);
}

export function prepareHotReloadComponentSource(source: string): string {
  return preparePreviewModuleSource(source);
}

export function buildHotReloadPreviewSource(
  previewSource: string,
  rawComponentSource: string,
  componentName: string,
): string {
  const startParts = previewSource.split("/* __FIG2CODE_COMPONENT_START__ */");
  const shimPrefix = startParts.length > 1 ? startParts[0] : "";
  const afterStart = startParts.length > 1 ? startParts[1] : previewSource;
  const endParts = afterStart.split("/* __FIG2CODE_COMPONENT_END__ */");
  const runtimeSuffix = endParts.length > 1 ? endParts[1] : "";
  const strippedComponent = prepareHotReloadComponentSource(rawComponentSource);

  return [
    shimPrefix,
    "/* __FIG2CODE_COMPONENT_START__ */",
    strippedComponent,
    "/* __FIG2CODE_COMPONENT_END__ */",
    `window.__fig2codeComponent = ${componentName};`,
    runtimeSuffix,
  ].join("\n");
}

export function prepareComponentSource(
  componentContent: string,
  options: PreparePreviewBundleOptions = {},
): string {
  return preparePreviewBundle(componentContent, options);
}

export interface StorybookPreviewOptions {
  selectedVariants?: Record<string, string>;
  /** Custom CSS (e.g. token variable definitions) injected into preview <style>. */
  tokenCss?: string;
}

export function resolveStoryPreviewTarget(
  preview: JobBuildPreview,
  options: StorybookPreviewOptions = {},
): StoryPreviewTarget | null {
  if (!preview.componentContent?.trim()) {
    return null;
  }

  const componentName = extractComponentName(preview.componentContent, preview.componentName);
  const fromStory = preview.storyContent ? extractFirstStoryPreview(preview.storyContent) : null;
  const variantArgs = options.selectedVariants
    ? argsFromVariantSelection(preview.variants, options.selectedVariants)
    : argsFromVariants(preview.variants);
  const fallbackArgs = previewArgsForSelection(preview, options.selectedVariants);
  const storyName = options.selectedVariants
    ? formatVariantSelectionLabel(options.selectedVariants)
    : preview.variantLabel || "Default";

  if (fromStory) {
    return {
      componentName,
      args: { ...fallbackArgs, ...fromStory.args, ...variantArgs },
      storyName: options.selectedVariants ? storyName : fromStory.storyName,
    };
  }

  return {
    componentName,
    args: fallbackArgs,
    storyName,
  };
}

export function buildStorybookPreviewHtml(
  preview: JobBuildPreview,
  dependencies: PreviewDependencyBundle = { sources: [], resolvedBindings: [] },
  options: StorybookPreviewOptions = {},
): string | null {
  const target = resolveStoryPreviewTarget(preview, options);
  if (!target) {
    return null;
  }

  const previewStyleSources = [
    preview.componentContent ?? "",
    preview.storyContent ?? "",
    ...dependencies.sources,
  ];
  const injectedTokenCss = options.tokenCss ? extractInjectedTokenCss(options.tokenCss) : "";
  const tokenColorUtilityCss = options.tokenCss
    ? buildTokenColorUtilityCss(options.tokenCss, previewStyleSources)
    : "";
  const tokenColorClasses = options.tokenCss
    ? extractTailwindColorClasses(...previewStyleSources)
    : [];
  const formatLabel = storyFormatLabel(preview.storyFormat);
  const componentName = target.componentName;
  const defaultTarget = resolveStoryPreviewTarget(preview, {});

  if (!/^[A-Za-z_$][\w$]*$/.test(componentName) || !defaultTarget) {
    return null;
  }

  const variantOptionsJson = JSON.stringify(preview.variants ?? {});
  const handlerPropsJson = JSON.stringify(extractHandlerPropNames(preview.componentContent ?? ""));

  const componentStartMarker = "/* __FIG2CODE_COMPONENT_START__ */";
  const componentEndMarker = "/* __FIG2CODE_COMPONENT_END__ */";
  const shimSource = preparePreviewShims(preview.componentContent ?? "", {
    dependencySources: dependencies.sources,
    resolvedBindings: dependencies.resolvedBindings,
  });
  const bareComponentSource = preparePreviewModuleSourceOnly(preview.componentContent ?? "");
  const previewSource = [
    shimSource,
    componentStartMarker,
    bareComponentSource,
    componentEndMarker,
    `const __handlerProps = ${handlerPropsJson};`,
    `const __variantOptions = ${variantOptionsJson};`,
    `const __defaultStoryArgs = ${JSON.stringify(defaultTarget.args)};`,
    `let __storyArgs = ${JSON.stringify(target.args)};`,
    `let __previewRoot = window.__fig2codeRoot || null;`,
    `function applyVariantSelection(selected) {
  const next = { ...__defaultStoryArgs };
  for (const [key, values] of Object.entries(__variantOptions)) {
    const picked = selected?.[key];
    next[key] = picked && values.includes(picked) ? picked : (values[0] ?? next[key]);
  }
  return next;
}`,
    `function formatVariantLabel(selected) {
  return Object.entries(__variantOptions)
    .map(([key, values]) => {
      const picked = selected?.[key];
      const value = picked && values.includes(picked) ? picked : (values[0] ?? "?");
      return key + "=" + value;
    })
    .join(", ");
}`,
    `class PreviewErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return React.createElement(
        "div",
        { className: "storybook-error" },
        String(this.state.error.message || this.state.error),
      );
    }
    return this.props.children;
  }
}`,
    `window.__fig2codeComponent = ${componentName};`,
    `function StorybookPreview() {
  const Component = window.__fig2codeComponent;
  if (!isPreviewComponent(Component)) {
    return React.createElement(
      "div",
      { className: "storybook-error" },
      "Could not load generated component (${componentName}).",
    );
  }
  return React.createElement(Component, ensurePreviewHandlers(__storyArgs, __handlerProps));
}`,
    `function renderPreview(selectedVariants) {
  if (selectedVariants) {
    __storyArgs = applyVariantSelection(selectedVariants);
  }
  if (!__previewRoot) {
    __previewRoot = ReactDOM.createRoot(document.getElementById("root"));
    window.__fig2codeRoot = __previewRoot;
  }
  __previewRoot.render(
    React.createElement(
      PreviewErrorBoundary,
      null,
      React.createElement(StorybookPreview),
    ),
  );
}`,
    `function updatePreviewVariants(selectedVariants) {
  renderPreview(selectedVariants);
  const labelEl = document.getElementById("fig2code-variant-label");
  if (labelEl) {
    labelEl.textContent = formatVariantLabel(selectedVariants ?? {});
  }
}`,
    `window.__fig2codeUpdatePreviewVariants = updatePreviewVariants;
window.__fig2codeRenderPreview = renderPreview;
window.__fig2codeComponentName = "${componentName}";`,
    `window.addEventListener("message", function (event) {
  if (!event.data || event.data.type !== "fig2code-preview-variants") {
    return;
  }
  updatePreviewVariants(event.data.variants ?? {});
});`,
    `renderPreview();`,
    `if (window.parent && window.parent !== window) {
  window.parent.postMessage({ type: "fig2code-preview-ready" }, "*");
}`,
  ].join("\n\n");

  const previewSourceBase64 = Buffer.from(previewSource, "utf8").toString("base64");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${preview.componentName} · Storybook preview</title>
    <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    <script src="https://cdn.tailwindcss.com"></script>${options.tokenCss ? `
    <script>
      tailwind.config = ${buildTailwindConfigFromTokenCss(options.tokenCss, tokenColorClasses)}
    </script>` : ""}
    <style>
      :root {
        color-scheme: light;
        font-family: Inter, system-ui, sans-serif;
      }${injectedTokenCss ? `\n${indentCss(injectedTokenCss, 6)}` : ""}${tokenColorUtilityCss ? `\n${indentCss(tokenColorUtilityCss, 6)}` : ""}
      body {
        margin: 0;
        background: #f8fafc;
        color: #111827;
      }
      .storybook-shell {
        min-height: 100vh;
        padding: 20px;
        box-sizing: border-box;
      }
      .storybook-frame {
        max-width: 760px;
        margin: 0 auto;
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-radius: 14px;
        box-shadow: 0 10px 30px rgba(15, 23, 42, 0.06);
        overflow: hidden;
      }
      .storybook-toolbar {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 16px;
        border-bottom: 1px solid #e5e7eb;
        background: #fcfcfd;
        font-size: 11px;
        color: #6b7280;
      }
      .storybook-toolbar strong {
        color: #111827;
        font-size: 12px;
      }
      .storybook-canvas {
        padding: 28px;
        min-height: 180px;
        display: flex;
        align-items: flex-start;
        justify-content: stretch;
        width: 100%;
      }
      .storybook-canvas #root {
        width: 100%;
      }
      .storybook-error {
        color: #b91c1c;
        font-size: 12px;
        line-height: 1.5;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <div class="storybook-shell">
      <div class="storybook-frame">
        <div class="storybook-toolbar">
          <div><strong>${preview.componentName}</strong> / <span id="fig2code-variant-label">${target.storyName}</span></div>
          <div>${formatLabel}</div>
        </div>
        <div class="storybook-canvas"><div id="root"></div></div>
      </div>
    </div>
    <script>
      (function () {
        const rootEl = document.getElementById("root");

        function showError(message) {
          rootEl.innerHTML = '<div class="storybook-error">' + message + "</div>";
        }

        if (!window.Babel || !window.React || !window.ReactDOM) {
          showError("Preview runtime failed to load. Check network access for React and Babel CDN scripts.");
          return;
        }

        const previewSource = new TextDecoder().decode(
          Uint8Array.from(atob("${previewSourceBase64}"), (char) => char.charCodeAt(0)),
        );

        function sanitizeCompiledPreview(code) {
          return code
            .replace(/^\\s*export\\s+\\{[\\s\\S]*?\\};?\\s*$/gm, "")
            .replace(/^\\s*export\\s+default\\s+/gm, "")
            .replace(/^\\s*export\\s+(?=(?:async\\s+)?(?:function|const|let|var|class)\\b)/gm, "")
            .trim();
        }

        let compiled = "";
        try {
          compiled = sanitizeCompiledPreview(
            Babel.transform(previewSource, {
              filename: "preview.tsx",
              presets: ["react", "typescript"],
              sourceType: "script",
            }).code,
          );
        } catch (error) {
          showError("Compile error: " + String(error && error.message ? error.message : error));
          return;
        }

        try {
          const runPreview = new Function("React", "ReactDOM", compiled);
          runPreview(React, ReactDOM);
        } catch (error) {
          showError("Render error: " + String(error && error.message ? error.message : error));
        }

        var startParts = previewSource.split("/* __FIG2CODE_COMPONENT_START__ */");
        var storedShimPrefix = startParts.length > 1 ? startParts[0] : "";
        var afterStart = startParts.length > 1 ? startParts[1] : previewSource;
        var endParts = afterStart.split("/* __FIG2CODE_COMPONENT_END__ */");
        var storedRuntimeSuffix = endParts.length > 1 ? endParts[1] : "";

        function stripCallTypeParameters(source) {
          var result = source;
          var callees = ["React.forwardRef", "React.memo", "forwardRef", "memo"];
          for (var c = 0; c < callees.length; c++) {
            var callee = callees[c];
            var escaped = callee.replace(/\\./g, "\\\\.");
            var pattern = new RegExp("\\\\b" + escaped + "\\\\s*<", "g");
            var match;
            while ((match = pattern.exec(result)) !== null) {
              var openIndex = match.index + match[0].length - 1;
              var depth = 0;
              var closeIndex = -1;
              for (var i = openIndex; i < result.length; i++) {
                if (result[i] === "<") depth++;
                if (result[i] === ">") {
                  depth--;
                  if (depth === 0) {
                    closeIndex = i + 1;
                    break;
                  }
                }
              }
              if (closeIndex === -1) break;
              result = result.slice(0, openIndex) + result.slice(closeIndex);
              pattern.lastIndex = match.index;
            }
          }
          return result;
        }

        function normalizePreviewReactHooks(source) {
          return source
            .replace(/\\bReact\\.forwardRef\\b/g, "forwardRef")
            .replace(/\\bReact\\.memo\\b/g, "memo");
        }

        function formatInlineStyleObject(style) {
          var entries = Object.entries(style);
          if (entries.length === 0) return "{}";
          return "{ " + entries.map(function (entry) {
            return entry[0] + ": " + JSON.stringify(entry[1]);
          }).join(", ") + " }";
        }

        function fixReactStyleProps(source) {
          return source
            .replace(/\\bstyle\\s*=\\s*([\"'])([\\s\\S]*?)\\1/g, function (_match, _quote, css) {
              return "style={" + formatInlineStyleObject(parseInlineStyleString(css)) + "}";
            })
            .replace(/\\bstyle\\s*=\\s*\\{\\s*([\"'])([\\s\\S]*?)\\1\\s*\\}/g, function (_match, _quote, css) {
              return "style={" + formatInlineStyleObject(parseInlineStyleString(css)) + "}";
            });
        }

        function parseInlineStyleString(css) {
          var style = {};
          for (var declaration of String(css).split(";")) {
            var trimmed = declaration.trim();
            if (!trimmed) continue;
            var separator = trimmed.indexOf(":");
            if (separator === -1) continue;
            var property = trimmed.slice(0, separator).trim();
            var value = trimmed.slice(separator + 1).trim();
            if (!property || !value) continue;
            style[property.replace(/-([a-z])/g, function (_, letter) { return letter.toUpperCase(); })] = value;
          }
          return style;
        }

        function stripForPreview(raw) {
          var s = raw;
          s = s.replace(/^\\s*import\\s+(?:type\\s+)?[\\s\\S]*?from\\s+["'][^"']+["'];?\\s*$/gm, "");
          s = s.replace(/^\\s*import\\s+["'][^"']+["'];?\\s*$/gm, "");
          s = s.replace(/^\\s*export\\s+type\\s+[^;]+;\\s*$/gm, "");
          s = s.replace(/type\\s+\\w+\\s*=[^;]+;\\s*/g, "");
          s = stripBracedBlock(s, "interface");
          s = stripBracedBlock(s, "enum");
          s = s.replace(/^\\s*export\\s+\\*\\s+from\\s+["'][^"']+["'];?\\s*$/gm, "");
          s = s.replace(/^\\s*export\\s+\\{[\\s\\S]*?\\}\\s*from\\s+["'][^"']+["'];?\\s*$/gm, "");
          s = s.replace(/^\\s*export\\s+\\{[\\s\\S]*?\\};?\\s*$/gm, "");
          s = s.replace(/^\\s*export\\s+default\\s+(\\w+)\\s*;?\\s*$/gm, "");
          s = s.replace(/^\\s*export\\s+default\\s+/gm, "");
          s = s.replace(/^\\s*export\\s+(?=(?:async\\s+)?(?:function|const|let|var|class)\\b)/gm, "");
          s = s.replace(/\\s+as\\s+const/g, "");
          s = s.replace(/\\s+as\\s+[A-Za-z_$][\\w$.\\[\\]|&<>,\\s]*/g, "");
          s = s.replace(/\\s+satisfies\\s+[A-Za-z_$][\\w$.\\[\\]|&<>,\\s]*/g, "");
          s = stripCallTypeParameters(s);
          s = normalizePreviewReactHooks(s);
          s = fixReactStyleProps(s);
          return s.trim();
        }

        function stripBracedBlock(source, keyword) {
          var pattern = new RegExp("(?:export\\\\s+)?" + keyword + "\\\\s+\\\\w", "g");
          var result = source;
          var match;
          while ((match = pattern.exec(result)) !== null) {
            var start = match.index;
            var braceIdx = result.indexOf("{", start + match[0].length);
            if (braceIdx === -1) { continue; }
            var depth = 0, end = braceIdx;
            for (var i = braceIdx; i < result.length; i++) {
              if (result[i] === "{") depth++;
              if (result[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
            }
            result = result.slice(0, start) + result.slice(end);
            pattern.lastIndex = start;
          }
          return result;
        }

        window.addEventListener("message", function (event) {
          if (!event.data || event.data.type !== "fig2code-preview-hot-reload") return;
          var rawSource = event.data.componentSource;
          if (typeof rawSource !== "string") return;

          var strippedComponent = stripForPreview(rawSource);
          var componentName = typeof event.data.componentName === "string"
            ? event.data.componentName
            : (window.__fig2codeComponentName || "null");
          var fullSource = storedShimPrefix +
            "\\n/* __FIG2CODE_COMPONENT_START__ */\\n" +
            strippedComponent +
            "\\n/* __FIG2CODE_COMPONENT_END__ */\\n" +
            "window.__fig2codeComponent = " + componentName + ";\\n" +
            storedRuntimeSuffix;

          try {
            var hotCompiled = sanitizeCompiledPreview(
              Babel.transform(fullSource, {
                filename: "preview.tsx",
                presets: ["react", "typescript"],
                sourceType: "script",
              }).code,
            );
            new Function("React", "ReactDOM", hotCompiled)(React, ReactDOM);
            if (typeof window.__fig2codeRenderPreview === "function") {
              window.__fig2codeRenderPreview();
            }
          } catch (error) {
            showError("Hot reload error: " + String(error && error.message ? error.message : error));
          }
        });
      })();
    </script>
  </body>
</html>`;
}

function indentCss(css: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return css
    .split("\n")
    .map((line) => (line.trim() ? `${pad}${line}` : line))
    .join("\n");
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

/**
 * Parse CSS variable definitions from token CSS and build a Tailwind CDN config
 * that extends colors so custom token classes like `bg-color-bg-accent-yellow-default` work.
 */
function buildTailwindConfigFromTokenCss(tokenCss: string, safelistClasses: string[] = []): string {
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

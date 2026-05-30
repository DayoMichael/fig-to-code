import type { JobBuildPreview } from "@fig2code/spec";
import {
  defaultPreviewArgs,
  extractComponentName,
  extractHandlerPropNames,
  pickDefaultStoryExportName,
  resolveInitialPreviewArgs,
} from "./preview-utils.js";

export { pickDefaultStoryExportName };

export interface PreviewMainTsxInput {
  buildPreview: JobBuildPreview;
  componentName: string;
  componentRepoPath: string;
  useDefaultImport: boolean;
  storyRepoPath?: string;
  previewAnnotationsPath?: string;
}

export function usesStorybookPreview(buildPreview: JobBuildPreview): boolean {
  return Boolean(
    buildPreview.storyPath &&
      buildPreview.storyContent &&
      !buildPreview.storyMissing,
  );
}

export function generatePreviewMainTsx(input: PreviewMainTsxInput): string {
  if (input.storyRepoPath && usesStorybookPreview(input.buildPreview)) {
    return generateStorybookMainTsx({
      ...input,
      storyRepoPath: input.storyRepoPath,
    });
  }
  return generateComponentFallbackMainTsx(input);
}

interface StoryHarnessInput extends PreviewMainTsxInput {
  storyRepoPath: string;
}

function resolveStoryPreviewArgs(buildPreview: JobBuildPreview): Record<string, unknown> {
  return resolveInitialPreviewArgs(
    buildPreview.variants ?? {},
    buildPreview.propControls ?? [],
    buildPreview.componentContent,
    buildPreview.storyContent,
  );
}

function generateStorybookMainTsx(input: StoryHarnessInput): string {
  const storyExportName = pickDefaultStoryExportName(
    input.buildPreview.storyContent ?? "",
  );
  const storyImportPath = toHarnessImportPath(input.storyRepoPath);
  const previewImportPath = input.previewAnnotationsPath
    ? toHarnessImportPath(input.previewAnnotationsPath)
    : undefined;

  const args = resolveStoryPreviewArgs(input.buildPreview);
  const handlerProps = [
    ...new Set([
      ...extractHandlerPropNames(input.buildPreview.storyContent ?? ""),
      ...extractHandlerPropNames(input.buildPreview.componentContent ?? ""),
    ]),
  ].sort();

  const extraImports = [
    `import { composeStories, setProjectAnnotations } from '@storybook/react';`,
    `import * as StoryModule from '${storyImportPath}';`,
    previewImportPath
      ? `import * as projectAnnotations from '${previewImportPath}';`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const moduleBootstrap = [
    previewImportPath ? "setProjectAnnotations(projectAnnotations);" : "",
    "const composedStories = composeStories(StoryModule);",
    `const PreviewStory = composedStories[${JSON.stringify(storyExportName)}];`,
    `if (!PreviewStory) {
  throw new Error('Story export ${storyExportName} was not found in ${input.storyRepoPath}');
}`,
    "const STORY_BASE_ARGS: Record<string, unknown> = PreviewStory.args ?? {};",
  ]
    .filter(Boolean)
    .join("\n");

  const previewBody = `<PreviewStory
        key={COMPONENT_NAME + ':' + JSON.stringify(args)}
        {...ensureHandlers({ ...STORY_BASE_ARGS, ...args })}
      />`;

  return sharedHarnessShell({
    componentName: input.componentName,
    defaultArgs: args,
    variants: input.buildPreview.variants ?? {},
    handlerProps,
    variantLabel: input.buildPreview.variantLabel || "Default",
    extraImports,
    moduleBootstrap,
    previewBody,
  });
}

function generateComponentFallbackMainTsx(input: PreviewMainTsxInput): string {
  const exportName = extractComponentName(
    input.buildPreview.componentContent ?? "",
    input.componentName,
  );
  const importPath = toHarnessImportPath(input.componentRepoPath);
  const importStatement = input.useDefaultImport
    ? `import ${exportName} from '${importPath}';`
    : `import { ${exportName} } from '${importPath}';`;

  const args = defaultPreviewArgs(input.buildPreview);
  const handlerProps = extractHandlerPropNames(
    input.buildPreview.componentContent ?? "",
  );

  return sharedHarnessShell({
    componentName: input.componentName,
    defaultArgs: args,
    variants: input.buildPreview.variants ?? {},
    handlerProps,
    variantLabel: input.buildPreview.variantLabel || "Default",
    extraImports: importStatement,
    previewBody: `<${exportName} key={COMPONENT_NAME + ':' + JSON.stringify(args)} {...ensureHandlers(args)} />`,
  });
}

function sharedHarnessShell(input: {
  componentName: string;
  defaultArgs: Record<string, unknown>;
  variants: Record<string, string[]>;
  handlerProps: string[];
  variantLabel: string;
  previewBody: string;
  extraImports?: string;
  moduleBootstrap?: string;
}): string {
  return `import React, { useState, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
${input.extraImports ?? ""}

${input.moduleBootstrap ?? ""}

const COMPONENT_NAME = ${JSON.stringify(input.componentName)};
const DEFAULT_ARGS: Record<string, unknown> = ${JSON.stringify(input.defaultArgs)};
const VARIANTS: Record<string, string[]> = ${JSON.stringify(input.variants)};
const HANDLER_PROPS: string[] = ${JSON.stringify(input.handlerProps)};
const DEFAULT_VARIANT_LABEL = ${JSON.stringify(input.variantLabel)};

class PreviewErrorBoundary extends React.Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch() {}
  render() {
    if (this.state.error) {
      return (
        <div className="preview-error">
          {'Preview failed for ' + COMPONENT_NAME + ': ' + String(this.state.error.message || this.state.error)}
        </div>
      );
    }
    return this.props.children;
  }
}

function applyVariantSelection(selected: Record<string, string>): Record<string, unknown> {
  const next = { ...DEFAULT_ARGS };
  for (const [key, values] of Object.entries(VARIANTS)) {
    const picked = selected?.[key];
    next[key] = picked && values.includes(picked) ? picked : (values[0] ?? next[key]);
  }
  return next;
}

function applyPreviewArgs(incoming: Record<string, unknown>): Record<string, unknown> {
  const next = { ...DEFAULT_ARGS, ...incoming };
  for (const [key, values] of Object.entries(VARIANTS)) {
    const picked = incoming[key];
    if (typeof picked === 'string' && values.includes(picked)) {
      next[key] = picked;
    }
  }
  return next;
}

function formatPreviewActionArgs(args: unknown[]): string {
  return args.map((arg) => {
    if (arg == null) return String(arg);
    if (typeof arg === 'string') return JSON.stringify(arg);
    if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
    if (arg && typeof arg === 'object' && ('nativeEvent' in arg || 'target' in arg)) return 'SyntheticEvent';
    try { return JSON.stringify(arg); } catch { return Object.prototype.toString.call(arg); }
  }).join(', ');
}

function logPreviewAction(name: string, actionArgs: unknown[]) {
  const entry = {
    name,
    detail: formatPreviewActionArgs(actionArgs),
    at: Date.now(),
  };
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'fig2code-preview-action', action: entry }, '*');
  }
}

function ensureHandlers(args: Record<string, unknown>): Record<string, unknown> {
  const next = { ...args };
  for (const key of HANDLER_PROPS) {
    if (!(key in next) || next[key] == null) {
      next[key] = (...a: unknown[]) => logPreviewAction(key, a);
    } else if (typeof next[key] === 'function') {
      const original = next[key] as (...a: unknown[]) => unknown;
      next[key] = (...a: unknown[]) => {
        logPreviewAction(key, a);
        return original(...a);
      };
    }
  }
  return next;
}

function App() {
  const [args, setArgs] = useState(DEFAULT_ARGS);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'fig2code-preview-args') {
        setArgs(applyPreviewArgs(event.data.args ?? {}));
      } else if (event.data?.type === 'fig2code-preview-variants') {
        setArgs(applyVariantSelection(event.data.variants ?? {}));
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    const label = Object.entries(VARIANTS)
      .map(([key, values]) => {
        const picked = args[key];
        const value = typeof picked === 'string' && values.includes(picked) ? picked : (values[0] ?? '?');
        return key + '=' + value;
      })
      .join(', ');
    const el = document.getElementById('fig2code-variant-label');
    if (el) el.textContent = label || DEFAULT_VARIANT_LABEL;
  }, [args]);

  useEffect(() => {
    document.title = COMPONENT_NAME + ' · Preview';
    const nameEl = document.getElementById('fig2code-component-label');
    if (nameEl) nameEl.textContent = COMPONENT_NAME;
  }, []);

  useEffect(() => {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'fig2code-preview-ready' }, '*');
    }
  }, []);

  return (
    <PreviewErrorBoundary key={COMPONENT_NAME}>
      ${input.previewBody}
    </PreviewErrorBoundary>
  );
}

let root: ReturnType<typeof createRoot> | null = null;

function mountPreview() {
  const container = document.getElementById('root');
  if (!container) return;
  if (root) {
    root.unmount();
    root = null;
  }
  root = createRoot(container);
  root.render(<App />);
}

mountPreview();

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    mountPreview();
  });
}
`;
}

function toHarnessImportPath(repoRelativePath: string): string {
  const withoutExt = repoRelativePath.replace(/\.(tsx?|jsx?|mts?|ts|js|mjs)$/, "");
  return `../${withoutExt}`;
}

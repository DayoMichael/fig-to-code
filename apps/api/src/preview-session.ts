import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile as readFs, writeFile, rm, access } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import path from "node:path";
import type { JobBuildPreview, TokenCatalog, VcsConfig } from "@fig2code/spec";
import {
  extractComponentName,
  isDefaultExport,
  defaultPreviewArgs,
  extractExistingPreviewMetadata,
  extractHandlerPropNames,
  extractInjectedTokenCss,
  buildTokenColorUtilityCss,
  buildTailwindConfigFromTokenCss,
  extractTailwindColorClasses,
} from "@fig2code/codegen";
import { storyFormatLabel } from "@fig2code/codegen";
import type { RepoCloneCache } from "./repo-cache.js";
import { resolveHarnessTsConfig } from "./resolve-tsconfig.js";
import { resolvePreviewTheme, type PreviewThemeBundle } from "./preview-theme.js";

export interface PreviewSession {
  jobId: string;
  repoClonePath: string;
  harnessPath: string;
  vitePort: number;
  viteProcess: ChildProcess;
  previewUrl: string;
  startedAt: number;
  lastAccessedAt: number;
  ready: boolean;
  /** Repo-relative paths of generated files (for cleanup). */
  generatedFiles: string[];
  /** Repo-relative path of the component currently loaded in the harness. */
  componentPath?: string;
  componentName?: string;
  harnessConfigKey?: string;
  /** True while an intentional vite restart is in progress (ignore exit events). */
  restartingVite?: boolean;
}

export interface PreviewSessionConfig {
  tokenCatalog?: TokenCatalog;
  vcs: VcsConfig;
  gitToken: string;
  atlassianEmail?: string;
}

export interface StartExistingOptions {
  componentPath: string;
  componentName: string;
  storyPath?: string;
  vcs: VcsConfig;
  gitToken: string;
  atlassianEmail?: string;
  tokenCatalog?: TokenCatalog;
  tokenPaths?: string[];
}

export interface OpenExistingPreviewResult {
  session: PreviewSession;
  reused: boolean;
}

interface SessionManager {
  startSession(
    jobId: string,
    buildPreview: JobBuildPreview,
    config: PreviewSessionConfig,
  ): Promise<PreviewSession>;
  startExistingSession(
    sessionId: string,
    options: StartExistingOptions,
  ): Promise<PreviewSession>;
  openExistingPreview(
    sessionId: string,
    options: StartExistingOptions,
  ): Promise<OpenExistingPreviewResult>;
  recoverVite(sessionId: string): Promise<boolean>;
  stopSession(jobId: string): Promise<void>;
  getSession(jobId: string): PreviewSession | undefined;
  writeFile(jobId: string, filePath: string, content: string): Promise<void>;
  stopAll(): Promise<void>;
}

const MAX_SESSIONS = 4;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const VITE_STARTUP_TIMEOUT_MS = 60_000;
const PREVIEW_DIR = ".fig2code-preview";

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer();
    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("Could not determine port")));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

/**
 * Strip `style="..."` string attributes from JSX — a common LLM mistake.
 * React requires `style={{ ... }}` objects, not CSS strings.
 * Rather than attempting a fragile CSS-string-to-object conversion,
 * we simply remove the attribute since the component should rely on
 * Tailwind / className for styling.
 */
function sanitizeJsxStyleProps(source: string): string {
  return source.replace(
    /\s+style=["'][^"']*["']/g,
    "",
  );
}

// ---------------------------------------------------------------------------
// Harness file generators
// ---------------------------------------------------------------------------

function generateHarnessPackageJson(): string {
  return JSON.stringify(
    {
      name: "fig2code-preview-harness",
      private: true,
      type: "module",
      dependencies: {
        vite: "^6.0.0",
        "@vitejs/plugin-react": "^4.0.0",
      },
    },
    null,
    2,
  );
}

function serializeViteAliases(
  aliases: Record<string, string>,
  reactModules?: { react: string; reactDom: string },
): string {
  const lines = Object.entries(aliases).map(([key, relPath]) => {
    const safeKey = key.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const safePath = relPath.replace(/\\/g, "/");
    return `      '${safeKey}': path.resolve(repoRoot, '${safePath}'),`;
  });
  if (reactModules) {
    lines.push(
      `      react: path.resolve(repoRoot, '${reactModules.react}'),`,
      `      'react-dom': path.resolve(repoRoot, '${reactModules.reactDom}'),`,
      `      'react/jsx-dev-runtime': path.resolve(repoRoot, '${reactModules.react}/jsx-dev-runtime.js'),`,
      `      'react/jsx-runtime': path.resolve(repoRoot, '${reactModules.react}/jsx-runtime.js'),`,
    );
  } else {
    lines.push(
      "      react: path.resolve(repoRoot, 'node_modules/react'),",
      "      'react-dom': path.resolve(repoRoot, 'node_modules/react-dom'),",
    );
  }
  return lines.join("\n");
}

const BASE_OPTIMIZE_INCLUDES = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
];

interface DependencyAlias {
  /** Bare specifier, e.g. "@radix-ui/react-select". */
  name: string;
  /** Posix path to the package dir, relative to repo root. */
  relPath: string;
}

/**
 * Enumerate the component package's React-dependent runtime dependencies so
 * Vite can optimize ALL of them in a single up-front pass.
 *
 * Why this is necessary: when components are swapped, each new component reveals
 * new deps (more @radix-ui/* packages). That forces Vite to re-optimize and emit
 * a SECOND copy of React. Because the harness runs with hmr disabled, Vite can't
 * send its usual post-optimize full-reload, so the live page ends up mixing two
 * React instances → "Invalid hook call" / "Cannot read properties of null
 * (reading 'useState')".
 *
 * We restrict to React-dependent packages because (a) only they can trigger the
 * duplicate-React hook crash, and (b) force-optimizing unrelated/node-only deps
 * risks an esbuild failure that would break the whole dev server.
 *
 * We also return each dep's resolved path so the caller can add an alias for it:
 * with pnpm, @radix-ui/* live under packages/<pkg>/node_modules (not the repo
 * root), so a bare `optimizeDeps.include` entry would fail to resolve from the
 * harness root. The alias makes resolution deterministic.
 */
async function collectDependencyAliases(
  repoClonePath: string,
  componentPackageRoot?: string,
): Promise<DependencyAlias[]> {
  const found = new Map<string, DependencyAlias>();
  const skip = new Set([
    "react",
    "react-dom",
    "react-is",
    "@types/react",
    "@types/react-dom",
  ]);

  const pkgDirs = [
    componentPackageRoot ? path.join(repoClonePath, componentPackageRoot) : null,
    repoClonePath,
  ].filter((d): d is string => Boolean(d));

  for (const pkgDir of pkgDirs) {
    let parsed: { dependencies?: Record<string, string> } | null = null;
    try {
      const raw = await readFs(path.join(pkgDir, "package.json"), "utf-8");
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    for (const [name, version] of Object.entries(parsed?.dependencies ?? {})) {
      if (found.has(name) || skip.has(name) || name.startsWith("@types/")) {
        continue;
      }
      if (/^(workspace:|link:|file:|portal:)/.test(version)) continue;

      const localBase = path.join(pkgDir, "node_modules", name);
      const rootBase = path.join(repoClonePath, "node_modules", name);
      const base = (await pathExists(path.join(localBase, "package.json")))
        ? localBase
        : (await pathExists(path.join(rootBase, "package.json")))
          ? rootBase
          : null;
      if (!base) continue;

      if (await packageDependsOnReact(name, path.join(base, "package.json"))) {
        found.set(name, {
          name,
          relPath: path.relative(repoClonePath, base).split(path.sep).join("/"),
        });
      }
    }
  }

  return [...found.values()];
}

async function packageDependsOnReact(
  name: string,
  pkgJsonPath: string,
): Promise<boolean> {
  if (name.startsWith("@radix-ui/")) return true;
  try {
    const pkg = JSON.parse(await readFs(pkgJsonPath, "utf-8")) as {
      peerDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    return Boolean(pkg.peerDependencies?.react ?? pkg.dependencies?.react);
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function generateHarnessViteConfig(
  basePath?: string,
  aliases?: Record<string, string>,
  reactModules?: { react: string; reactDom: string },
  dependencyAliases: DependencyAlias[] = [],
): string {
  const baseOption = basePath ? `\n  base: '${basePath}',` : "";
  const aliasBlock = serializeViteAliases(
    aliases ?? { "@": "src" },
    reactModules,
  );

  const depAliasBlock = dependencyAliases
    .map(
      ({ name, relPath }) =>
        `      ${JSON.stringify(name)}: path.resolve(repoRoot, ${JSON.stringify(relPath)}),`,
    )
    .join("\n");

  const includeList = [
    ...BASE_OPTIMIZE_INCLUDES,
    ...dependencyAliases.map((d) => d.name),
  ];
  const includeLiteral = JSON.stringify(includeList, null, 6).replace(
    /\n/g,
    "\n    ",
  );

  return `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');

export default defineConfig({${baseOption}
  plugins: [react({ fastRefresh: false })],
  resolve: {
    alias: {
${aliasBlock}${depAliasBlock ? "\n" + depAliasBlock : ""}
    },
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    // Force a single, complete optimize pass before the page renders so React
    // is bundled exactly once and shared by react-dom and every component dep.
    // Prevents mid-session re-optimization (which, with hmr disabled, leaves a
    // stale second copy of React → "Invalid hook call").
    include: ${includeLiteral},
  },
  server: {
    cors: true,
    hmr: false,
    fs: {
      allow: [repoRoot, __dirname],
    },
  },
});
`;
}

function generateHarnessTsConfig(options?: {
  paths?: Record<string, string[]>;
  include?: string[];
}): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2020",
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        strict: false,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmit: true,
        paths: options?.paths ?? { "@/*": ["../src/*"] },
      },
      include: options?.include ?? ["./**/*", "../src/**/*"],
    },
    null,
    2,
  );
}

function formatHtmlOpenTag(attrs: Record<string, string>): string {
  const merged = { lang: "en", ...attrs };
  return Object.entries(merged)
    .map(([key, value]) => `${key}="${value.replace(/"/g, "&quot;")}"`)
    .join(" ");
}

function generateIndexHtml(
  buildPreview: JobBuildPreview,
  componentName: string,
  _config?: PreviewSessionConfig,
  theme?: PreviewThemeBundle | null,
  mainModuleSrc = "/main.tsx",
): string {
  const tokenCss = buildPreview.tokenCss ?? "";
  const injectedTokenCss = tokenCss ? extractInjectedTokenCss(tokenCss) : "";
  const componentContent = buildPreview.componentContent ?? "";
  const storyContent = buildPreview.storyContent ?? "";
  const tokenColorUtilityCss = tokenCss
    ? buildTokenColorUtilityCss(tokenCss, [componentContent, storyContent])
    : "";
  const tokenColorClasses = tokenCss
    ? extractTailwindColorClasses(componentContent, storyContent)
    : [];
  const formatLabel = storyFormatLabel(buildPreview.storyFormat);
  const variantLabel = buildPreview.variantLabel || "Default";

  const themeCss = theme?.css ?? "";
  const combinedTokenCss = [themeCss, injectedTokenCss, tokenColorUtilityCss]
    .filter(Boolean)
    .join("\n\n");

  const tailwindConfigJson = theme?.tailwindConfigJson
    ? theme.tailwindConfigJson
    : tokenCss
      ? buildTailwindConfigFromTokenCss(tokenCss, tokenColorClasses)
      : null;

  const tailwindConfigScript = tailwindConfigJson
    ? `\n    <script>\n      tailwind.config = ${tailwindConfigJson}\n    </script>`
    : "";

  const htmlOpenTag = formatHtmlOpenTag(theme?.htmlAttrs ?? {});

  return `<!DOCTYPE html>
<html ${htmlOpenTag}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${componentName} · Preview</title>
    <script src="https://cdn.tailwindcss.com"></script>${tailwindConfigScript}
    <style>
      :root {
        color-scheme: light;
        font-family: Inter, system-ui, sans-serif;
      }${combinedTokenCss ? `\n${indentCss(combinedTokenCss, 6)}` : ""}
      body {
        margin: 0;
        background: #f8fafc;
        color: #111827;
      }
      .preview-shell {
        min-height: 100vh;
        padding: 20px;
        box-sizing: border-box;
      }
      .preview-frame {
        max-width: 760px;
        margin: 0 auto;
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-radius: 14px;
        box-shadow: 0 10px 30px rgba(15, 23, 42, 0.06);
        overflow: hidden;
      }
      .preview-toolbar {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 16px;
        border-bottom: 1px solid #e5e7eb;
        background: #fcfcfd;
        font-size: 11px;
        color: #6b7280;
      }
      .preview-toolbar strong {
        color: #111827;
        font-size: 12px;
      }
      .preview-canvas {
        padding: 28px;
        min-height: 180px;
        display: flex;
        align-items: flex-start;
        justify-content: stretch;
        width: 100%;
      }
      .preview-canvas #root {
        width: 100%;
      }
      .preview-error {
        color: #b91c1c;
        font-size: 12px;
        line-height: 1.5;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <div class="preview-shell">
      <div class="preview-frame">
        <div class="preview-toolbar">
          <div><strong id="fig2code-component-label">${componentName}</strong> / <span id="fig2code-variant-label">${variantLabel}</span></div>
          <div>${formatLabel}</div>
        </div>
        <div class="preview-canvas"><div id="root"></div></div>
      </div>
    </div>
    <script type="module" src="${mainModuleSrc}"></script>
  </body>
</html>`;
}

function generateMainTsx(
  buildPreview: JobBuildPreview,
  componentName: string,
  useDefaultImport: boolean,
  componentRepoPath: string,
): string {
  const variants = buildPreview.variants ?? {};
  const args = defaultPreviewArgs(buildPreview);
  const handlerProps = extractHandlerPropNames(
    buildPreview.componentContent ?? "",
  );
  const defaultVariantLabel = buildPreview.variantLabel || "Default";

  // Import the component at its real repo path (relative to .fig2code-preview/)
  const importPath =
    "../" + componentRepoPath.replace(/\.(tsx?|jsx?)$/, "");

  const importStatement = useDefaultImport
    ? `import ${componentName} from '${importPath}';`
    : `import { ${componentName} } from '${importPath}';`;

  return `import React, { useState, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
${importStatement}

const COMPONENT_NAME = ${JSON.stringify(componentName)};
const DEFAULT_ARGS: Record<string, unknown> = ${JSON.stringify(args)};
const VARIANTS: Record<string, string[]> = ${JSON.stringify(variants)};
const HANDLER_PROPS: string[] = ${JSON.stringify(handlerProps)};
const DEFAULT_VARIANT_LABEL = ${JSON.stringify(defaultVariantLabel)};

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

  const Component = ${componentName};
  return (
    <PreviewErrorBoundary key={COMPONENT_NAME}>
      <Component key={COMPONENT_NAME + ':' + JSON.stringify(args)} {...ensureHandlers(args)} />
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

function indentCss(css: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return css
    .split("\n")
    .map((line) => (line.trim() ? `${pad}${line}` : line))
    .join("\n");
}

async function readStoryContent(
  repoClonePath: string,
  componentName: string,
  storyPath?: string,
): Promise<{ path?: string; content: string }> {
  if (storyPath) {
    try {
      return {
        path: storyPath,
        content: await readFs(path.join(repoClonePath, storyPath), "utf-8"),
      };
    } catch {
      // fall through to common storybook locations
    }
  }

  const candidates = [
    `apps/storybook/src/stories/${componentName}.stories.tsx`,
    `apps/storybook/src/stories/${componentName}.stories.ts`,
    `apps/storybook/src/stories/${componentName}.stories.jsx`,
  ];

  for (const candidate of candidates) {
    try {
      const content = await readFs(path.join(repoClonePath, candidate), "utf-8");
      if (content.includes(componentName)) {
        return { path: candidate, content };
      }
    } catch {
      // try next candidate
    }
  }

  return { content: "" };
}

interface ExistingPreviewContext {
  componentRepoPath: string;
  componentName: string;
  componentContent: string;
  useDefault: boolean;
  storyPath?: string;
  storyContent: string;
  buildPreview: JobBuildPreview;
}

async function loadExistingPreviewContext(
  repoClonePath: string,
  options: StartExistingOptions,
): Promise<ExistingPreviewContext> {
  const componentRepoPath = options.componentPath;
  let componentContent = "";
  try {
    componentContent = await readFs(
      path.join(repoClonePath, componentRepoPath),
      "utf-8",
    );
  } catch {}

  const componentName = componentContent
    ? extractComponentName(componentContent, options.componentName)
    : options.componentName;
  const useDefault = componentContent
    ? isDefaultExport(componentContent, componentName)
    : false;

  const story = await readStoryContent(
    repoClonePath,
    componentName,
    options.storyPath,
  );
  const previewMetadata = componentContent
    ? extractExistingPreviewMetadata(componentContent, story.content)
    : { variants: {}, variantLabel: "Default", propControls: [] };

  const buildPreview: JobBuildPreview = {
    componentName,
    storyFormat: story.content ? "csf3" : "none",
    componentPath: componentRepoPath,
    componentContent,
    storyPath: story.path ?? options.storyPath,
    storyContent: story.content || undefined,
    variantLabel: previewMetadata.variantLabel,
    variants: previewMetadata.variants,
    propControls: previewMetadata.propControls,
  };

  return {
    componentRepoPath,
    componentName,
    componentContent,
    useDefault,
    storyPath: story.path ?? options.storyPath,
    storyContent: story.content,
    buildPreview,
  };
}

type HarnessTsConfig = Awaited<ReturnType<typeof resolveHarnessTsConfig>>;

function stableHarnessConfigKey(config: HarnessTsConfig): string {
  return JSON.stringify({
    aliases: config.viteAliases,
    paths: config.tsPaths,
    include: config.include,
    reactModules: config.reactModules ?? null,
  });
}

async function harnessDepsInstalled(harnessPath: string): Promise<boolean> {
  try {
    await access(path.join(harnessPath, "node_modules", "vite", "package.json"));
    return true;
  } catch {
    return false;
  }
}

async function startViteForHarness(
  harnessPath: string,
  logLabel: string,
): Promise<{ viteProcess: ChildProcess; previewUrl: string; vitePort: number }> {
  const port = await findFreePort();
  const viteBin = path.join(harnessPath, "node_modules", ".bin", "vite");
  console.log(`[fig2code] starting vite for ${logLabel} on port ${port}`);

  const viteProcess = spawn(
    viteBin,
    ["dev", "--port", String(port), "--host", "127.0.0.1"],
    {
      cwd: harnessPath,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "development" },
      detached: false,
    },
  );
  viteProcess.unref();

  let actualPort: number;
  try {
    actualPort = await waitForViteReady(viteProcess, VITE_STARTUP_TIMEOUT_MS);
  } catch (viteErr) {
    console.error(`[fig2code] vite failed to start`, viteErr);
    try {
      viteProcess.kill("SIGTERM");
    } catch {}
    throw viteErr;
  }
  viteProcess.stdout?.destroy();
  viteProcess.stderr?.destroy();
  const previewUrl = `http://127.0.0.1:${actualPort}`;
  console.log(`[fig2code] preview ready at ${previewUrl} (${logLabel})`);
  return { viteProcess, previewUrl, vitePort: actualPort };
}

function isViteProcessAlive(session: PreviewSession): boolean {
  const proc = session.viteProcess;
  if (!proc || proc.killed) return false;
  return proc.exitCode === null;
}

function attachViteExitHandler(session: PreviewSession): void {
  session.viteProcess.on("exit", (code, signal) => {
    if (session.restartingVite) return;
    console.warn(
      `[fig2code] vite exited session=${session.jobId} code=${code ?? "?"} signal=${signal ?? ""}`,
    );
    session.ready = false;
  });
}

async function waitForViteResponding(
  session: PreviewSession,
  timeoutMs = 8000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isViteProcessAlive(session)) return false;
    try {
      const res = await fetch(`${session.previewUrl}/`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.status < 500) return true;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Vite process helpers
// ---------------------------------------------------------------------------

async function waitForViteReady(
  proc: ChildProcess,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Vite dev server failed to start within timeout"));
    }, timeoutMs);

    let output = "";

    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const portMatch = output.match(
        /Local:\s+https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/,
      );
      if (portMatch) {
        clearTimeout(timer);
        proc.stdout?.off("data", onData);
        proc.stderr?.off("data", onData);
        resolve(Number(portMatch[1]));
      }
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Vite exited with code ${code}. Output:\n${output}`));
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function installHarnessDeps(harnessPath: string): Promise<void> {
  if (await harnessDepsInstalled(harnessPath)) {
    console.log(`[fig2code] harness deps already installed — skipping npm install`);
    return;
  }

  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((resolve, reject) => {
    const child = spawn(
      npmBin,
      ["install", "--no-audit", "--no-fund", "--loglevel", "error"],
      {
        cwd: harnessPath,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      },
    );

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `npm install (preview harness) failed (exit ${code}): ${stderr}`,
          ),
        );
    });

    child.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Session manager
// ---------------------------------------------------------------------------

export function createPreviewSessionManager(
  repoCache: RepoCloneCache,
): SessionManager {
  const sessions = new Map<string, PreviewSession>();
  const sessionStartup = new Map<string, Promise<PreviewSession>>();
  const swapLocks = new Map<string, Promise<PreviewSession>>();
  const recoveryLocks = new Map<string, Promise<boolean>>();
  let idleCheckInterval: ReturnType<typeof setInterval> | null = null;

  function startIdleCheck() {
    if (idleCheckInterval) return;
    idleCheckInterval = setInterval(() => {
      const now = Date.now();
      for (const [jobId, session] of sessions) {
        if (now - session.lastAccessedAt > IDLE_TIMEOUT_MS) {
          console.log(`[fig2code] preview session idle timeout: ${jobId}`);
          void stopSession(jobId);
        }
      }
      if (sessions.size === 0 && idleCheckInterval) {
        clearInterval(idleCheckInterval);
        idleCheckInterval = null;
      }
    }, 30_000);
  }

  async function evictOldest(): Promise<void> {
    if (sessions.size < MAX_SESSIONS) return;
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, session] of sessions) {
      if (session.lastAccessedAt < oldestTime) {
        oldestTime = session.lastAccessedAt;
        oldestId = id;
      }
    }
    if (oldestId) {
      await stopSession(oldestId);
    }
  }

  async function startSession(
    jobId: string,
    buildPreview: JobBuildPreview,
    config: PreviewSessionConfig,
  ): Promise<PreviewSession> {
    const existing = sessions.get(jobId);
    if (existing) {
      existing.lastAccessedAt = Date.now();
      return existing;
    }

    await evictOldest();

    // 1. Get or create cached repo clone with deps installed
    const repoClonePath = await repoCache.getOrClone(
      config.vcs,
      config.gitToken,
      config.atlassianEmail,
    );

    // 2. Set up the preview harness directory inside the clone
    const harnessPath = path.join(repoClonePath, PREVIEW_DIR);
    await mkdir(harnessPath, { recursive: true });

    const componentContent = buildPreview.componentContent ?? "";
    const storyContent = buildPreview.storyContent ?? "";
    const componentName = extractComponentName(
      componentContent,
      buildPreview.componentName,
    );
    const useDefault = isDefaultExport(componentContent, componentName);

    // Determine the real repo path for the component
    const componentRepoPath =
      buildPreview.componentPath || `src/components/${componentName}.tsx`;

    const generatedFiles: string[] = [];

    // 3. Write generated component/story files at their real repo paths
    if (componentContent) {
      const fullPath = path.join(repoClonePath, componentRepoPath);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, sanitizeJsxStyleProps(componentContent), "utf-8");
      generatedFiles.push(componentRepoPath);
    }

    if (storyContent && buildPreview.storyPath) {
      const fullPath = path.join(repoClonePath, buildPreview.storyPath);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, sanitizeJsxStyleProps(storyContent), "utf-8");
      generatedFiles.push(buildPreview.storyPath);
    }

    // Also write any extra files from codegen patches
    if (buildPreview.files) {
      for (const file of buildPreview.files) {
        if (file.action === "delete" || !file.content) continue;
        if (file.path === componentRepoPath) continue;
        if (file.path === buildPreview.storyPath) continue;
        const fullPath = path.join(repoClonePath, file.path);
        await mkdir(path.dirname(fullPath), { recursive: true });
        await writeFile(fullPath, sanitizeJsxStyleProps(file.content), "utf-8");
        generatedFiles.push(file.path);
      }
    }

    // 4. Write the preview harness files
    const harnessConfig = await resolveHarnessTsConfig(
      repoClonePath,
      componentRepoPath,
    );
    const dependencyAliases = await collectDependencyAliases(
      repoClonePath,
      harnessConfig.componentPackageRoot,
    );

    const harnessFiles: Array<[string, string]> = [
      [
        path.join(harnessPath, "package.json"),
        generateHarnessPackageJson(),
      ],
      [
        path.join(harnessPath, "vite.config.ts"),
        generateHarnessViteConfig(
          `/jobs/${jobId}/preview/`,
          harnessConfig.viteAliases,
          harnessConfig.reactModules,
          dependencyAliases,
        ),
      ],
      [
        path.join(harnessPath, "tsconfig.json"),
        generateHarnessTsConfig({
          paths: harnessConfig.tsPaths,
          include: harnessConfig.include,
        }),
      ],
      [
        path.join(harnessPath, "index.html"),
        generateIndexHtml(buildPreview, componentName, config),
      ],
      [
        path.join(harnessPath, "main.tsx"),
        generateMainTsx(
          buildPreview,
          componentName,
          useDefault,
          componentRepoPath,
        ),
      ],
    ];

    await Promise.all(
      harnessFiles.map(([p, content]) => writeFile(p, content, "utf-8")),
    );

    // 5. Install harness deps (just vite + react plugin, fast)
    console.log(`[fig2code] installing preview harness deps in ${harnessPath}`);
    await installHarnessDeps(harnessPath);

    // 6. Start Vite dev server from the harness directory
    const port = await findFreePort();
    const viteBin = path.join(harnessPath, "node_modules", ".bin", "vite");

    console.log(
      `[fig2code] starting vite dev server on port ${port} for job ${jobId}`,
    );
    const viteProcess = spawn(
      viteBin,
      ["dev", "--port", String(port), "--host", "127.0.0.1"],
      {
        cwd: harnessPath,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NODE_ENV: "development" },
        detached: false,
      },
    );
    viteProcess.unref();

    const actualPort = await waitForViteReady(
      viteProcess,
      VITE_STARTUP_TIMEOUT_MS,
    );
    viteProcess.stdout?.destroy();
    viteProcess.stderr?.destroy();
    const previewUrl = `http://127.0.0.1:${actualPort}`;

    console.log(
      `[fig2code] vite dev server ready at ${previewUrl} for job ${jobId}`,
    );

    const session: PreviewSession = {
      jobId,
      repoClonePath,
      harnessPath,
      vitePort: actualPort,
      viteProcess,
      previewUrl,
      startedAt: Date.now(),
      lastAccessedAt: Date.now(),
      ready: true,
      generatedFiles,
    };
    attachViteExitHandler(session);

    sessions.set(jobId, session);
    startIdleCheck();
    return session;
  }

  async function stopSession(jobId: string): Promise<void> {
    const session = sessions.get(jobId);
    if (!session) return;

    sessions.delete(jobId);

    try {
      session.viteProcess.kill("SIGTERM");
    } catch {}

    // Clean up the preview harness directory
    try {
      await rm(session.harnessPath, { recursive: true, force: true });
    } catch (err) {
      console.warn(
        `[fig2code] failed to clean up harness: ${session.harnessPath}`,
        err,
      );
    }

    // Clean up generated files from the clone (but not the clone itself)
    for (const relPath of session.generatedFiles) {
      try {
        const fullPath = path.join(session.repoClonePath, relPath);
        await rm(fullPath, { force: true });
      } catch {}
    }

    console.log(`[fig2code] preview session stopped: ${jobId}`);
  }

  function getSession(jobId: string): PreviewSession | undefined {
    const session = sessions.get(jobId);
    if (session) {
      session.lastAccessedAt = Date.now();
    }
    return session;
  }

  async function writeFileToWorkspace(
    jobId: string,
    filePath: string,
    content: string,
  ): Promise<void> {
    const session = sessions.get(jobId);
    if (!session) {
      throw new Error(`No active preview session for job ${jobId}`);
    }
    session.lastAccessedAt = Date.now();

    // Write to the real repo path in the clone (triggers Vite HMR)
    const targetPath = path.join(session.repoClonePath, filePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, "utf-8");

    if (!session.generatedFiles.includes(filePath)) {
      session.generatedFiles.push(filePath);
    }
  }

  async function writeExistingHarnessFiles(
    sessionId: string,
    harnessPath: string,
    repoClonePath: string,
    options: StartExistingOptions,
    ctx: ExistingPreviewContext,
    mode: "full" | "swap",
  ): Promise<void> {
    const harnessConfig = await resolveHarnessTsConfig(
      repoClonePath,
      ctx.componentRepoPath,
    );
    const previewTheme = await resolvePreviewTheme(
      repoClonePath,
      ctx.componentRepoPath,
      options.tokenPaths,
    );
    const mainModuleSrc =
      mode === "swap" ? `/main.tsx?v=${Date.now()}` : "/main.tsx";

    const dependencyAliases =
      mode === "full"
        ? await collectDependencyAliases(
            repoClonePath,
            harnessConfig.componentPackageRoot,
          )
        : [];

    if (mode === "swap") {
      await Promise.all([
        writeFile(
          path.join(harnessPath, "main.tsx"),
          generateMainTsx(
            ctx.buildPreview,
            ctx.componentName,
            ctx.useDefault,
            ctx.componentRepoPath,
          ),
          "utf-8",
        ),
        writeFile(
          path.join(harnessPath, "index.html"),
          generateIndexHtml(
            ctx.buildPreview,
            ctx.componentName,
            {
              vcs: options.vcs,
              gitToken: options.gitToken,
              tokenCatalog: options.tokenCatalog,
            },
            previewTheme,
            mainModuleSrc,
          ),
          "utf-8",
        ),
      ]);
      return;
    }

    const files: Array<[string, string]> = [
      [path.join(harnessPath, "package.json"), generateHarnessPackageJson()],
      [
        path.join(harnessPath, "vite.config.ts"),
        generateHarnessViteConfig(
          `/preview/existing/${sessionId}/`,
          harnessConfig.viteAliases,
          harnessConfig.reactModules,
          dependencyAliases,
        ),
      ],
      [
        path.join(harnessPath, "tsconfig.json"),
        generateHarnessTsConfig({
          paths: harnessConfig.tsPaths,
          include: harnessConfig.include,
        }),
      ],
      [
        path.join(harnessPath, "index.html"),
        generateIndexHtml(
          ctx.buildPreview,
          ctx.componentName,
          {
            vcs: options.vcs,
            gitToken: options.gitToken,
            tokenCatalog: options.tokenCatalog,
          },
          previewTheme,
          mainModuleSrc,
        ),
      ],
      [
        path.join(harnessPath, "main.tsx"),
        generateMainTsx(
          ctx.buildPreview,
          ctx.componentName,
          ctx.useDefault,
          ctx.componentRepoPath,
        ),
      ],
    ];

    await Promise.all(files.map(([filePath, content]) => writeFile(filePath, content, "utf-8")));
  }

  async function restartViteForSession(
    session: PreviewSession,
    logLabel: string,
  ): Promise<void> {
    session.restartingVite = true;
    try {
      try {
        session.viteProcess.kill("SIGTERM");
      } catch {}
      const started = await startViteForHarness(session.harnessPath, logLabel);
      session.viteProcess = started.viteProcess;
      session.previewUrl = started.previewUrl;
      session.vitePort = started.vitePort;
      attachViteExitHandler(session);
    } finally {
      session.restartingVite = false;
    }
  }

  async function recoverViteSession(sessionId: string): Promise<boolean> {
    const pending = recoveryLocks.get(sessionId);
    if (pending) return pending;

    const work = (async () => {
      const session = sessions.get(sessionId);
      if (!session) return false;

      if (
        session.ready &&
        isViteProcessAlive(session) &&
        (await waitForViteResponding(session, 2000))
      ) {
        return true;
      }

      const swapPending = swapLocks.get(sessionId);
      if (swapPending) {
        await swapPending;
        const refreshed = sessions.get(sessionId);
        if (
          refreshed?.ready &&
          isViteProcessAlive(refreshed) &&
          (await waitForViteResponding(refreshed, 2000))
        ) {
          return true;
        }
      }

      if (!session.componentName) {
        session.ready = false;
        return false;
      }

      console.warn(`[fig2code] recovering dead vite session ${sessionId}`);
      session.ready = false;
      try {
        await restartViteForSession(session, session.componentName);
        session.ready = await waitForViteResponding(session, 15000);
        return session.ready;
      } catch (err) {
        console.error(`[fig2code] vite recovery failed for ${sessionId}`, err);
        session.ready = false;
        return false;
      }
    })();

    recoveryLocks.set(sessionId, work);
    try {
      return await work;
    } finally {
      recoveryLocks.delete(sessionId);
    }
  }

  async function coldStartExistingSession(
    sessionId: string,
    options: StartExistingOptions,
  ): Promise<PreviewSession> {
    await evictOldest();

    const repoClonePath = await repoCache.getOrClone(
      options.vcs,
      options.gitToken,
      options.atlassianEmail,
    );

    const harnessPath = path.join(repoClonePath, PREVIEW_DIR);
    await mkdir(harnessPath, { recursive: true });

    const ctx = await loadExistingPreviewContext(repoClonePath, options);
    const harnessConfig = await resolveHarnessTsConfig(
      repoClonePath,
      ctx.componentRepoPath,
    );
    const configKey = stableHarnessConfigKey(harnessConfig);

    console.log(
      `[fig2code] cold-start preview for ${ctx.componentName} at ${ctx.componentRepoPath}`,
    );
    console.log(`[fig2code] preview aliases:`, harnessConfig.viteAliases);
    console.log(`[fig2code] preview variants:`, ctx.buildPreview.variants);

    await writeExistingHarnessFiles(
      sessionId,
      harnessPath,
      repoClonePath,
      options,
      ctx,
      "full",
    );

    console.log(`[fig2code] installing preview harness deps for existing component`);
    try {
      await installHarnessDeps(harnessPath);
    } catch (installErr) {
      console.error(`[fig2code] harness npm install failed`, installErr);
      throw installErr;
    }

    const started = await startViteForHarness(
      harnessPath,
      `existing component ${ctx.componentName}`,
    );

    const session: PreviewSession = {
      jobId: sessionId,
      repoClonePath,
      harnessPath,
      vitePort: started.vitePort,
      viteProcess: started.viteProcess,
      previewUrl: started.previewUrl,
      startedAt: Date.now(),
      lastAccessedAt: Date.now(),
      ready: true,
      generatedFiles: [],
      componentPath: ctx.componentRepoPath,
      componentName: ctx.componentName,
      harnessConfigKey: configKey,
    };
    attachViteExitHandler(session);

    sessions.set(sessionId, session);
    startIdleCheck();
    return session;
  }

  async function swapExistingComponent(
    session: PreviewSession,
    options: StartExistingOptions,
  ): Promise<PreviewSession> {
    const pending = swapLocks.get(session.jobId);
    if (pending) {
      return pending;
    }

    const work = (async () => {
      const ctx = await loadExistingPreviewContext(session.repoClonePath, options);

      if (
        session.componentPath === ctx.componentRepoPath &&
        session.componentName === ctx.componentName
      ) {
        session.lastAccessedAt = Date.now();
        return session;
      }

      console.log(
        `[fig2code] swapping preview component → ${ctx.componentName} (${ctx.componentRepoPath})`,
      );

      const harnessConfig = await resolveHarnessTsConfig(
        session.repoClonePath,
        ctx.componentRepoPath,
      );
      const configKey = stableHarnessConfigKey(harnessConfig);
      const configChanged = session.harnessConfigKey !== configKey;

      session.ready = false;
      try {
        if (configChanged) {
          console.log(`[fig2code] preview harness config changed — restarting vite`);
          await writeExistingHarnessFiles(
            session.jobId,
            session.harnessPath,
            session.repoClonePath,
            options,
            ctx,
            "full",
          );
          await restartViteForSession(session, ctx.componentName);
          session.harnessConfigKey = configKey;
        } else {
          await writeExistingHarnessFiles(
            session.jobId,
            session.harnessPath,
            session.repoClonePath,
            options,
            ctx,
            "swap",
          );
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } catch (err) {
        console.error(`[fig2code] preview swap failed`, err);
        session.ready = false;
        throw err;
      }

      session.componentPath = ctx.componentRepoPath;
      session.componentName = ctx.componentName;
      session.lastAccessedAt = Date.now();

      if (isViteProcessAlive(session) && (await waitForViteResponding(session))) {
        session.ready = true;
      } else {
        console.warn(
          `[fig2code] vite unhealthy after swap — attempting recovery for ${session.jobId}`,
        );
        session.ready = false;
        await recoverViteSession(session.jobId);
      }

      return session;
    })();

    swapLocks.set(session.jobId, work);
    try {
      return await work;
    } finally {
      swapLocks.delete(session.jobId);
    }
  }

  async function openExistingPreview(
    sessionId: string,
    options: StartExistingOptions,
  ): Promise<OpenExistingPreviewResult> {
    let existing = sessions.get(sessionId);

    if (existing && (!existing.ready || !isViteProcessAlive(existing))) {
      await recoverViteSession(sessionId);
      existing = sessions.get(sessionId);
    }

    if (existing?.ready) {
      const session = await swapExistingComponent(existing, options);
      return { session, reused: true };
    }

    const inFlight = sessionStartup.get(sessionId);
    if (inFlight) {
      await inFlight;
      existing = sessions.get(sessionId);
      if (existing?.ready) {
        const session = await swapExistingComponent(existing, options);
        return { session, reused: true };
      }
    }

    const startup = coldStartExistingSession(sessionId, options);
    sessionStartup.set(sessionId, startup);
    try {
      const session = await startup;
      return { session, reused: false };
    } finally {
      sessionStartup.delete(sessionId);
    }
  }

  async function startExistingSession(
    sessionId: string,
    options: StartExistingOptions,
  ): Promise<PreviewSession> {
    const result = await openExistingPreview(sessionId, options);
    return result.session;
  }

  async function stopAll(): Promise<void> {
    const ids = [...sessions.keys()];
    await Promise.all(ids.map((id) => stopSession(id)));
    if (idleCheckInterval) {
      clearInterval(idleCheckInterval);
      idleCheckInterval = null;
    }
  }

  const cleanup = () => {
    for (const session of sessions.values()) {
      try {
        session.viteProcess.kill("SIGTERM");
      } catch {}
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  return {
    startSession,
    startExistingSession,
    openExistingPreview,
    recoverVite: recoverViteSession,
    stopSession,
    getSession,
    writeFile: writeFileToWorkspace,
    stopAll,
  };
}

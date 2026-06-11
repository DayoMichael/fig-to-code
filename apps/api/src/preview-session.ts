import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile as readFs, writeFile, rm, access } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import path from "node:path";
import type { JobBuildPreview, TokenCatalog, VcsConfig, FormatterPreference, ThemeCatalog, ThemeSelection } from "@fig2code/spec";
import {
  extractComponentName,
  isDefaultExport,
  extractExistingPreviewMetadata,
  extractInjectedTokenCss,
  buildTokenColorUtilityCss,
  buildTailwindConfigFromTokenCss,
  extractTailwindColorClasses,
  generatePreviewMainTsx,
  usesStorybookPreview,
  isAppendExportPatch,
  mergeAppendExportIntoContent,
  formatJobBuildPreview,
} from "@fig2code/codegen";
import { storyFormatLabel } from "@fig2code/codegen";
import { repoPreviewSessionId, type RepoCloneCache } from "./repo-cache.js";
import { resolveHarnessTsConfig } from "./resolve-tsconfig.js";
import { buildStoryFileCandidates } from "@fig2code/repo";
import {
  extendHarnessIncludeForStory,
  mergeHarnessAliases,
  isStorybookToolingPackage,
  preparePreviewAnnotationsForHarness,
  resolveStorybookHarnessSupport,
  sanitizeStorybookHarnessDependencies,
} from "./storybook-harness.js";
import { resolvePreviewTheme, isDarkPreviewMode, type PreviewThemeBundle } from "./preview-theme.js";

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
  /** Hash of the harness dependency set; a change forces a cold start. */
  harnessDepsKey?: string;
  /** Stable preview base path the browser is redirected to (codegen sessions). */
  basePath?: string;
  /** True while an intentional vite restart is in progress (ignore exit events). */
  restartingVite?: boolean;
  themeSelection?: ThemeSelection;
  harnessContext?: PreviewHarnessContext;
}

interface PreviewHarnessContext {
  buildPreview: JobBuildPreview;
  componentName: string;
  componentRepoPath: string;
  useDefault: boolean;
  config: PreviewSessionConfig;
}

export interface PreviewSessionConfig {
  tokenCatalog?: TokenCatalog;
  vcs: VcsConfig;
  gitToken: string;
  atlassianEmail?: string;
  formatter?: FormatterPreference;
  tokenPaths?: string[];
  themeCatalog?: ThemeCatalog | null;
  themeSelection?: Partial<ThemeSelection>;
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
  themeCatalog?: ThemeCatalog | null;
  themeSelection?: Partial<ThemeSelection>;
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
  updatePreviewTheme(
    jobId: string,
    selection: Partial<ThemeSelection>,
  ): Promise<ThemeSelection | null>;
  stopAll(): Promise<void>;
}

const MAX_SESSIONS = 4;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const VITE_STARTUP_TIMEOUT_MS = Number(
  process.env.FIG2CODE_VITE_STARTUP_TIMEOUT_MS ?? 180_000,
);
const VITE_WARMUP_TIMEOUT_MS = Number(
  process.env.FIG2CODE_VITE_WARMUP_TIMEOUT_MS ?? 120_000,
);
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

// Bump when harness install/layout changes so stale preview dirs are rebuilt.
const HARNESS_SCHEMA_VERSION = 3;

function generateHarnessPackageJson(
  extraDependencies: Record<string, string> = {},
): string {
  const dependencies = sanitizeStorybookHarnessDependencies({
    vite: "^6.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    ...extraDependencies,
  });

  return JSON.stringify(
    {
      name: "fig2code-preview-harness",
      private: true,
      type: "module",
      fig2codeHarnessVersion: HARNESS_SCHEMA_VERSION,
      dependencies,
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
  extraOptimizeIncludes: string[] = [],
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
    ...extraOptimizeIncludes.filter((name) => !isStorybookToolingPackage(name)),
  ];
  const includeLiteral = JSON.stringify(includeList, null, 6).replace(
    /\n/g,
    "\n    ",
  );
  const excludeLiteral = JSON.stringify(
    [
      "@storybook/addon-essentials",
      "@storybook/addon-interactions",
      "@storybook/addon-links",
      "@storybook/blocks",
      "@storybook/react-vite",
      "storybook",
    ],
    null,
    6,
  ).replace(/\n/g, "\n    ");

  return `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');

/** Preview harness runs behind a proxy with HMR disabled — drop @vite/client to avoid WS noise. */
function fig2codePreviewHarnessPlugin() {
  return {
    name: 'fig2code-preview-harness',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        // Match any <script …@vite/client…></script> regardless of attribute
        // order or base-path prefix — the proxy can't tunnel the HMR socket, so
        // the client must be fully removed to avoid endless WS-connect errors.
        return html.replace(
          /<script\\b[^>]*@vite\\/client[^>]*><\\/script>\\s*/g,
          '',
        );
      },
    },
  };
}

export default defineConfig({${baseOption}
  plugins: [fig2codePreviewHarnessPlugin(), react({ fastRefresh: false })],
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
    exclude: ${excludeLiteral},
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
  const formatLabel = buildPreview.storyMissing
    ? "Component fallback (no story)"
    : usesStorybookPreview(buildPreview)
      ? "Storybook preview"
      : storyFormatLabel(buildPreview.storyFormat);
  const variantLabel = buildPreview.variantLabel || "Default";
  const storyNotice = buildPreview.storyMissing
    ? `<div class="preview-notice">No Storybook story found — showing component fallback preview.</div>`
    : "";

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
  const isDark = isDarkPreviewMode(theme?.selection.mode);
  const shellBg = isDark ? "#0b1220" : "#f8fafc";
  const shellText = isDark ? "#e5e7eb" : "#111827";
  const frameBg = isDark ? "#111827" : "#ffffff";
  const frameBorder = isDark ? "#374151" : "#e5e7eb";
  const toolbarBg = isDark ? "#1f2937" : "#fcfcfd";
  const mutedText = isDark ? "#9ca3af" : "#6b7280";

  return `<!DOCTYPE html>
<html ${htmlOpenTag}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${componentName} · Preview</title>
    <script src="https://cdn.tailwindcss.com"></script>${tailwindConfigScript}
    <style>
      :root {
        color-scheme: ${isDark ? "dark" : "light"};
        font-family: Inter, system-ui, sans-serif;
      }${combinedTokenCss ? `\n${indentCss(combinedTokenCss, 6)}` : ""}
      body {
        margin: 0;
        background: ${shellBg};
        color: ${shellText};
      }
      .preview-shell {
        min-height: 100vh;
        padding: 20px;
        box-sizing: border-box;
      }
      .preview-frame {
        max-width: 760px;
        margin: 0 auto;
        background: ${frameBg};
        border: 1px solid ${frameBorder};
        border-radius: 14px;
        box-shadow: 0 10px 30px rgba(15, 23, 42, ${isDark ? "0.35" : "0.06"});
        overflow: hidden;
      }
      .preview-toolbar {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 16px;
        border-bottom: 1px solid ${frameBorder};
        background: ${toolbarBg};
        font-size: 11px;
        color: ${mutedText};
      }
      .preview-toolbar strong {
        color: ${shellText};
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
      .preview-notice {
        margin: 0 0 12px;
        padding: 10px 12px;
        border-radius: 8px;
        background: #fffbeb;
        border: 1px solid #fcd34d;
        color: #92400e;
        font-size: 12px;
        line-height: 1.4;
      }
      /* Boot spinner: lives inside #root so React's first render replaces it
         the instant the component mounts. Covers the module-load window
         between this HTML arriving and main.tsx finishing. */
      .fig2code-boot {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 32px 0;
        color: ${mutedText};
        font-size: 12px;
      }
      .fig2code-boot-spinner {
        width: 22px;
        height: 22px;
        border: 2px solid ${frameBorder};
        border-top-color: ${mutedText};
        border-radius: 50%;
        animation: fig2code-spin 0.8s linear infinite;
      }
      @keyframes fig2code-spin { to { transform: rotate(360deg); } }
    </style>
  </head>
  <body>
    <div class="preview-shell">
      <div class="preview-frame">
        <div class="preview-toolbar">
          <div><strong id="fig2code-component-label">${componentName}</strong> / <span id="fig2code-variant-label">${variantLabel}</span></div>
          <div>${formatLabel}</div>
        </div>
        <div class="preview-canvas">${storyNotice}<div id="root"><div class="fig2code-boot"><div class="fig2code-boot-spinner"></div><div>Loading ${componentName}…</div></div></div></div>
      </div>
    </div>
    <script>
      // If the entry module fails before React mounts (e.g. a bad import in
      // generated code), surface the error in place of the boot spinner
      // instead of spinning forever.
      window.addEventListener('error', function (e) {
        var boot = document.querySelector('.fig2code-boot');
        if (!boot) return; // component already mounted
        var msg = document.createElement('div');
        msg.className = 'preview-error';
        msg.textContent = 'Preview failed to load: ' + (e.message || 'module error — see console');
        boot.replaceChildren(msg);
      }, true);
    </script>
    <script type="module" src="${mainModuleSrc}"></script>
  </body>
</html>`;
}

function generateMainTsx(
  buildPreview: JobBuildPreview,
  componentName: string,
  useDefaultImport: boolean,
  componentRepoPath: string,
  storybook?: {
    storyRepoPath?: string;
    previewAnnotationsPath?: string;
  },
): string {
  return generatePreviewMainTsx({
    buildPreview,
    componentName,
    componentRepoPath,
    useDefaultImport,
    storyRepoPath: storybook?.storyRepoPath,
    previewAnnotationsPath: storybook?.previewAnnotationsPath,
  });
}

async function resolvePreviewHarnessContext(
  repoClonePath: string,
  componentRepoPath: string,
  buildPreview: JobBuildPreview,
): Promise<{
  harnessConfig: Awaited<ReturnType<typeof resolveHarnessTsConfig>>;
  dependencyAliases: DependencyAlias[];
  storybook?: Awaited<ReturnType<typeof resolveStorybookHarnessSupport>>;
  viteAliases: Record<string, string>;
  harnessDependencies: Record<string, string>;
  tsInclude: string[];
}> {
  const harnessConfig = await resolveHarnessTsConfig(
    repoClonePath,
    componentRepoPath,
  );
  const storyRepoPath =
    buildPreview.storyPath && !buildPreview.storyMissing
      ? buildPreview.storyPath
      : undefined;
  const storybook = storyRepoPath
    ? await resolveStorybookHarnessSupport(repoClonePath, storyRepoPath)
    : undefined;

  const dependencyAliases = await collectDependencyAliases(
    repoClonePath,
    harnessConfig.componentPackageRoot,
  );

  return {
    harnessConfig,
    dependencyAliases,
    storybook,
    viteAliases: mergeHarnessAliases(
      harnessConfig.viteAliases,
      storybook?.viteAliases ?? {},
    ),
    harnessDependencies: storybook?.harnessDependencies ?? {},
    tsInclude: extendHarnessIncludeForStory(
      harnessConfig.include,
      storyRepoPath,
      storybook?.previewAnnotationsPath,
    ),
  };
}

function storybookHarnessOptions(
  buildPreview: JobBuildPreview,
  storybook?: Awaited<ReturnType<typeof resolveStorybookHarnessSupport>>,
): { storyRepoPath?: string; previewAnnotationsPath?: string } | undefined {
  if (!buildPreview.storyPath || buildPreview.storyMissing) {
    return undefined;
  }
  return {
    storyRepoPath: buildPreview.storyPath,
    previewAnnotationsPath: storybook?.previewAnnotationsPath,
  };
}

async function resolveStorybookHarnessOptions(
  repoClonePath: string,
  harnessPath: string,
  buildPreview: JobBuildPreview,
  previewHarness: Awaited<ReturnType<typeof resolvePreviewHarnessContext>>,
): Promise<{ storyRepoPath?: string; previewAnnotationsPath?: string } | undefined> {
  const base = storybookHarnessOptions(buildPreview, previewHarness.storybook);
  if (!base?.previewAnnotationsPath) {
    return base;
  }

  const previewAnnotationsPath = await preparePreviewAnnotationsForHarness(
    repoClonePath,
    harnessPath,
    base.previewAnnotationsPath,
    previewHarness.viteAliases,
  );

  return {
    ...base,
    previewAnnotationsPath,
  };
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
  componentRepoPath?: string,
): Promise<{ path?: string; content: string }> {
  if (storyPath) {
    try {
      return {
        path: storyPath,
        content: await readFs(path.join(repoClonePath, storyPath), "utf-8"),
      };
    } catch {
      // fall through to candidate lookup
    }
  }

  const candidates = componentRepoPath
    ? buildStoryFileCandidates(componentRepoPath, componentName)
    : [
        `apps/storybook/src/stories/${componentName}.stories.tsx`,
        `apps/storybook/src/stories/${componentName}.stories.ts`,
        `apps/storybook/src/stories/${componentName}.stories.jsx`,
      ];

  for (const candidate of candidates) {
    try {
      const content = await readFs(path.join(repoClonePath, candidate), "utf-8");
      if (content.trim()) {
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

  const exportName = componentContent
    ? extractComponentName(componentContent, options.componentName)
    : options.componentName;
  const componentName = options.componentName;
  const useDefault = componentContent
    ? isDefaultExport(componentContent, exportName)
    : false;

  const story = await readStoryContent(
    repoClonePath,
    componentName,
    options.storyPath,
    componentRepoPath,
  );
  const previewMetadata = componentContent
    ? extractExistingPreviewMetadata(componentContent, story.content)
    : { variants: {}, variantLabel: "Default", propControls: [] };

  const buildPreview: JobBuildPreview = {
    componentName,
    storyFormat: story.content ? "csf3" : "none",
    storyMissing: !story.content,
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

/**
 * Force Vite's first (cold) optimizeDeps + entry transform pass to happen
 * server-side, before the browser ever loads the iframe. Otherwise that pass —
 * which is multi-second on a cold/slow host with a large component library —
 * runs on the browser's first request and blows past the client readiness
 * timeout, surfacing as "Preview did not load …".
 */
async function warmUpVite(
  previewUrl: string,
  basePath: string,
  logLabel: string,
): Promise<void> {
  const entry = `${previewUrl}${basePath}main.tsx`;
  const startedAt = Date.now();
  try {
    const res = await fetch(entry, {
      signal: AbortSignal.timeout(VITE_WARMUP_TIMEOUT_MS),
    });
    // Drain the body so the transform fully completes before we report ready.
    await res.text();
    console.log(
      `[fig2code] warmed vite for ${logLabel} in ${Date.now() - startedAt}ms (entry ${res.status})`,
    );
  } catch (err) {
    console.warn(
      `[fig2code] vite warm-up skipped for ${logLabel}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Continuously drain Vite's stdout/stderr to our log. Must keep reading for the
 * life of the process — an unread pipe buffer fills and blocks the Vite child on
 * its next write. Also surfaces Vite's own messages (notably mid-session dep
 * re-optimization, which with HMR disabled is what silently breaks a live
 * preview when swapping to a component that pulls in new dependencies).
 */
function forwardViteOutput(proc: ChildProcess, logLabel: string): void {
  const forward = (chunk: Buffer) => {
    const text = chunk.toString().trimEnd();
    if (text) console.log(`[vite:${logLabel}] ${text}`);
  };
  proc.stdout?.on("data", forward);
  proc.stderr?.on("data", forward);
}

async function startViteForHarness(
  harnessPath: string,
  logLabel: string,
  basePath?: string,
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
    actualPort = await waitForViteReady(
      viteProcess,
      VITE_STARTUP_TIMEOUT_MS,
      port,
    );
  } catch (viteErr) {
    console.error(`[fig2code] vite failed to start`, viteErr);
    try {
      viteProcess.kill("SIGTERM");
    } catch {}
    throw viteErr;
  }
  // Keep draining Vite's output. waitForViteReady removed its own listeners, so
  // if we stop reading, the OS pipe buffer (64KB) fills and the Vite child
  // BLOCKS on its next write — e.g. when it logs a mid-session dep
  // re-optimization — stalling the dev server and breaking the live preview.
  // Forward to our log instead of destroying the pipes (destroying makes the
  // child's next write hit a broken pipe → EPIPE → Vite errors out).
  forwardViteOutput(viteProcess, logLabel);
  const previewUrl = `http://127.0.0.1:${actualPort}`;
  if (basePath) {
    await warmUpVite(previewUrl, basePath, logLabel);
  }
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

function isChildProcessAlive(proc: ChildProcess): boolean {
  if (proc.killed) return false;
  return proc.exitCode === null;
}

/** Parse Vite's "Local:" banner from dev-server stdout/stderr. */
export function parseViteReadyPort(output: string): number | null {
  const portMatch = output.match(
    /Local:\s+https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/,
  );
  return portMatch ? Number(portMatch[1]) : null;
}

async function waitForViteReady(
  proc: ChildProcess,
  timeoutMs: number,
  expectedPort: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";

    const cleanup = () => {
      proc.stdout?.off("data", onData);
      proc.stderr?.off("data", onData);
      clearTimeout(timer);
      clearInterval(pollTimer);
    };

    const finish = (port: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(port);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const timer = setTimeout(() => {
      fail(
        new Error(
          `Vite dev server failed to start within ${timeoutMs}ms. Last output:\n${output.slice(-4000)}`,
        ),
      );
    }, timeoutMs);

    const pollTimer = setInterval(() => {
      if (!isChildProcessAlive(proc)) return;
      void (async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${expectedPort}/`, {
            signal: AbortSignal.timeout(2000),
          });
          if (res.status < 500) {
            finish(expectedPort);
          }
        } catch {
          /* Vite still booting — keep polling */
        }
      })();
    }, 500);

    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const port = parseViteReadyPort(output);
      if (port !== null) {
        finish(port);
      }
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    proc.on("exit", (code) => {
      fail(new Error(`Vite exited with code ${code}. Output:\n${output.slice(-4000)}`));
    });

    proc.on("error", (err) => {
      fail(err);
    });
  });
}

async function purgeHarnessInstall(harnessPath: string): Promise<void> {
  await Promise.all([
    rm(path.join(harnessPath, "node_modules"), { recursive: true, force: true }),
    rm(path.join(harnessPath, ".fig2code-package-hash"), { force: true }),
    rm(path.join(harnessPath, "node_modules", ".vite"), {
      recursive: true,
      force: true,
    }),
  ]);
}

async function harnessNeedsFreshInstall(harnessPath: string): Promise<boolean> {
  const pkgPath = path.join(harnessPath, "package.json");
  try {
    const pkg = JSON.parse(await readFs(pkgPath, "utf-8")) as {
      fig2codeHarnessVersion?: number;
      dependencies?: Record<string, string>;
    };
    if ((pkg.fig2codeHarnessVersion ?? 0) < HARNESS_SCHEMA_VERSION) {
      return true;
    }
    if (
      Object.keys(pkg.dependencies ?? {}).some((name) =>
        isStorybookToolingPackage(name),
      )
    ) {
      return true;
    }
  } catch {
    return true;
  }

  try {
    await access(
      path.join(harnessPath, "node_modules", "@storybook", "addon-essentials"),
    );
    return true;
  } catch {
    return false;
  }
}

async function installHarnessDeps(harnessPath: string): Promise<void> {
  const pkgPath = path.join(harnessPath, "package.json");
  let pkgContent = "";
  try {
    pkgContent = await readFs(pkgPath, "utf-8");
  } catch {
    throw new Error(`preview harness package.json missing at ${pkgPath}`);
  }

  let pkg = JSON.parse(pkgContent) as {
    fig2codeHarnessVersion?: number;
    dependencies?: Record<string, string>;
  };
  const sanitizedDeps = sanitizeStorybookHarnessDependencies({
    vite: "^6.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    ...(pkg.dependencies ?? {}),
  });
  const normalizedPkg = {
    ...pkg,
    fig2codeHarnessVersion: HARNESS_SCHEMA_VERSION,
    dependencies: sanitizedDeps,
  };
  const normalizedContent = `${JSON.stringify(normalizedPkg, null, 2)}\n`;
  if (normalizedContent !== `${pkgContent.trimEnd()}\n`) {
    await writeFile(pkgPath, normalizedContent, "utf-8");
    pkgContent = normalizedContent;
    console.log(`[fig2code] sanitized preview harness package.json`);
  }

  const pkgHash = createHash("sha256").update(pkgContent).digest("hex");
  const hashPath = path.join(harnessPath, ".fig2code-package-hash");
  let previousHash = "";
  try {
    previousHash = (await readFs(hashPath, "utf-8")).trim();
  } catch {
    // first install
  }

  const needsFreshInstall = await harnessNeedsFreshInstall(harnessPath);
  if (needsFreshInstall) {
    console.log(
      `[fig2code] stale preview harness detected — purging node_modules for clean install`,
    );
    await purgeHarnessInstall(harnessPath);
    previousHash = "";
  }

  if (
    (await harnessDepsInstalled(harnessPath)) &&
    previousHash === pkgHash
  ) {
    console.log(`[fig2code] harness deps already installed — skipping npm install`);
    return;
  }

  if (previousHash && previousHash !== pkgHash) {
    console.log(`[fig2code] harness package.json changed — reinstalling deps`);
    await purgeHarnessInstall(harnessPath);
  }

  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  await new Promise<void>((resolve, reject) => {
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

  await writeFile(hashPath, pkgHash, "utf-8");
}

/** Stable hash of the harness dependency set (order-independent). */
function stableHarnessDepsKey(deps: Record<string, string>): string {
  const sorted = Object.keys(deps)
    .sort()
    .map((name) => `${name}@${deps[name]}`)
    .join(",");
  return createHash("sha256").update(sorted).digest("hex");
}

interface PreparedCodegenHarness {
  buildPreview: JobBuildPreview;
  generatedFiles: string[];
  componentRepoPath: string;
  componentName: string;
  useDefault: boolean;
  harnessConfigKey: string;
  harnessDepsKey: string;
  themeSelection?: ThemeSelection;
}

/**
 * Write the generated component/story/patch files into the clone and the Vite
 * harness files. In `"full"` mode all harness files are written (used on cold
 * start). In `"swap"` mode only the app-level files (component sources +
 * main.tsx + index.html) are rewritten — package.json/vite.config/tsconfig are
 * left untouched so a running Vite server can be reused. `basePath` keeps the
 * Vite base stable across reuse so asset URLs continue to resolve.
 */
async function prepareCodegenHarness(
  repoClonePath: string,
  harnessPath: string,
  basePath: string,
  buildPreview: JobBuildPreview,
  config: PreviewSessionConfig,
  mode: "full" | "swap",
): Promise<PreparedCodegenHarness> {
  buildPreview = await formatJobBuildPreview(buildPreview, {
    formatter: config.formatter ?? "auto",
    repoRoot: repoClonePath,
    existingFiles: buildPreview.files?.map((file) => ({
      path: file.path,
      content: file.content,
    })),
  });

  await mkdir(harnessPath, { recursive: true });

  const componentContent = buildPreview.componentContent ?? "";
  const storyContent = buildPreview.storyContent ?? "";
  const componentName = buildPreview.componentName;
  const exportName = extractComponentName(componentContent, componentName);
  const useDefault = isDefaultExport(componentContent, exportName);
  const componentRepoPath =
    buildPreview.componentPath || `src/components/${componentName}.tsx`;

  const generatedFiles: string[] = [];

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

  if (buildPreview.files) {
    for (const file of buildPreview.files) {
      if (file.action === "delete" || !file.content) continue;
      if (file.path === componentRepoPath) continue;
      if (file.path === buildPreview.storyPath) continue;
      const fullPath = path.join(repoClonePath, file.path);
      await mkdir(path.dirname(fullPath), { recursive: true });
      let contentToWrite = sanitizeJsxStyleProps(file.content);
      if (isAppendExportPatch(file.content)) {
        let existing = "";
        try {
          existing = await readFs(fullPath, "utf-8");
        } catch {
          existing = "";
        }
        const merged = mergeAppendExportIntoContent(existing, file.content);
        if (!merged) {
          continue;
        }
        contentToWrite = sanitizeJsxStyleProps(merged);
      }
      await writeFile(fullPath, contentToWrite, "utf-8");
      generatedFiles.push(file.path);
    }
  }

  const previewHarness = await resolvePreviewHarnessContext(
    repoClonePath,
    componentRepoPath,
    buildPreview,
  );
  const sbOptions = await resolveStorybookHarnessOptions(
    repoClonePath,
    harnessPath,
    buildPreview,
    previewHarness,
  );
  const previewTheme = await resolvePreviewTheme(repoClonePath, componentRepoPath, {
    tokenPaths: config.tokenPaths,
    themeCatalog: config.themeCatalog,
    selection: config.themeSelection,
  });

  // On reuse, bust the entry module so the iframe reload pulls fresh transforms.
  const mainModuleSrc = mode === "swap" ? `/main.tsx?v=${Date.now()}` : "/main.tsx";

  const appFiles: Array<[string, string]> = [
    [
      path.join(harnessPath, "index.html"),
      generateIndexHtml(buildPreview, componentName, config, previewTheme, mainModuleSrc),
    ],
    [
      path.join(harnessPath, "main.tsx"),
      generateMainTsx(buildPreview, componentName, useDefault, componentRepoPath, sbOptions),
    ],
  ];

  const infraFiles: Array<[string, string]> =
    mode === "full"
      ? [
          [
            path.join(harnessPath, "package.json"),
            generateHarnessPackageJson(previewHarness.harnessDependencies),
          ],
          [
            path.join(harnessPath, "vite.config.ts"),
            generateHarnessViteConfig(
              basePath,
              previewHarness.viteAliases,
              previewHarness.harnessConfig.reactModules,
              previewHarness.dependencyAliases,
              previewHarness.storybook?.optimizeIncludes ?? [],
            ),
          ],
          [
            path.join(harnessPath, "tsconfig.json"),
            generateHarnessTsConfig({
              paths: previewHarness.harnessConfig.tsPaths,
              include: previewHarness.tsInclude,
            }),
          ],
        ]
      : [];

  await Promise.all(
    [...appFiles, ...infraFiles].map(([p, content]) => writeFile(p, content, "utf-8")),
  );

  return {
    buildPreview,
    generatedFiles,
    componentRepoPath,
    componentName,
    useDefault,
    harnessConfigKey: stableHarnessConfigKey(previewHarness.harnessConfig),
    harnessDepsKey: stableHarnessDepsKey(previewHarness.harnessDependencies),
    themeSelection: previewTheme?.selection,
  };
}

// ---------------------------------------------------------------------------
// Session manager
// ---------------------------------------------------------------------------

export function createPreviewSessionManager(
  repoCache: RepoCloneCache,
): SessionManager {
  const sessions = new Map<string, PreviewSession>();
  // Codegen jobs get a fresh jobId each push but share one Vite server per repo.
  // Maps a per-push jobId → the stable session key the server is stored under.
  const jobAliases = new Map<string, string>();
  const sessionStartup = new Map<string, Promise<PreviewSession>>();
  const swapLocks = new Map<string, Promise<PreviewSession>>();
  const recoveryLocks = new Map<string, Promise<boolean>>();

  /** Resolve a session by per-push jobId or by its stable map key. */
  function resolveSession(idOrKey: string): PreviewSession | undefined {
    return sessions.get(jobAliases.get(idOrKey) ?? idOrKey);
  }
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

  /**
   * Swap a new codegen result into an already-running Vite server for the same
   * repo, avoiding a fresh install + Vite cold start + warmup on every push.
   * Throws to signal the caller should fall back to a full cold start when the
   * harness deps/config changed or Vite is unhealthy.
   */
  async function swapCodegenComponent(
    sessionKey: string,
    session: PreviewSession,
    jobId: string,
    buildPreview: JobBuildPreview,
    config: PreviewSessionConfig,
  ): Promise<PreviewSession> {
    const pending = swapLocks.get(sessionKey);
    if (pending) return pending;

    const work = (async () => {
      if (await harnessNeedsFreshInstall(session.harnessPath)) {
        throw new Error("preview harness stale — cold start required");
      }

      const prepared = await prepareCodegenHarness(
        session.repoClonePath,
        session.harnessPath,
        session.basePath ?? `/jobs/${jobId}/preview/`,
        buildPreview,
        config,
        "swap",
      );

      // A changed dependency set or tsconfig/alias shape needs a rebuilt harness
      // and Vite restart — cheaper and safer to cold start than to patch live.
      if (session.harnessDepsKey && session.harnessDepsKey !== prepared.harnessDepsKey) {
        throw new Error("preview harness dependencies changed — cold start required");
      }
      if (session.harnessConfigKey && session.harnessConfigKey !== prepared.harnessConfigKey) {
        throw new Error("preview harness config changed — cold start required");
      }

      session.ready = false;
      // App files are written; HMR is off, so the iframe fully reloads and Vite
      // re-transforms the changed modules on the next request. The short pause
      // only needs to cover Vite's file-watcher invalidating its module cache —
      // a local fs event, well under 100ms.
      await new Promise((resolve) => setTimeout(resolve, 100));

      session.componentPath = prepared.componentRepoPath;
      session.componentName = prepared.componentName;
      session.themeSelection = prepared.themeSelection;
      session.generatedFiles = Array.from(
        new Set([...session.generatedFiles, ...prepared.generatedFiles]),
      );
      session.harnessContext = {
        buildPreview: prepared.buildPreview,
        componentName: prepared.componentName,
        componentRepoPath: prepared.componentRepoPath,
        useDefault: prepared.useDefault,
        config,
      };
      session.lastAccessedAt = Date.now();

      if (isViteProcessAlive(session) && (await waitForViteResponding(session))) {
        session.ready = true;
        console.log(
          `[fig2code] reused preview vite → ${prepared.componentName} (job ${jobId})`,
        );
        return session;
      }
      throw new Error("vite unhealthy after swap — cold start required");
    })();

    swapLocks.set(sessionKey, work);
    try {
      return await work;
    } finally {
      swapLocks.delete(sessionKey);
    }
  }

  async function startSession(
    jobId: string,
    buildPreview: JobBuildPreview,
    config: PreviewSessionConfig,
  ): Promise<PreviewSession> {
    // One Vite server per repo, reused across pushes. Keyed by a stable repo id
    // (distinct from the existing-component preview key) rather than the jobId.
    const sessionKey = `${repoPreviewSessionId(config.vcs)}-cg`;

    const existing = sessions.get(sessionKey);
    if (existing) {
      if (existing.ready && isViteProcessAlive(existing)) {
        try {
          const swapped = await swapCodegenComponent(
            sessionKey,
            existing,
            jobId,
            buildPreview,
            config,
          );
          jobAliases.set(jobId, sessionKey);
          return swapped;
        } catch (err) {
          console.warn(
            `[fig2code] codegen preview reuse failed, cold starting:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      await stopSession(sessionKey);
    }

    await evictOldest();

    // 1. Get or create cached repo clone with deps installed
    const repoClonePath = await repoCache.getOrClone(
      config.vcs,
      config.gitToken,
      config.atlassianEmail,
    );

    // 2-4. Write generated files + the full preview harness
    const harnessPath = path.join(repoClonePath, PREVIEW_DIR);
    const basePath = `/jobs/${jobId}/preview/`;
    const prepared = await prepareCodegenHarness(
      repoClonePath,
      harnessPath,
      basePath,
      buildPreview,
      config,
      "full",
    );

    // 5. Install harness deps (just vite + react plugin, fast)
    console.log(`[fig2code] installing preview harness deps in ${harnessPath}`);
    await installHarnessDeps(harnessPath);

    // 6. Start Vite dev server from the harness directory
    const started = await startViteForHarness(harnessPath, `job ${jobId}`, basePath);

    const session: PreviewSession = {
      jobId,
      repoClonePath,
      harnessPath,
      basePath,
      vitePort: started.vitePort,
      viteProcess: started.viteProcess,
      previewUrl: started.previewUrl,
      startedAt: Date.now(),
      lastAccessedAt: Date.now(),
      ready: true,
      generatedFiles: prepared.generatedFiles,
      componentPath: prepared.componentRepoPath,
      componentName: prepared.componentName,
      harnessConfigKey: prepared.harnessConfigKey,
      harnessDepsKey: prepared.harnessDepsKey,
      themeSelection: prepared.themeSelection,
      harnessContext: {
        buildPreview: prepared.buildPreview,
        componentName: prepared.componentName,
        componentRepoPath: prepared.componentRepoPath,
        useDefault: prepared.useDefault,
        config,
      },
    };
    attachViteExitHandler(session);

    sessions.set(sessionKey, session);
    jobAliases.set(jobId, sessionKey);
    startIdleCheck();
    return session;
  }

  async function stopSession(jobIdOrKey: string): Promise<void> {
    const key = jobAliases.get(jobIdOrKey) ?? jobIdOrKey;
    const session = sessions.get(key);
    if (!session) return;

    sessions.delete(key);
    for (const [alias, aliasKey] of jobAliases) {
      if (aliasKey === key) jobAliases.delete(alias);
    }

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

    console.log(`[fig2code] preview session stopped: ${key}`);
  }

  function getSession(jobId: string): PreviewSession | undefined {
    const session = resolveSession(jobId);
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
    const session = resolveSession(jobId);
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
    const previewHarness = await resolvePreviewHarnessContext(
      repoClonePath,
      ctx.componentRepoPath,
      ctx.buildPreview,
    );
    const sbOptions = await resolveStorybookHarnessOptions(
      repoClonePath,
      harnessPath,
      ctx.buildPreview,
      previewHarness,
    );
    const previewTheme = await resolvePreviewTheme(
      repoClonePath,
      ctx.componentRepoPath,
      {
        tokenPaths: options.tokenPaths,
        themeCatalog: options.themeCatalog,
        selection: options.themeSelection,
      },
    );
    const mainModuleSrc =
      mode === "swap" ? `/main.tsx?v=${Date.now()}` : "/main.tsx";

    if (mode === "swap") {
      await Promise.all([
        writeFile(
          path.join(harnessPath, "main.tsx"),
          generateMainTsx(
            ctx.buildPreview,
            ctx.componentName,
            ctx.useDefault,
            ctx.componentRepoPath,
            sbOptions,
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
      [
        path.join(harnessPath, "package.json"),
        generateHarnessPackageJson(previewHarness.harnessDependencies),
      ],
      [
        path.join(harnessPath, "vite.config.ts"),
        generateHarnessViteConfig(
          `/preview/existing/${sessionId}/`,
          previewHarness.viteAliases,
          previewHarness.harnessConfig.reactModules,
          previewHarness.dependencyAliases,
          previewHarness.storybook?.optimizeIncludes ?? [],
        ),
      ],
      [
        path.join(harnessPath, "tsconfig.json"),
        generateHarnessTsConfig({
          paths: previewHarness.harnessConfig.tsPaths,
          include: previewHarness.tsInclude,
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
          sbOptions,
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
      `/preview/existing/${sessionId}/`,
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
      themeSelection: (
        await resolvePreviewTheme(repoClonePath, ctx.componentRepoPath, {
          tokenPaths: options.tokenPaths,
          themeCatalog: options.themeCatalog,
          selection: options.themeSelection,
        })
      )?.selection,
      harnessContext: {
        buildPreview: ctx.buildPreview,
        componentName: ctx.componentName,
        componentRepoPath: ctx.componentRepoPath,
        useDefault: ctx.useDefault,
        config: {
          vcs: options.vcs,
          gitToken: options.gitToken,
          atlassianEmail: options.atlassianEmail,
          tokenCatalog: options.tokenCatalog,
          tokenPaths: options.tokenPaths,
          themeCatalog: options.themeCatalog,
          themeSelection: options.themeSelection,
        },
      },
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

      const harnessStale = await harnessNeedsFreshInstall(session.harnessPath);
      const sameComponent =
        session.componentPath === ctx.componentRepoPath &&
        session.componentName === ctx.componentName;

      if (sameComponent && !harnessStale) {
        session.lastAccessedAt = Date.now();
        return session;
      }

      if (sameComponent && harnessStale) {
        console.log(
          `[fig2code] stale preview harness detected — upgrading before render`,
        );
      } else {
        console.log(
          `[fig2code] swapping preview component → ${ctx.componentName} (${ctx.componentRepoPath})`,
        );
      }

      const harnessConfig = await resolveHarnessTsConfig(
        session.repoClonePath,
        ctx.componentRepoPath,
      );
      const configKey = stableHarnessConfigKey(harnessConfig);
      const configChanged =
        harnessStale || session.harnessConfigKey !== configKey;

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
      const previewTheme = await resolvePreviewTheme(
        session.repoClonePath,
        ctx.componentRepoPath,
        {
          tokenPaths: options.tokenPaths,
          themeCatalog: options.themeCatalog,
          selection: options.themeSelection,
        },
      );
      session.themeSelection = previewTheme?.selection;
      session.harnessContext = {
        buildPreview: ctx.buildPreview,
        componentName: ctx.componentName,
        componentRepoPath: ctx.componentRepoPath,
        useDefault: ctx.useDefault,
        config: {
          vcs: options.vcs,
          gitToken: options.gitToken,
          atlassianEmail: options.atlassianEmail,
          tokenCatalog: options.tokenCatalog,
          tokenPaths: options.tokenPaths,
          themeCatalog: options.themeCatalog,
          themeSelection: options.themeSelection,
        },
      };

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

  async function updatePreviewTheme(
    jobId: string,
    selection: Partial<ThemeSelection>,
  ): Promise<ThemeSelection | null> {
    const session = resolveSession(jobId);
    if (!session?.harnessContext) {
      throw new Error(`No active preview session for job ${jobId}`);
    }

    session.lastAccessedAt = Date.now();
    const ctx = session.harnessContext;
    const previewTheme = await resolvePreviewTheme(
      session.repoClonePath,
      ctx.componentRepoPath,
      {
        tokenPaths: ctx.config.tokenPaths,
        themeCatalog: ctx.config.themeCatalog,
        selection,
      },
    );
    if (!previewTheme) {
      return null;
    }

    await writeFile(
      path.join(session.harnessPath, "index.html"),
      generateIndexHtml(
        ctx.buildPreview,
        ctx.componentName,
        ctx.config,
        previewTheme,
        `/main.tsx?v=${Date.now()}`,
      ),
      "utf-8",
    );

    session.themeSelection = previewTheme.selection;
    return previewTheme.selection;
  }

  return {
    startSession,
    startExistingSession,
    openExistingPreview,
    recoverVite: recoverViteSession,
    stopSession,
    getSession,
    writeFile: writeFileToWorkspace,
    updatePreviewTheme,
    stopAll,
  };
}

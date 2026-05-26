import {
  extractExportedBindings,
  isPreviewModuleSource,
  moduleDefinesBinding,
  prepareDependencyModule,
  resolvePreviewImports,
  type PreviewDependencyBundle,
} from "@fig2code/codegen";
import type { JobBuildPreview } from "@fig2code/spec";
import { createGitHostProvider, defaultBranch } from "@fig2code/git-host";
import type { StoredJob } from "./job-store.js";

export interface PreviewDependencyLoaderContext {
  iconPath: string;
  readFile: (path: string) => Promise<string | null>;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export async function loadPreviewDependenciesFromRepo(
  buildPreview: JobBuildPreview,
  context: PreviewDependencyLoaderContext,
): Promise<PreviewDependencyBundle> {
  const sources: string[] = [];
  const resolvedBindings = new Set<string>();
  const fileCache = new Map<string, string>();
  const fetchedPaths = new Set<string>();
  const visited = new Set<string>();
  const log = context.log ?? (() => {});

  const dependencyContext = {
    componentPath: buildPreview.componentPath,
    iconPath: context.iconPath,
  };

  async function resolveFromSource(source: string, filePath?: string): Promise<void> {
    const visitKey = filePath ?? "__root__";
    if (visited.has(visitKey)) {
      return;
    }
    visited.add(visitKey);

    const resolutions = resolvePreviewImports(source, {
      ...dependencyContext,
      componentPath: filePath ?? dependencyContext.componentPath,
    });

    log("preview import resolutions", {
      filePath: filePath ?? buildPreview.componentPath,
      resolutions: resolutions.map((resolution) => ({
        bindings: resolution.bindings,
        candidates: resolution.candidatePaths.slice(0, 8),
      })),
    });

    for (const resolution of resolutions) {
      let content: string | null = null;
      let hitPath: string | null = null;
      const attempts: Array<{ path: string; result: "hit" | "miss" | "invalid" }> = [];

      for (const candidate of resolution.candidatePaths) {
        if (fileCache.has(candidate)) {
          const cached = fileCache.get(candidate)!;
          if (isPreviewModuleSource(cached)) {
            content = cached;
            hitPath = candidate;
            attempts.push({ path: candidate, result: "hit" });
            break;
          }
          attempts.push({ path: candidate, result: "invalid" });
          continue;
        }

        const read = await context.readFile(candidate);
        if (read && isPreviewModuleSource(read)) {
          fileCache.set(candidate, read);
          content = read;
          hitPath = candidate;
          attempts.push({ path: candidate, result: "hit" });
          break;
        }

        attempts.push({ path: candidate, result: read ? "invalid" : "miss" });
      }

      log("preview icon fetch attempts", {
        bindings: resolution.bindings,
        attempts: attempts.slice(0, 12),
        hitPath,
      });

      if (!content || !hitPath || fetchedPaths.has(hitPath)) {
        continue;
      }

      const prepared = prepareDependencyModule(content);
      const resolvedForModule = resolution.bindings.filter(
        (binding) =>
          moduleDefinesBinding(prepared, binding) || extractExportedBindings(content).includes(binding),
      );

      if (resolvedForModule.length === 0) {
        log("preview icon module did not define requested bindings", {
          hitPath,
          requested: resolution.bindings,
          exports: extractExportedBindings(content),
        });
        continue;
      }

      fetchedPaths.add(hitPath);
      sources.push(prepared);
      for (const binding of resolvedForModule) {
        resolvedBindings.add(binding);
      }

      await resolveFromSource(content, hitPath);
    }
  }

  await resolveFromSource(buildPreview.componentContent ?? "");

  log("preview dependencies resolved", {
    iconPath: context.iconPath,
    fetchedPaths: [...fetchedPaths],
    resolvedBindings: [...resolvedBindings],
  });

  return {
    sources,
    resolvedBindings: [...resolvedBindings],
  };
}

export async function loadPreviewDependencies(
  stored: StoredJob,
  buildPreview: JobBuildPreview,
): Promise<PreviewDependencyBundle> {
  const git = createGitHostProvider(stored.request.vcs.provider);
  const iconPath = stored.request.syncConfig.web?.iconPath ?? "src/icons";

  console.log("[fig2code] preview dependency load", {
    jobId: stored.id,
    provider: stored.request.vcs.provider,
    component: buildPreview.componentName,
    componentPath: buildPreview.componentPath,
    iconPath,
    imports: buildPreview.componentContent?.match(/^import .+$/gm)?.slice(0, 10),
  });

  return loadPreviewDependenciesFromRepo(buildPreview, {
    iconPath,
    log: (message, data) => {
      console.log(`[fig2code] ${message}`, data ?? {});
    },
    readFile: (path) =>
      git.readFile(
        stored.request.vcs,
        {
          token: stored.secrets.gitToken,
          atlassianEmail: stored.secrets.atlassianEmail,
        },
        path,
        defaultBranch(stored.request.vcs),
      ),
  });
}

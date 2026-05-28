import { access, readFile } from "node:fs/promises";
import path from "node:path";

export interface HarnessResolveConfig {
  /** Vite alias prefix -> path relative to repo root (posix). */
  viteAliases: Record<string, string>;
  /** tsconfig paths relative to the harness directory. */
  tsPaths: Record<string, string[]>;
  /** tsconfig include globs relative to the harness directory. */
  include: string[];
  /** Repo-relative paths to react / react-dom when found near the component. */
  reactModules?: { react: string; reactDom: string };
}

function stripJsonComments(raw: string): string {
  // Only strip line comments — block-comment regex breaks globs like "src/**/*".
  return raw.replace(/^\s*\/\/.*$/gm, "");
}

function toPosixRelative(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

function aliasPrefix(pattern: string): string {
  return pattern.replace(/\/\*$/, "").replace(/\*$/, "");
}

function targetPrefix(target: string): string {
  return target.replace(/\/\*$/, "").replace(/\*$/, "");
}

function harnessPathPattern(pattern: string): string {
  if (pattern.endsWith("/*")) {
    return pattern;
  }
  if (pattern.endsWith("*")) {
    return pattern;
  }
  return pattern;
}

function harnessTargetPath(
  aliasAbs: string,
  target: string,
  harnessPath: string,
): string {
  const rel = toPosixRelative(harnessPath, aliasAbs);
  const suffix = target.includes("*") ? "/*" : "";
  return `${rel}${suffix}`;
}

/**
 * Resolve TypeScript path aliases from the nearest tsconfig.json to the
 * component file so Vite can resolve `@/` and other monorepo imports.
 */
export async function resolveHarnessTsConfig(
  repoClonePath: string,
  componentRepoPath: string,
  harnessRelPath = ".fig2code-preview",
): Promise<HarnessResolveConfig> {
  const harnessPath = path.join(repoClonePath, harnessRelPath);
  const componentAbs = path.join(repoClonePath, componentRepoPath);
  let dir = path.dirname(componentAbs);
  const repoRoot = repoClonePath;

  while (dir.startsWith(repoRoot)) {
    const tsconfigPath = path.join(dir, "tsconfig.json");
    try {
      const raw = await readFile(tsconfigPath, "utf-8");
      const parsed = JSON.parse(stripJsonComments(raw)) as {
        compilerOptions?: {
          baseUrl?: string;
          paths?: Record<string, string[]>;
        };
      };
      const paths = parsed.compilerOptions?.paths;
      if (paths && Object.keys(paths).length > 0) {
        const baseUrl = parsed.compilerOptions?.baseUrl ?? ".";
        const baseAbs = path.resolve(dir, baseUrl);
        const viteAliases: Record<string, string> = {};
        const tsPaths: Record<string, string[]> = {};
        const include = new Set<string>(["./**/*"]);

        for (const [pattern, targets] of Object.entries(paths)) {
          const target = targets[0];
          if (!target) continue;

          const prefix = aliasPrefix(pattern);
          const aliasAbs = path.resolve(baseAbs, targetPrefix(target));
          viteAliases[prefix] = toPosixRelative(repoRoot, aliasAbs);
          tsPaths[harnessPathPattern(pattern)] = [
            harnessTargetPath(aliasAbs, target, harnessPath),
          ];
        }

        const packageRoot = await findNearestPackageRoot(dir, repoRoot);
        if (packageRoot) {
          include.add(`../${toPosixRelative(repoRoot, packageRoot)}/**/*`);
        } else {
          include.add(`../${toPosixRelative(repoRoot, dir)}/**/*`);
        }

        const reactModules = await resolveReactModulePaths(
          repoClonePath,
          componentRepoPath,
        );

        return {
          viteAliases,
          tsPaths,
          include: [...include],
          reactModules,
        };
      }
    } catch {
      // try parent directory
    }

    if (dir === repoRoot) break;
    dir = path.dirname(dir);
  }

  const reactModules = await resolveReactModulePaths(
    repoClonePath,
    componentRepoPath,
  );

  return {
    viteAliases: { "@": "src" },
    tsPaths: { "@/*": ["../src/*"] },
    include: ["./**/*", "../src/**/*"],
    reactModules,
  };
}

async function resolveReactModulePaths(
  repoClonePath: string,
  componentRepoPath: string,
): Promise<{ react: string; reactDom: string } | undefined> {
  let dir = path.dirname(path.join(repoClonePath, componentRepoPath));
  const repoRoot = repoClonePath;

  while (dir.startsWith(repoRoot)) {
    const reactPkg = path.join(dir, "node_modules", "react", "package.json");
    try {
      await access(reactPkg);
      return {
        react: toPosixRelative(repoRoot, path.join(dir, "node_modules", "react")),
        reactDom: toPosixRelative(
          repoRoot,
          path.join(dir, "node_modules", "react-dom"),
        ),
      };
    } catch {
      // walk up
    }
    if (dir === repoRoot) break;
    dir = path.dirname(dir);
  }

  return undefined;
}

async function findNearestPackageRoot(
  dir: string,
  repoRoot: string,
): Promise<string | null> {
  let current = dir;
  while (current.startsWith(repoRoot)) {
    const pkgPath = path.join(current, "package.json");
    try {
      await access(pkgPath);
      return current;
    } catch {
      // try parent
    }
    if (current === repoRoot) break;
    current = path.dirname(current);
  }
  return null;
}

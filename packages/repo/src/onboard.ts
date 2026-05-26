import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DetectedProjectConfig, SyncConfig } from "@fig2code/spec";
import { createGitHostProvider } from "@fig2code/git-host";
import type { VcsConfig } from "@fig2code/spec";
import {
  detectProjectConfig,
  detectedConfigToSyncConfig,
} from "./detect.js";
import { buildTypographyConfig } from "./typography.js";
import { buildTokenConfig } from "./tokens.js";

export interface OnboardLocalOptions {
  rootDir: string;
  vcs: VcsConfig;
  writeConfig?: boolean;
}

export interface OnboardRemoteOptions {
  vcs: VcsConfig;
  token: string;
  atlassianEmail?: string;
  targetDir: string;
  writeConfig?: boolean;
}

export interface OnboardResult {
  detected: DetectedProjectConfig;
  syncConfig: SyncConfig;
  configPath?: string;
  refs?: Array<{ name: string; sha?: string }>;
}

export async function onboardLocalRepo(options: OnboardLocalOptions): Promise<OnboardResult> {
  const detected = await detectProjectConfig({ rootDir: options.rootDir });
  const syncConfig = detectedConfigToSyncConfig(detected, options.vcs);
  syncConfig.typography = await buildTypographyConfig({
    rootDir: options.rootDir,
    fontPaths: detected.fontPaths,
    tokenPaths: detected.tokenPaths,
    tailwindConfigPath: detected.tailwindConfigPath,
    styleSystem: detected.styleSystem,
  });
  syncConfig.tokens = await buildTokenConfig({
    rootDir: options.rootDir,
    tokenPaths:
      detected.tokenPaths.length > 0
        ? detected.tokenPaths
        : detected.tailwindConfigPath
          ? [detected.tailwindConfigPath]
          : ["src/tokens"],
    fontPaths: detected.fontPaths,
    tailwindConfigPath: detected.tailwindConfigPath,
    styleSystem: detected.styleSystem,
    typographyCatalog: syncConfig.typography.catalog,
  });

  let configPath: string | undefined;
  if (options.writeConfig !== false) {
    configPath = await writeSyncConfig(options.rootDir, syncConfig);
  }

  return { detected, syncConfig, configPath };
}

export async function onboardRemoteRepo(options: OnboardRemoteOptions): Promise<OnboardResult> {
  const git = createGitHostProvider(options.vcs.provider);
  const auth = {
    token: options.token,
    atlassianEmail: options.atlassianEmail,
  };

  const refs = await git.listRefs(options.vcs, auth);
  await git.cloneRepo({
    vcs: options.vcs,
    token: options.token,
    targetDir: options.targetDir,
    branch: options.vcs.baseBranch,
  });

  const result = await onboardLocalRepo({
    rootDir: options.targetDir,
    vcs: options.vcs,
    writeConfig: options.writeConfig,
  });

  return { ...result, refs };
}

export async function detectRemotePackageJson(
  vcs: VcsConfig,
  token: string,
  ref?: string,
): Promise<string | null> {
  const git = createGitHostProvider(vcs.provider);
  return git.readFile(vcs, token, "package.json", ref);
}

export async function writeSyncConfig(rootDir: string, syncConfig: SyncConfig): Promise<string> {
  const figmaDir = join(rootDir, ".figma");
  await mkdir(figmaDir, { recursive: true });

  const configPath = join(figmaDir, "sync-config.json");
  await writeFile(configPath, `${JSON.stringify(syncConfig, null, 2)}\n`, "utf8");
  return configPath;
}

export function fixturePath(name: "tailwind-app" | "styled-app"): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../fixtures", name);
}

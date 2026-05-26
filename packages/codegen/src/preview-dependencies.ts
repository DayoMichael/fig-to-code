export interface ParsedImport {
  bindings: string[];
  fromPath: string;
}

export interface PreviewDependencyContext {
  componentPath?: string;
  iconPath: string;
}

export interface PreviewImportResolution {
  bindings: string[];
  candidatePaths: string[];
}

function joinPosix(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "");
}

function dirnamePosix(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const normalized = path.replace(/^\.\//, "");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function iconModuleFileCandidates(basePath: string): string[] {
  return dedupePaths([
    `${basePath}.tsx`,
    `${basePath}.ts`,
    `${basePath}.jsx`,
    `${basePath}.js`,
  ]);
}

export function moduleDefinesBinding(source: string, binding: string): boolean {
  return new RegExp(`\\b(?:const|function|var|let)\\s+${binding}\\b`).test(source)
    || new RegExp(`\\b${binding}\\s*=`).test(source);
}

function iconBindingToKebabBase(binding: string): string {
  return binding
    .replace(/Icon$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

export function isPreviewModuleSource(content: string): boolean {
  const trimmed = content.trimStart();
  if (!trimmed) {
    return false;
  }

  if (trimmed.startsWith("{") && trimmed.includes('"values"') && trimmed.includes('"pagelen"')) {
    return false;
  }

  return true;
}

function normalizeAliasPath(fromPath: string): string {
  if (fromPath.startsWith("@/")) {
    return fromPath.replace(/^@\//, "src/");
  }
  return fromPath;
}

function collectImportBindingsFromStatement(statement: string, bindings: string[]): void {
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

export function extractImports(source: string): ParsedImport[] {
  const imports: ParsedImport[] = [];
  let index = 0;

  while (index < source.length) {
    const rest = source.slice(index);
    const importMatch = rest.match(/^import\s+(?:type\s+)?[\s\S]*?from\s+["']([^"']+)["'];?\s*/);
    if (importMatch) {
      const bindings: string[] = [];
      collectImportBindingsFromStatement(importMatch[0], bindings);
      if (bindings.length > 0 && !/^import\s+type\b/.test(importMatch[0])) {
        imports.push({ bindings, fromPath: importMatch[1] });
      }
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

  return imports;
}

export function shouldResolvePreviewImport(imp: ParsedImport): boolean {
  if (imp.bindings.some((binding) => /Icon$/.test(binding))) {
    return true;
  }
  return /icon/i.test(imp.fromPath);
}

export function resolveImportCandidates(
  imp: ParsedImport,
  context: PreviewDependencyContext,
): string[] {
  const prioritized: string[] = [];
  const secondary: string[] = [];
  const componentDir = dirnamePosix(context.componentPath ?? joinPosix("src", "components"));
  const normalizedFrom = normalizeAliasPath(imp.fromPath);
  const iconPath = context.iconPath.replace(/\/$/, "");
  const afterIcons = normalizedFrom.match(/\/icons\/(.+)$/)?.[1];

  if (imp.fromPath.startsWith(".")) {
    secondary.push(...iconModuleFileCandidates(joinPosix(componentDir, imp.fromPath)));
  }

  for (const binding of imp.bindings) {
    const kebabBase = iconBindingToKebabBase(binding);

    if (/Icon$/.test(binding)) {
      prioritized.push(
        ...iconModuleFileCandidates(joinPosix(iconPath, kebabBase)),
        ...iconModuleFileCandidates(joinPosix(iconPath, binding)),
      );

      if (afterIcons && !iconPath.endsWith(afterIcons)) {
        prioritized.push(...iconModuleFileCandidates(joinPosix(iconPath, afterIcons, kebabBase)));
      }
    }

    secondary.push(
      ...iconModuleFileCandidates(joinPosix(normalizedFrom, binding)),
      ...iconModuleFileCandidates(joinPosix(normalizedFrom, kebabBase)),
    );

    if (afterIcons) {
      secondary.push(
        ...iconModuleFileCandidates(joinPosix(iconPath, afterIcons, binding)),
        ...iconModuleFileCandidates(joinPosix(iconPath, afterIcons, kebabBase)),
      );
    }
  }

  if (/^src\/icons/i.test(normalizedFrom) || normalizedFrom === iconPath) {
    for (const binding of imp.bindings) {
      const kebabBase = iconBindingToKebabBase(binding);
      prioritized.push(
        ...iconModuleFileCandidates(joinPosix(iconPath, binding)),
        ...iconModuleFileCandidates(joinPosix(iconPath, kebabBase)),
      );
    }
  }

  return dedupePaths(
    [...prioritized, ...secondary].filter((candidate) => !candidate.endsWith("/")),
  );
}

export function resolvePreviewImports(
  source: string,
  context: PreviewDependencyContext,
): PreviewImportResolution[] {
  return extractImports(source)
    .filter(shouldResolvePreviewImport)
    .map((imp) => ({
      bindings: imp.bindings,
      candidatePaths: resolveImportCandidates(imp, context),
    }));
}

export function extractExportedBindings(source: string): string[] {
  const names = new Set<string>();

  for (const match of source.matchAll(/export\s+(?:default\s+)?(?:function|const)\s+(\w+)/g)) {
    if (match[1]) names.add(match[1]);
  }

  for (const match of source.matchAll(/export\s+\{([\s\S]*?)\}/g)) {
    for (const part of match[1].split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const asMatch = trimmed.match(/(\w+)\s+as\s+(\w+)/);
      if (asMatch) {
        names.add(asMatch[2]);
      } else {
        const name = trimmed.match(/^(\w+)/)?.[1];
        if (name) names.add(name);
      }
    }
  }

  return [...names];
}

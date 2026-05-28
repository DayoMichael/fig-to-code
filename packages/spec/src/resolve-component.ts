export type ResolvedComponentFileRole =
  | "component"
  | "story"
  | "test"
  | "barrel"
  | "code-connect"
  | "related";

export interface ResolvedComponentFile {
  path: string;
  role: ResolvedComponentFileRole;
  content: string;
}

export interface ResolvedComponentMatch {
  source: "registry" | "code-connect" | "detected" | "convention";
  confidence: "high" | "medium" | "low";
  reason: string;
}

export interface ResolvedComponentBundle {
  componentName: string;
  match: ResolvedComponentMatch;
  files: ResolvedComponentFile[];
  primaryComponentPath?: string;
  storyPath?: string;
  testPath?: string;
  barrelPath?: string;
  relatedModules?: ResolvedComponentFile[];
  truncated?: boolean;
}

export interface ResolveComponentRequest {
  componentName: string;
  figmaComponentKey?: string;
  figmaNodeId?: string;
}

export interface ResolveComponentResponse {
  matched: boolean;
  bundleId?: string;
  bundle?: ResolvedComponentBundle;
  reason?: string;
}

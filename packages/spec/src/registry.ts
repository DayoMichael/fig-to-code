export interface ComponentRegistryEntry {
  figmaNodeId: string;
  figmaComponentKey?: string;
  lastSynced: string;
  hash: string;
  codePaths: {
    web?: string;
    native?: string;
  };
}

export interface ScreenRegistryEntry {
  figmaNodeId: string;
  lastSynced: string;
  componentsUsed: string[];
}

export interface Registry {
  lastTokenSync?: string;
  lastIconSync?: string;
  components: Record<string, ComponentRegistryEntry>;
  screens: Record<string, ScreenRegistryEntry>;
}

export interface SkillCatalogEntry {
  id: string;
  name: string;
  summary: string;
  category: string;
  verified: boolean;
  compatibleAgents: string[];
  repoUrl: string;
  sourceSubpath?: string | null;
  packageKind: string;
  docsUrl: string;
}

export interface InstalledSkillStatus {
  skillId: string;
  installedUser: boolean;
  installedWorkspace: boolean;
  installPaths: string[];
}

export interface CustomInstalledSkill {
  id: string;
  name: string;
  source: string;
}

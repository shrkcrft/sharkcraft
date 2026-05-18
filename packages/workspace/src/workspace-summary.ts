import type { IPackageJson } from './package-json-reader.ts';
import type { IPackageManagerInfo } from './package-manager-detector.ts';
import type { IFrameworkInfo } from './framework-detector.ts';
import type { ITsConfig } from './tsconfig-reader.ts';
import type { IProfileDetectionResult, WorkspaceProfile } from './profile-detector.ts';

export interface IWorkspaceSummary {
  projectRoot: string;
  hasPackageJson: boolean;
  packageName?: string;
  packageVersion?: string;
  description?: string;
  packageManager: IPackageManagerInfo;
  frameworks: IFrameworkInfo[];
  hasTypeScript: boolean;
  tsConfig: ITsConfig | null;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  topLevelDirs: string[];
  hasSharkcraftFolder: boolean;
  sharkcraftPath: string | null;
  /** Inferred profile tags (see WorkspaceProfile). */
  profiles: readonly WorkspaceProfile[];
  profileEvidence: IProfileDetectionResult['evidence'];
  raw: { packageJson: IPackageJson | null };
}

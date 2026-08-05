export type IssueSeverity = 'error' | 'warning' | 'info';

export type IssueCode =
  | 'manifest.parse'
  | 'manifest.package-section-missing'
  | 'manifest.org-missing'
  | 'manifest.name-missing'
  | 'manifest.version-missing'
  | 'manifest.version-invalid'
  | 'manifest.dependency-invalid'
  | 'manifest.dependency-duplicate'
  | 'dependency.path-missing'
  | 'dependency.cycle'
  | 'lock.missing'
  | 'lock.empty'
  | 'lock.stale'
  | 'workspace.limit'
  | 'analyzer.failed'
  | 'cli.missing';

export type RecommendationKind =
  | 'refresh'
  | 'open-manifest'
  | 'install'
  | 'install-frozen'
  | 'build'
  | 'env-verify'
  | 'self-update-check'
  | 'edit';

export interface Recommendation {
  readonly title: string;
  readonly kind: RecommendationKind;
  readonly command?: readonly string[];
  readonly detail?: string;
}

export interface PackageDependency {
  readonly name: string;
  readonly section: string;
  readonly requirement?: string;
  readonly path?: string;
  readonly git?: string;
  readonly optional?: boolean;
  readonly line: number;
}

export interface PackageIdentity {
  readonly org?: string;
  readonly name?: string;
  readonly version?: string;
  readonly description?: string;
  readonly language?: string;
}

export interface PackageIssue {
  readonly code: IssueCode;
  readonly severity: IssueSeverity;
  readonly message: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly length?: number;
  readonly detail?: string;
  readonly recommendations: readonly Recommendation[];
}

export interface PackageReport {
  readonly root: string;
  readonly manifestPath: string;
  readonly lockPath?: string;
  readonly identity: PackageIdentity;
  readonly dependencies: readonly PackageDependency[];
  readonly issues: readonly PackageIssue[];
}

export interface ReportCounts {
  readonly packages: number;
  readonly dependencies: number;
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
}

export interface WorkspaceReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly workspaceRoots: readonly string[];
  readonly packages: readonly PackageReport[];
  readonly issues: readonly PackageIssue[];
  readonly counts: ReportCounts;
  readonly analyzer: 'rust' | 'typescript';
}

export interface ParsedManifest {
  readonly identity: PackageIdentity;
  readonly dependencies: readonly PackageDependency[];
  readonly issues: readonly PackageIssue[];
  readonly sections: ReadonlySet<string>;
}

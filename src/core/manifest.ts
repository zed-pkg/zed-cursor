import type {
  PackageDependency,
  PackageIssue,
  ParsedManifest,
  Recommendation
} from '../types';

interface ParsedValue {
  readonly raw: string;
  readonly stringValue?: string;
  readonly booleanValue?: boolean;
  readonly inlineTable?: Readonly<Record<string, string | boolean>>;
}

const PACKAGE_KEYS = new Set(['org', 'name', 'version', 'description', 'language']);
const DEPENDENCY_SECTIONS = new Set(['dependencies', 'dev-dependencies', 'build-dependencies']);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseManifest(text: string, manifestPath: string): ParsedManifest {
  const lines = text.split(/\r?\n/);
  const sections = new Set<string>();
  const identity: Record<string, string> = {};
  const dependencies: PackageDependency[] = [];
  const issues: PackageIssue[] = [];
  const dependencyOccurrences = new Map<string, PackageDependency[]>();
  let section = '';

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const sourceLine = lines[index] ?? '';
    const line = stripComment(sourceLine).trim();
    if (line.length === 0) {
      continue;
    }

    const sectionMatch = /^\[([^\]]+)]$/.exec(line);
    if (sectionMatch) {
      section = (sectionMatch[1] ?? '').trim();
      sections.add(section);
      continue;
    }

    const assignment = findAssignment(line);
    if (!assignment) {
      issues.push(issue(
        'manifest.parse',
        'error',
        `Could not parse line ${lineNumber}; expected a TOML assignment.`,
        manifestPath,
        lineNumber,
        firstContentColumn(sourceLine),
        [openManifestRecommendation()]
      ));
      continue;
    }

    const key = unquote(assignment.key.trim());
    const value = parseValue(assignment.value.trim());

    if (section === 'package' && PACKAGE_KEYS.has(key) && value.stringValue !== undefined) {
      identity[key] = value.stringValue;
      continue;
    }

    if (isDependencySection(section)) {
      const dependency = dependencyFromValue(key, section, value, lineNumber);
      dependencies.push(dependency);
      const occurrences = dependencyOccurrences.get(key) ?? [];
      occurrences.push(dependency);
      dependencyOccurrences.set(key, occurrences);

      if (!isValidDependencyName(key)) {
        issues.push(issue(
          'manifest.dependency-invalid',
          'warning',
          `Dependency “${key}” should normally use the canonical org/name form.`,
          manifestPath,
          lineNumber,
          Math.max(0, sourceLine.indexOf(assignment.key)),
          [openManifestRecommendation()]
        ));
      }

      if (!dependency.requirement && !dependency.path && !dependency.git) {
        issues.push(issue(
          'manifest.dependency-invalid',
          'error',
          `Dependency “${key}” has no version requirement, local path, or Git source.`,
          manifestPath,
          lineNumber,
          Math.max(0, sourceLine.indexOf(assignment.key)),
          [openManifestRecommendation()]
        ));
      }
    }
  }

  if (!sections.has('package')) {
    issues.push(issue(
      'manifest.package-section-missing',
      'error',
      'The manifest does not contain a [package] section.',
      manifestPath,
      1,
      0,
      [openManifestRecommendation()]
    ));
  }

  validateIdentity(identity, manifestPath, issues);
  validateDuplicateDependencies(dependencyOccurrences, manifestPath, issues);

  return {
    identity: {
      ...(identity.org ? { org: identity.org } : {}),
      ...(identity.name ? { name: identity.name } : {}),
      ...(identity.version ? { version: identity.version } : {}),
      ...(identity.description ? { description: identity.description } : {}),
      ...(identity.language ? { language: identity.language } : {})
    },
    dependencies,
    issues,
    sections
  };
}

function validateIdentity(
  identity: Readonly<Record<string, string>>,
  manifestPath: string,
  issues: PackageIssue[]
): void {
  if (!identity.org) {
    issues.push(missingIdentityIssue('org', 'manifest.org-missing', manifestPath));
  }
  if (!identity.name) {
    issues.push(missingIdentityIssue('name', 'manifest.name-missing', manifestPath));
  }
  if (!identity.version) {
    issues.push(missingIdentityIssue('version', 'manifest.version-missing', manifestPath));
  } else if (!SEMVER.test(identity.version)) {
    issues.push(issue(
      'manifest.version-invalid',
      'warning',
      `Package version “${identity.version}” is not a conventional semantic version.`,
      manifestPath,
      1,
      0,
      [openManifestRecommendation()]
    ));
  }
}

function validateDuplicateDependencies(
  occurrences: ReadonlyMap<string, readonly PackageDependency[]>,
  manifestPath: string,
  issues: PackageIssue[]
): void {
  for (const [name, entries] of occurrences) {
    const sections = new Set(entries.map((entry) => entry.section));
    if (entries.length > 1 && sections.size > 1) {
      const first = entries[1] ?? entries[0];
      issues.push(issue(
        'manifest.dependency-duplicate',
        'warning',
        `Dependency “${name}” is declared in multiple dependency sections.`,
        manifestPath,
        first?.line ?? 1,
        0,
        [openManifestRecommendation()]
      ));
    }
  }
}

function missingIdentityIssue(
  key: 'org' | 'name' | 'version',
  code: 'manifest.org-missing' | 'manifest.name-missing' | 'manifest.version-missing',
  manifestPath: string
): PackageIssue {
  return issue(
    code,
    'error',
    `The [package] section is missing “${key}”.`,
    manifestPath,
    1,
    0,
    [openManifestRecommendation()]
  );
}

function dependencyFromValue(
  name: string,
  section: string,
  value: ParsedValue,
  line: number
): PackageDependency {
  const table = value.inlineTable;
  const requirement = value.stringValue
    ?? asString(table?.version)
    ?? asString(table?.rev)
    ?? asString(table?.tag);
  const path = asString(table?.path);
  const git = asString(table?.git);
  const optional = typeof table?.optional === 'boolean' ? table.optional : undefined;

  return {
    name,
    section,
    ...(requirement ? { requirement } : {}),
    ...(path ? { path } : {}),
    ...(git ? { git } : {}),
    ...(optional !== undefined ? { optional } : {}),
    line
  };
}

function parseValue(raw: string): ParsedValue {
  const stringValue = parseQuoted(raw);
  if (stringValue !== undefined) {
    return { raw, stringValue };
  }
  if (raw === 'true' || raw === 'false') {
    return { raw, booleanValue: raw === 'true' };
  }
  if (raw.startsWith('{') && raw.endsWith('}')) {
    return { raw, inlineTable: parseInlineTable(raw.slice(1, -1)) };
  }
  if (raw.length > 0 && !raw.startsWith('[')) {
    return { raw, stringValue: raw };
  }
  return { raw };
}

function parseInlineTable(body: string): Readonly<Record<string, string | boolean>> {
  const result: Record<string, string | boolean> = {};
  for (const fragment of splitTopLevel(body, ',')) {
    const assignment = findAssignment(fragment);
    if (!assignment) {
      continue;
    }
    const key = unquote(assignment.key.trim());
    const raw = assignment.value.trim();
    const quoted = parseQuoted(raw);
    if (quoted !== undefined) {
      result[key] = quoted;
    } else if (raw === 'true' || raw === 'false') {
      result[key] = raw === 'true';
    } else {
      result[key] = raw;
    }
  }
  return result;
}

function splitTopLevel(input: string, separator: string): string[] {
  const output: string[] = [];
  let quote: '"' | "'" | undefined;
  let depth = 0;
  let start = 0;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote === '"') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{' || character === '[') {
      depth += 1;
    } else if (character === '}' || character === ']') {
      depth = Math.max(0, depth - 1);
    } else if (character === separator && depth === 0) {
      output.push(input.slice(start, index).trim());
      start = index + 1;
    }
  }
  output.push(input.slice(start).trim());
  return output.filter((entry) => entry.length > 0);
}

function findAssignment(line: string): { key: string; value: string } | undefined {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote === '"') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '=') {
      return { key: line.slice(0, index), value: line.slice(index + 1) };
    }
  }
  return undefined;
}

function stripComment(line: string): string {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote === '"') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#') {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseQuoted(value: string): string | undefined {
  if (value.length < 2) {
    return undefined;
  }
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value.at(-1) !== quote) {
    return undefined;
  }
  const body = value.slice(1, -1);
  if (quote === "'") {
    return body;
  }
  try {
    return JSON.parse(value) as string;
  } catch {
    return body.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

function unquote(value: string): string {
  return parseQuoted(value) ?? value;
}

function isDependencySection(section: string): boolean {
  if (DEPENDENCY_SECTIONS.has(section)) {
    return true;
  }
  return /(^|\.)dependencies$/.test(section) || /(^|\.)dev-dependencies$/.test(section);
}

function isValidDependencyName(name: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(name);
}

function asString(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function firstContentColumn(line: string): number {
  const match = /\S/.exec(line);
  return match?.index ?? 0;
}

function openManifestRecommendation(): Recommendation {
  return { title: 'Open package manifest', kind: 'open-manifest' };
}

function issue(
  code: PackageIssue['code'],
  severity: PackageIssue['severity'],
  message: string,
  file: string,
  line: number,
  column: number,
  recommendations: readonly Recommendation[]
): PackageIssue {
  return { code, severity, message, file, line, column, recommendations };
}

use anyhow::Result;
use chrono::Utc;
use semver::Version;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use toml::Value;
use walkdir::{DirEntry, WalkDir};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recommendation {
    pub title: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageDependency {
    pub name: String,
    pub section: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requirement: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub optional: Option<bool>,
    pub line: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageIdentity {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageIssue {
    pub code: String,
    pub severity: String,
    pub message: String,
    pub file: String,
    pub line: usize,
    pub column: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub recommendations: Vec<Recommendation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageReport {
    pub root: String,
    pub manifest_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock_path: Option<String>,
    pub identity: PackageIdentity,
    pub dependencies: Vec<PackageDependency>,
    pub issues: Vec<PackageIssue>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportCounts {
    pub packages: usize,
    pub dependencies: usize,
    pub errors: usize,
    pub warnings: usize,
    pub infos: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReport {
    pub schema_version: u8,
    pub generated_at: String,
    pub workspace_roots: Vec<String>,
    pub packages: Vec<PackageReport>,
    pub issues: Vec<PackageIssue>,
    pub counts: ReportCounts,
    pub analyzer: String,
}

pub fn analyze_root(root: &Path, max_manifests: usize) -> Result<WorkspaceReport> {
    let manifests = discover_manifests(root, max_manifests.saturating_add(1));
    let selected = manifests.iter().take(max_manifests).cloned().collect::<Vec<_>>();
    let mut packages = selected
        .iter()
        .map(|manifest| analyze_manifest(manifest))
        .collect::<Vec<_>>();

    let graph_issues = detect_cycles(&packages);
    for graph_issue in graph_issues {
        if let Some(package) = packages
            .iter_mut()
            .find(|package| package.manifest_path == graph_issue.file)
        {
            package.issues.push(graph_issue);
        }
    }

    let mut issues = packages
        .iter()
        .flat_map(|package| package.issues.clone())
        .collect::<Vec<_>>();
    if manifests.len() > selected.len() {
        issues.push(PackageIssue {
            code: "workspace.limit".into(),
            severity: "warning".into(),
            message: format!(
                "Analysis stopped after {} manifests. Increase zedCursor.maxManifests to scan the remaining {}.",
                selected.len(),
                manifests.len() - selected.len()
            ),
            file: root.display().to_string(),
            line: 1,
            column: 0,
            length: None,
            detail: None,
            recommendations: vec![Recommendation {
                title: "Open Zed Package Insights settings".into(),
                kind: "edit".into(),
                command: None,
                detail: None,
            }],
        });
    }

    let counts = count_report(&packages, &issues);
    Ok(WorkspaceReport {
        schema_version: 1,
        generated_at: unix_timestamp_string(),
        workspace_roots: vec![root.display().to_string()],
        packages,
        issues,
        counts,
        analyzer: "rust".into(),
    })
}

fn discover_manifests(root: &Path, limit: usize) -> Vec<PathBuf> {
    let mut manifests = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(should_visit)
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file() && entry.file_name() == ".zpkg.toml")
        .map(DirEntry::into_path)
        .take(limit)
        .collect::<Vec<_>>();
    manifests.sort();
    manifests
}

fn should_visit(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    if !entry.file_type().is_dir() {
        return true;
    }
    !matches!(
        entry.file_name().to_string_lossy().as_ref(),
        ".git" | "node_modules" | "target" | ".zed" | ".zed-pack" | ".vendor"
    )
}

fn analyze_manifest(manifest_path: &Path) -> PackageReport {
    let root = manifest_path.parent().unwrap_or_else(|| Path::new("."));
    let lock_path = root.join(".zpkg.lock");
    let mut identity = PackageIdentity::default();
    let mut dependencies = Vec::new();
    let mut issues = Vec::new();

    match fs::read_to_string(manifest_path) {
        Ok(text) => match text.parse::<Value>() {
            Ok(value) => {
                if let Some(package) = value.get("package").and_then(Value::as_table) {
                    identity.org = string_field(package, "org");
                    identity.name = string_field(package, "name");
                    identity.version = string_field(package, "version");
                    identity.description = string_field(package, "description");
                    identity.language = string_field(package, "language");
                    validate_identity(&identity, manifest_path, &mut issues);
                } else {
                    issues.push(simple_issue(
                        "manifest.package-section-missing",
                        "error",
                        "The manifest does not contain a [package] section.",
                        manifest_path,
                        vec![open_manifest()],
                    ));
                }
                collect_dependency_sections(&value, "", &mut dependencies);
                validate_dependencies(root, manifest_path, &dependencies, &mut issues);
            }
            Err(error) => issues.push(PackageIssue {
                code: "manifest.parse".into(),
                severity: "error".into(),
                message: format!("Could not parse the package manifest: {error}"),
                file: manifest_path.display().to_string(),
                line: error.span().map(|span| byte_line(&text, span.start)).unwrap_or(1),
                column: 0,
                length: None,
                detail: Some(error.to_string()),
                recommendations: vec![open_manifest()],
            }),
        },
        Err(error) => issues.push(simple_issue(
            "manifest.parse",
            "error",
            &format!("Could not read the package manifest: {error}"),
            manifest_path,
            vec![open_manifest()],
        )),
    }

    let lock_exists = lock_path.is_file();
    validate_lock(manifest_path, &lock_path, &mut issues);

    PackageReport {
        root: root.display().to_string(),
        manifest_path: manifest_path.display().to_string(),
        lock_path: lock_exists.then(|| lock_path.display().to_string()),
        identity,
        dependencies,
        issues,
    }
}

fn validate_identity(
    identity: &PackageIdentity,
    manifest_path: &Path,
    issues: &mut Vec<PackageIssue>,
) {
    for (value, key, code) in [
        (&identity.org, "org", "manifest.org-missing"),
        (&identity.name, "name", "manifest.name-missing"),
        (&identity.version, "version", "manifest.version-missing"),
    ] {
        if value.as_deref().unwrap_or_default().is_empty() {
            issues.push(simple_issue(
                code,
                "error",
                &format!("The [package] section is missing “{key}”."),
                manifest_path,
                vec![open_manifest()],
            ));
        }
    }
    if let Some(version) = identity.version.as_deref() {
        if Version::parse(version).is_err() {
            issues.push(simple_issue(
                "manifest.version-invalid",
                "warning",
                &format!("Package version “{version}” is not a conventional semantic version."),
                manifest_path,
                vec![open_manifest()],
            ));
        }
    }
}

fn collect_dependency_sections(value: &Value, prefix: &str, output: &mut Vec<PackageDependency>) {
    let Some(table) = value.as_table() else {
        return;
    };
    for (key, child) in table {
        let section = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        if is_dependency_section(&section) {
            if let Some(dependencies) = child.as_table() {
                for (name, specification) in dependencies {
                    output.push(dependency_from_value(name, &section, specification));
                }
            }
        } else if child.is_table() && (key == "target" || prefix.starts_with("target")) {
            collect_dependency_sections(child, &section, output);
        }
    }
}

fn dependency_from_value(name: &str, section: &str, value: &Value) -> PackageDependency {
    if let Some(requirement) = value.as_str() {
        return PackageDependency {
            name: name.into(),
            section: section.into(),
            requirement: Some(requirement.into()),
            path: None,
            git: None,
            optional: None,
            line: 1,
        };
    }
    let table = value.as_table();
    PackageDependency {
        name: name.into(),
        section: section.into(),
        requirement: table
            .and_then(|table| string_field(table, "version"))
            .or_else(|| table.and_then(|table| string_field(table, "rev")))
            .or_else(|| table.and_then(|table| string_field(table, "tag"))),
        path: table.and_then(|table| string_field(table, "path")),
        git: table.and_then(|table| string_field(table, "git")),
        optional: table
            .and_then(|table| table.get("optional"))
            .and_then(Value::as_bool),
        line: 1,
    }
}

fn validate_dependencies(
    root: &Path,
    manifest_path: &Path,
    dependencies: &[PackageDependency],
    issues: &mut Vec<PackageIssue>,
) {
    let mut seen: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for dependency in dependencies {
        seen.entry(&dependency.name)
            .or_default()
            .insert(&dependency.section);
        if !is_canonical_dependency_name(&dependency.name) {
            issues.push(simple_issue(
                "manifest.dependency-invalid",
                "warning",
                &format!(
                    "Dependency “{}” should normally use the canonical org/name form.",
                    dependency.name
                ),
                manifest_path,
                vec![open_manifest()],
            ));
        }
        if dependency.requirement.is_none() && dependency.path.is_none() && dependency.git.is_none() {
            issues.push(simple_issue(
                "manifest.dependency-invalid",
                "error",
                &format!(
                    "Dependency “{}” has no version requirement, local path, or Git source.",
                    dependency.name
                ),
                manifest_path,
                vec![open_manifest()],
            ));
        }
        if let Some(relative_path) = dependency.path.as_deref() {
            if !root.join(relative_path).exists() {
                issues.push(PackageIssue {
                    code: "dependency.path-missing".into(),
                    severity: "error".into(),
                    message: format!(
                        "Local dependency “{}” points to missing path {}.",
                        dependency.name, relative_path
                    ),
                    file: manifest_path.display().to_string(),
                    line: dependency.line,
                    column: 0,
                    length: None,
                    detail: None,
                    recommendations: vec![
                        open_manifest(),
                        command_recommendation("Install dependencies", "install", &["install"]),
                    ],
                });
            }
        }
    }
    for (name, sections) in seen {
        if sections.len() > 1 {
            issues.push(simple_issue(
                "manifest.dependency-duplicate",
                "warning",
                &format!("Dependency “{name}” is declared in multiple dependency sections."),
                manifest_path,
                vec![open_manifest()],
            ));
        }
    }
}

fn validate_lock(manifest_path: &Path, lock_path: &Path, issues: &mut Vec<PackageIssue>) {
    if !lock_path.is_file() {
        issues.push(PackageIssue {
            code: "lock.missing".into(),
            severity: "warning".into(),
            message: "No .zpkg.lock file was found next to this package manifest.".into(),
            file: manifest_path.display().to_string(),
            line: 1,
            column: 0,
            length: None,
            detail: None,
            recommendations: vec![command_recommendation(
                "Create lockfile with zed install",
                "install",
                &["install"],
            )],
        });
        return;
    }

    match fs::read_to_string(lock_path) {
        Ok(content) if content.trim().is_empty() => issues.push(PackageIssue {
            code: "lock.empty".into(),
            severity: "error".into(),
            message: "The Zed lockfile is empty.".into(),
            file: lock_path.display().to_string(),
            line: 1,
            column: 0,
            length: None,
            detail: None,
            recommendations: vec![command_recommendation(
                "Regenerate lockfile with zed install",
                "install",
                &["install"],
            )],
        }),
        Ok(_) => {
            let manifest_modified = modified(manifest_path);
            let lock_modified = modified(lock_path);
            if let (Some(manifest_modified), Some(lock_modified)) = (manifest_modified, lock_modified) {
                if manifest_modified > lock_modified {
                    issues.push(PackageIssue {
                        code: "lock.stale".into(),
                        severity: "warning".into(),
                        message: "The package manifest is newer than the lockfile; dependencies may not be synchronized.".into(),
                        file: lock_path.display().to_string(),
                        line: 1,
                        column: 0,
                        length: None,
                        detail: None,
                        recommendations: vec![
                            command_recommendation(
                                "Update dependencies with zed install",
                                "install",
                                &["install"],
                            ),
                            command_recommendation(
                                "Verify frozen install",
                                "install-frozen",
                                &["install", "--frozen"],
                            ),
                        ],
                    });
                }
            }
        }
        Err(error) => issues.push(PackageIssue {
            code: "lock.empty".into(),
            severity: "error".into(),
            message: format!("Could not read the Zed lockfile: {error}"),
            file: lock_path.display().to_string(),
            line: 1,
            column: 0,
            length: None,
            detail: None,
            recommendations: vec![command_recommendation(
                "Regenerate lockfile with zed install",
                "install",
                &["install"],
            )],
        }),
    }
}

fn detect_cycles(packages: &[PackageReport]) -> Vec<PackageIssue> {
    let by_name = packages
        .iter()
        .filter_map(|package| canonical_name(package).map(|name| (name, package)))
        .collect::<HashMap<_, _>>();
    let graph = by_name
        .iter()
        .map(|(name, package)| {
            let local_dependencies = package
                .dependencies
                .iter()
                .filter(|dependency| by_name.contains_key(&dependency.name))
                .map(|dependency| dependency.name.clone())
                .collect::<Vec<_>>();
            (name.clone(), local_dependencies)
        })
        .collect::<HashMap<_, _>>();

    let mut visited = HashSet::new();
    let mut active = HashSet::new();
    let mut stack = Vec::new();
    let mut seen_cycles = HashSet::new();
    let mut issues = Vec::new();

    fn visit(
        node: &str,
        graph: &HashMap<String, Vec<String>>,
        by_name: &HashMap<String, &PackageReport>,
        visited: &mut HashSet<String>,
        active: &mut HashSet<String>,
        stack: &mut Vec<String>,
        seen_cycles: &mut HashSet<String>,
        issues: &mut Vec<PackageIssue>,
    ) {
        if active.contains(node) {
            if let Some(start) = stack.iter().position(|entry| entry == node) {
                let mut cycle = stack[start..].to_vec();
                cycle.push(node.to_string());
                let key = normalize_cycle(&cycle);
                if seen_cycles.insert(key) {
                    if let Some(package) = by_name.get(node) {
                        issues.push(PackageIssue {
                            code: "dependency.cycle".into(),
                            severity: "error".into(),
                            message: format!(
                                "Workspace dependency cycle detected: {}.",
                                cycle.join(" → ")
                            ),
                            file: package.manifest_path.clone(),
                            line: 1,
                            column: 0,
                            length: None,
                            detail: None,
                            recommendations: vec![
                                open_manifest(),
                                Recommendation {
                                    title: "Review dependency direction".into(),
                                    kind: "edit".into(),
                                    command: None,
                                    detail: None,
                                },
                            ],
                        });
                    }
                }
            }
            return;
        }
        if !visited.insert(node.to_string()) {
            return;
        }
        active.insert(node.to_string());
        stack.push(node.to_string());
        for neighbor in graph.get(node).into_iter().flatten() {
            visit(
                neighbor,
                graph,
                by_name,
                visited,
                active,
                stack,
                seen_cycles,
                issues,
            );
        }
        stack.pop();
        active.remove(node);
    }

    for node in graph.keys() {
        visit(
            node,
            &graph,
            &by_name,
            &mut visited,
            &mut active,
            &mut stack,
            &mut seen_cycles,
            &mut issues,
        );
    }
    issues
}

fn count_report(packages: &[PackageReport], issues: &[PackageIssue]) -> ReportCounts {
    ReportCounts {
        packages: packages.len(),
        dependencies: packages.iter().map(|package| package.dependencies.len()).sum(),
        errors: issues.iter().filter(|issue| issue.severity == "error").count(),
        warnings: issues
            .iter()
            .filter(|issue| issue.severity == "warning")
            .count(),
        infos: issues.iter().filter(|issue| issue.severity == "info").count(),
    }
}

fn canonical_name(package: &PackageReport) -> Option<String> {
    Some(format!(
        "{}/{}",
        package.identity.org.as_deref()?,
        package.identity.name.as_deref()?
    ))
}

fn normalize_cycle(cycle: &[String]) -> String {
    let body = &cycle[..cycle.len().saturating_sub(1)];
    let mut rotations = (0..body.len())
        .map(|index| {
            body[index..]
                .iter()
                .chain(body[..index].iter())
                .cloned()
                .collect::<Vec<_>>()
                .join("|")
        })
        .collect::<Vec<_>>();
    rotations.sort();
    rotations.into_iter().next().unwrap_or_default()
}

fn is_dependency_section(section: &str) -> bool {
    matches!(section, "dependencies" | "dev-dependencies" | "build-dependencies")
        || section.ends_with(".dependencies")
        || section.ends_with(".dev-dependencies")
}

fn is_canonical_dependency_name(name: &str) -> bool {
    let mut parts = name.split('/');
    matches!((parts.next(), parts.next(), parts.next()), (Some(org), Some(package), None) if !org.is_empty() && !package.is_empty())
}

fn string_field(table: &toml::map::Map<String, Value>, key: &str) -> Option<String> {
    table.get(key).and_then(Value::as_str).map(str::to_string)
}

fn modified(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).ok()?.modified().ok()
}

fn simple_issue(
    code: &str,
    severity: &str,
    message: &str,
    file: &Path,
    recommendations: Vec<Recommendation>,
) -> PackageIssue {
    PackageIssue {
        code: code.into(),
        severity: severity.into(),
        message: message.into(),
        file: file.display().to_string(),
        line: 1,
        column: 0,
        length: None,
        detail: None,
        recommendations,
    }
}

fn open_manifest() -> Recommendation {
    Recommendation {
        title: "Open package manifest".into(),
        kind: "open-manifest".into(),
        command: None,
        detail: None,
    }
}

fn command_recommendation(title: &str, kind: &str, command: &[&str]) -> Recommendation {
    Recommendation {
        title: title.into(),
        kind: kind.into(),
        command: Some(command.iter().map(|entry| (*entry).to_string()).collect()),
        detail: None,
    }
}

fn byte_line(text: &str, byte_offset: usize) -> usize {
    text.as_bytes()[..byte_offset.min(text.len())]
        .iter()
        .filter(|byte| **byte == b'\n')
        .count()
        + 1
}

fn unix_timestamp_string() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn analyzes_valid_manifest() {
        let directory = tempdir().expect("tempdir");
        fs::write(
            directory.path().join(".zpkg.toml"),
            r#"
[package]
org = "acme"
name = "demo"
version = "1.2.3"

[dependencies]
"acme/interfaces" = "^1.0.0"
"#,
        )
        .expect("manifest");
        fs::write(directory.path().join(".zpkg.lock"), "version = 1\n").expect("lock");

        let report = analyze_root(directory.path(), 10).expect("analysis");
        assert_eq!(report.packages.len(), 1);
        assert_eq!(report.packages[0].dependencies.len(), 1);
        assert_eq!(report.counts.errors, 0);
    }

    #[test]
    fn reports_missing_path_dependency() {
        let directory = tempdir().expect("tempdir");
        fs::write(
            directory.path().join(".zpkg.toml"),
            r#"
[package]
org = "acme"
name = "demo"
version = "1.2.3"

[dependencies]
"acme/local" = { path = "../missing" }
"#,
        )
        .expect("manifest");

        let report = analyze_root(directory.path(), 10).expect("analysis");
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.code == "dependency.path-missing"));
    }
}

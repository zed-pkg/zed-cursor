# Security policy

Please report vulnerabilities privately through GitHub Security Advisories for `zed-pkg/zed-cursor` once the repository is published.

Do not include real access tokens, private registry credentials, proprietary manifests, or sensitive workspace contents in a public issue.

Security-sensitive areas include:

- command construction and terminal execution;
- workspace trust handling;
- native analyzer binary resolution;
- webview content security policy and message validation;
- accidental collection or transmission of workspace data;
- release artifact integrity.

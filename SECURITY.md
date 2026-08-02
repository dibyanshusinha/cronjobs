# Security Policy

## Supported Versions

Security fixes target the latest released version.

## Reporting A Vulnerability

Please do not open a public issue for a suspected vulnerability.

Report security concerns privately through GitHub's private vulnerability
reporting flow if it is enabled for the repository. If that is not available,
contact the maintainer directly before disclosing details publicly.

## Security Model

GitHub mode is intended only for public, non-sensitive jobs. GitHub Secrets hide
secret values, but they do not hide job names, schedules, URLs, script source,
dashboard data, or execution history in a public repository.

Standalone mode is intended for private jobs. Keep the dashboard bound to
loopback or behind a TLS reverse proxy, keep authentication enabled, and store
private jobs, scripts, secrets, SQLite data, and backups outside Git.

## Sensitive Areas

Extra review is required for changes involving:

- script path resolution and interpreter selection;
- HTTP redirects, response-size limits, and header redaction;
- environment variable and secret-file handling;
- dashboard/API authentication;
- backup and restore;
- state backend implementations;
- history and dashboard data serialization.

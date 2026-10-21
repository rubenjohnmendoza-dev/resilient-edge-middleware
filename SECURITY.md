# Security Policy

## Supported Versions

The current `1.x` line is supported with security fixes. Older commits and
pre-release snapshots may not receive fixes.

## Reporting a Vulnerability

Please report vulnerabilities privately using GitHub's private vulnerability
reporting for this repository. If that is unavailable, contact the maintainer at
`rubenjohn6969mendoza@gmail.com` with:

- A concise description of the issue
- Reproduction steps or a proof of concept
- Affected version or commit
- Potential impact and any suggested mitigation

Do not include real credentials, customer data, or production secrets in a
report. Please allow time for triage before public disclosure.

## Scope

Security-sensitive areas include payload validation, Unicode normalization,
idempotency, circuit-breaker state, PocketBase persistence, trace logs, and
media metadata removal. Local-only chaos controls must never be exposed in a
production deployment.

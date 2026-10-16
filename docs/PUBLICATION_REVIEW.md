# Publication review — 2026-10-16

Scope: the sanitized source and its first public Git history, not a dump of a
running mailbox. This review is not a guarantee that all future use, accounts,
jurisdictions or deployments comply with every law or vendor rule.

## Files and private data

- Source/configuration was separated from the private operational workspace.
- Environments, production resource mappings, account clients/IDs, mailbox records,
  sessions, OAuth grants, mail originals, test receipts, authorization screenshots,
  logs, caches, backups and installed/generated packages are excluded.
- Third-party OAuth defaults are blank, signed out and unlinked. Test identities
  are synthetic. No third-party authorization is transferred to readers.
- Original copyright notices remain; third-party assets/fonts carry their own
  notices. See [third-party notices](../THIRD_PARTY_NOTICES.md).

## Security remediation

The pre-publication review found and fixed these issues before publishing:

1. Active attachment MIME types could open on the mailbox origin. Preview types
   are now an explicit passive allowlist; responses add sandbox CSP, nosniff,
   no-referrer and private no-store. Downloads preserve original bytes.
2. Send-only API tokens could forward existing content. Forward endpoints now
   require both read and send permissions.
3. Password resets did not invalidate pending pairing codes. Those codes are now
   revoked with other credentials.
4. A password-login race could create a session after rotation. Session insertion
   now atomically checks that the verified password hash is still current.

Regression coverage uses synthetic requests and real in-memory SQLite, including
attachment access boundaries, permission combinations, reset revocation and login races.
No live exploit mail or third-party security-scanning upload was used.

## Dependency and source checks

The old npm lock was omitted; Bun is the reproducible lock/install path. Compatible
dependency updates address reported advisories. Optional translation tooling that
pulled an unpatched development dependency was removed; locale files remain editable.
A cookie 1.x override replaces the vulnerable 0.6 dependency and is covered by the
authentication tests. Three initial Gitleaks findings were synthetic encryption-test
strings, replaced with unambiguous fixtures rather than excluding tests from scanning.

Local validation includes frozen installation, the full tests, type checking, a
production build, Bun's advisory audit, a clean-publication check, and redacted
Gitleaks scans of the exact publication tree and Git history. CI repeats these
checks without deployment secrets. Actions and the Gitleaks release/checksum are
pinned. MCP schemas use the SDK-supported Zod 4 entry point with matching dependency
versions. The full type checker uses an explicit 4 GiB heap budget; the local
default 2 GiB was insufficient after dependency updates.

Final validation of this source revision:

| Check | Result |
| --- | --- |
| Full synthetic test suite | 474 passed, 0 failed across 44 files |
| Full Svelte/TypeScript check | 0 errors; 4 existing UI/reactivity/accessibility warnings remain |
| Production build | Passed |
| Bun dependency-advisory audit | No reported advisories |
| Publication baseline / known private deployment and OAuth markers | Passed / no matches |
| Gitleaks intended source tree and complete public Git history | No leaks detected |
| Fresh unconfigured runtime | No mailbox session; Google/GitHub start disabled until own clients are configured |

These checks detect known patterns and observed regressions; they do not prove
absence of every secret, vulnerability or policy violation. Reproducible checks
and their latest results are available in [GitHub Actions](https://github.com/QuinnFreeze/wynn-mail/actions).

## Remaining boundaries

- This is a point-in-time source review, not a penetration-test certificate or a
  complete legal audit. No claim of absence of all vulnerabilities is made.
- Message HTML may request remote images. AI, notification and classification
  integrations have the data flows described in [PRIVACY.md](PRIVACY.md).
- Inline restrictions do not scan files for malware. Free tiers can reject work
  at quota. Recipient consent and actual content cannot be inferred from code.
- [COMPLIANCE.md](COMPLIANCE.md) records the official platform-policy assessment;
  operators must reassess policy, geography, retention and consent for their own use.

# Security

Use this repository's **Security → Report a vulnerability** feature for private
reports. Do not post credentials, authorization codes, cookies, mail content or
live exploit payloads in public issues. Prefer synthetic accounts and local fixtures.

Only the latest reviewed source is maintained; there is no security SLA. Operators
must update dependencies, protect domains/accounts, review access and monitor quotas.

- Keep accounts, mail, sessions, keys and OAuth grants in your private storage.
- Remove the temporary initialization token after administrator creation.
- Use verified-domain Sending access keys and signed delivery webhooks.
- Enable API/MCP sending only when needed. Its API-specific daily budget does not
  limit browser sends; provider quotas still apply.
- Active attachments download with restricted headers; this is not antivirus scanning.
- AI keys are encrypted at rest, but the running Worker can decrypt them. Keep the
  encryption key private; this is not end-to-end encryption.
- Never copy local environments, databases, `.wrangler`, browser exports or original
  mail into a repository, CI artifact or issue.

If a real secret is exposed, revoke/rotate it first, then address history, forks,
artifacts and logs. Deleting a current file alone does not revoke access.
[GitHub's sensitive-data guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).

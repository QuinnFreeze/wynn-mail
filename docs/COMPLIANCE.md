# Platform policy assessment

Reviewed: **2026-10-16**. This is a source and published-policy review, not legal
advice, vendor approval, or an assessment of every deployment or future action.

The publication baseline is sanitized source with blank OAuth credentials and
unconfigured, disconnected integrations. It includes no user accounts, mail,
vendor grants or service entitlements. Publishing this source is separate from
operating a public mailbox or OAuth application. Each operator must use their own
accounts, authorized domains and credentials, and follow current provider terms.

## Source publication and licensing

GitHub permits public repositories, subject to its [Acceptable Use
Policies](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies).
Publish only material you have the right to distribute; exclude credentials,
private correspondence and others' personal information. Public copies and forks
cannot reliably be recalled by later changing repository visibility.

Application code retains its upstream MIT notice. Separate asset, dependency and
trademark terms remain applicable; see [third-party notices](../THIRD_PARTY_NOTICES.md).
GitHub visibility alone does not grant an open-source license or clear third-party
rights. See [licensing a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository).

## Cloudflare: inbound routing and application hosting

Use domains and receiving accounts you own or are authorized to control. Workers,
D1 and KV are subject to Cloudflare's acceptable-use and developer-platform terms,
including restrictions on phishing, spam, malicious code, unlawful content and
circumventing limits. Operators remain responsible for content, third-party
licenses and their users' conduct.

This reference receives through Email Routing, stores mail through its own D1/KV
implementation, and sends through Resend. It is not a Cloudflare-provided durable
inbox. Routing does not guarantee delivery or provide an SLA; native Cloudflare
Email Sending has separate terms and access requirements. Technical capability
does not grant permission to bypass them.

Sources: [Self-Serve Subscription Agreement](https://www.cloudflare.com/terms/),
[Developer Platform, Email Service and Email Routing terms](https://www.cloudflare.com/service-specific-terms-developer-platform/).

## Resend: permission to send

Resend's [Acceptable Use Policy](https://resend.com/legal/acceptable-use) requires
recipients to have explicitly opted in. It prohibits unsolicited messages,
including cold outreach, purchased lists and scraped contacts; it also prohibits
multiple accounts used to bypass quotas. Its published thresholds require a
complaint rate below 0.08% and bounce rate below 4%. Additional requirements apply
to bulk sending. A verified domain and an API accepting arbitrary recipient
addresses do not waive those restrictions.

Send only authorized communications, use a Sending-access key restricted to your
verified domain, and protect recipients' information. Resend's [Terms of
Service](https://resend.com/legal/terms-of-service) also require rights to message
content, necessary permissions and an eligible account holder aged at least 18.

## Google and GitHub: optional identity authentication

The implementation requests Google `openid email`, not Gmail access. GitHub uses
an empty scope and public `/user` identity, not repository, write or private-email
permissions. Provider tokens are used for authentication rather than retained as
mailbox credentials. Existing mailbox ownership must be established before linking;
these integrations do not offer public mailbox signup.

Deployers must register their own clients, configure their own authorized HTTPS
callback, protect client secrets, request minimal permissions and accurately
describe identity-data use. A publicly operated Google OAuth app needs an
appropriate homepage, privacy disclosures and any applicable verification. The
personal-use policy exception is not permission to ignore other requirements.
Publishing a blank reference configuration does not itself operate such an app.

Sources: [Google OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies),
[Google user-data policy](https://developers.google.com/terms/api-services-user-data-policy),
[Google branding guidelines](https://developers.google.com/identity/branding-guidelines),
[GitHub OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps),
[GitHub API terms](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#h-api-terms).

## AI drafting and OpenRouter

OpenRouter's [official PKCE flow](https://openrouter.ai/docs/guides/overview/auth/oauth)
creates a user-controlled API key. The server encrypts the saved key and permits
only `openrouter/free` or `:free` models for this integration. Free access is still
subject to quotas, availability, account eligibility and the applicable model's
terms. OpenRouter's [Terms](https://openrouter.ai/terms) require users aged at least
18 and prohibit resale of API access and attempts to circumvent limits.

When a user requests an AI draft, selected thread text, subject, sender names and
addresses, message dates, standing instructions, and the latest message's
attachment names, MIME types and sizes are sent to the configured AI service and
downstream model provider. Attachment contents are not included by this drafting
path. Free models do not imply zero retention, no training, or processing confined to
Cloudflare. Requests do not enforce `provider.data_collection='deny'` or
zero-data-retention routing. Check the actual model/provider and account settings
before transmitting sensitive or third-party information. Drafts require human
review; generation does not itself send mail.

Sources: [OpenRouter privacy policy](https://openrouter.ai/privacy),
[data collection](https://openrouter.ai/docs/guides/privacy/data-collection),
[provider data-policy and ZDR controls](https://openrouter.ai/docs/guides/routing/provider-selection).

## Operator boundaries

- Local disconnection removes this mailbox's saved connection; it does not promise
  to revoke a remote OAuth grant or API key. Use the provider's authorized-app or
  API-key settings for remote revocation.
- Official service links and brand assets identify integrations. This independent
  project claims no affiliation, sponsorship or endorsement. Google marks remain
  subject to Google's branding rules, independently of the application license.
- Before publication, scan the intended files and any Git history. If a live secret
  was exposed, revoke or rotate it first; deleting a file or rewriting history
  does not invalidate it. See [GitHub's sensitive-data guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).
- Before hosting for others, provide deployment-specific privacy information,
  retention/deletion procedures and appropriate abuse controls. See
  [privacy and OAuth boundaries](PRIVACY.md).

This review did not verify any operator's identity, age, residence, sanctions or
export eligibility, recipient consent, vendor privacy settings, actual message
content, regulated-data duties or operating behavior. Those questions, including
applicable local law and cross-border processing, require deployment-specific
assessment. Policies and services can change. Neither this report nor a passing
technical test guarantees that all current or future use is lawful or permitted.

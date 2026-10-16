# Deploy your own unconfigured instance

No existing operator account, domain, database, mail, client ID, session or OAuth
connection is provided. Replace `example.com` / `https://mail.example.com` below.

## Resources

Install Node.js 22.12+ and Bun 1.4.3+, then `bun install --frozen-lockfile`.
Review your Cloudflare plan and current quotas before provisioning.

```sh
bunx wrangler login
bunx wrangler d1 create wynn-mail
bunx wrangler kv namespace create ATTACHMENTS_KV
```

Replace the zero D1 UUID and KV namespace ID in `wrangler.jsonc` with your own.
Keep real deployment configuration in a private overlay if desired. No R2 or
Workers AI resource is required. Add your own HTTPS custom-domain route:

```json
"routes": [{ "pattern": "mail.example.com", "custom_domain": true }]
```

Set `APP_URL` to that exact HTTPS origin and `CLOUDFLARE_MAIL_DOMAINS` to your
controlled mail domains. An empty list deliberately enables no domains.

## Mail providers

Verify your sending domain in Resend and add the current records shown by your own
dashboard. Enable Resend sending only. Keep receiving MX on Cloudflare Email Routing;
do not blindly replace an existing website or mail service's DNS.

After verification, set `RESEND_VERIFIED_SEND_DOMAINS`. It is an operator assertion,
intersected with `CLOUDFLARE_MAIL_DOMAINS`; Resend still checks actual verification.
Create a **Sending access** key restricted to your verified domain:

```sh
bunx wrangler secret put RESEND_API_KEY
```

Explicit-list mode does not read Resend's domains API, so Full access is unnecessary.
An explicit empty list disables sending. Enable Cloudflare Email Routing and route
the intended addresses to this Worker. Catch-all is optional and needs deliberate
ownership/retention decisions. This application provides the D1/KV persistent mailbox.

## Initialize safely

Generate your own random initialization token and add it as `BOOTSTRAP_TOKEN`.
Generate a separate random value of at least 32 characters for `ENCRYPTION_KEY`
before using AI settings. Keep values out of source/config/shared transcripts.

```sh
bunx wrangler secret put BOOTSTRAP_TOKEN
bunx wrangler secret put ENCRYPTION_KEY
bun run db:migrate:remote
bun run check
bun run test
bun run build
bunx wrangler deploy
```

Open your own `/setup`, supply the initialization token and create your administrator
with a unique password. Then remove the temporary secret:

```sh
bunx wrangler secret delete BOOTSTRAP_TOKEN
```

There is no shipped administrator, default password or public signup. Use the admin
UI for password resets. The old command-line reset helper is omitted to avoid
passwords in process arguments and shell history.

## Delivery webhook

Create a Resend webhook at `https://mail.example.com/api/webhooks/resend` for
`email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`,
`email.complained`, `email.failed`. Store its signing secret as `RESEND_WEBHOOK_SECRET`.

Resend webhooks are account-wide: other domains' sender/recipient/subject metadata
may reach this endpoint. In explicit-list Cloudflare inbound mode, signed events
outside the configured scope are ignored before D1 access. This is a storage filter,
not a promise that unrelated metadata never reaches the network. Use a dedicated
vendor account if your privacy requirements require that separation.

## Optional OAuth: initially signed out

Leave all four `OAUTH_*` secrets empty until you choose to build an integration.
Create your own clients and exact HTTPS callbacks:

| Provider | Callback on your origin | Identity permission |
| --- | --- | --- |
| Google | `/api/auth/social/google/callback` | `openid email` |
| GitHub | `/api/auth/social/github/callback` | Public `/user` identity, empty scope |

Store your own `OAUTH_GOOGLE_CLIENT_ID`, `OAUTH_GOOGLE_CLIENT_SECRET`,
`OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET` as Worker Secrets.
Provide accurate branding and a privacy notice when hosting for other people.
Users sign in to an existing mailbox, then explicitly link an identity in settings.
No mailbox is auto-claimed by matching an external email address.

OpenRouter connection starts in AI settings. Its callback is
`/api/settings/ai/oauth/openrouter/callback`. No OpenRouter account, key or cached
connection is distributed. OAuth permits free models only; examine actual provider
retention/availability before authorizing. ChatGPT/Claude subscription login is not included.

## Verify your own installation

Use consenting accounts you control. Verify actual recipient delivery, signed
events, replies, attachment hashes and original-message download. Test your own
OAuth clients. Local tests and someone else's deployment do not verify your install.

Review [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) and
[Resend quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits).
API/MCP sending is off by default. The code does not silently enable paid services
when storage/provider quotas run out.

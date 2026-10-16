# Wynn Mail

An independently maintained, self-hosted domain mailbox based on
[Quickinbox](https://github.com/DivinPrince/quickinbox). It combines Cloudflare
Email Routing, Workers, D1 and private KV storage with Resend outbound delivery.
The web client supports conversations, replies, attachments and original-message downloads.

This is a **sanitized source distribution**. It contains no deployed mailbox,
user database, mail, credentials, connected OAuth accounts or production resource
identifiers. Google, GitHub and AI accounts start **unconfigured and signed out**;
each developer decides whether to integrate them using their own accounts.

## Included

- Password login and optional Google/GitHub identity linking; no public signup.
- Administrator and standard accounts. Only administrators create accounts and
  mailboxes; standard accounts use addresses assigned to them.
- Cloudflare inbound mail and verified-domain, Sending-access-only Resend outbound mail.
- Web inbox, reply threading, attachment downloads and privately stored inbound `.eml` files.
- Optional OpenRouter OAuth with free-model-only routing; explicit API-key providers.
- REST/CLI/MCP integration. API-token and MCP sending is disabled in the reference config.
- Synthetic tests for authentication, permissions, webhooks, storage and OAuth.

ChatGPT and Claude subscription-account login are **not implemented**. Official
remote-integration approval requirements still apply. MCP access to this mailbox
is separate and does not grant access to those subscriptions.

## Get started

Use Node.js 22.12+ (Node 24 is tested) and Bun 1.4.3+.

```sh
bun install --frozen-lockfile
bun run test
bun run check
bun run build
```

Follow [the deployment guide](docs/DEPLOYMENT.md) for your own resources, domain,
providers and optional OAuth clients. Zero resource IDs, empty domain/origin values
and empty secrets must be configured before deployment. `bun run setup` only prints
guidance; it does not create accounts, enable billing or deploy. The obsolete npm
lock and upstream automatic R2 setup wizard are not distributed.

The mailbox exposes “Mark all as read” for the current inbox category or label,
and “Empty Trash” with a permanent-deletion confirmation. In Settings → General,
each user can independently enable read-mail-to-Trash and Trash deletion, choosing
3, 7, 15, 30 or a custom 1–3650 days. Both start disabled. Read-mail cleanup protects
starred, archived, spam, draft and sent mail; Trash expiry covers everything already
in Trash. The hourly Cron processes bounded batches and retries stored-object
cleanup. See [retention details](docs/PRIVACY.md#user-controlled-mail-retention).

## Cost and service limits

The reference architecture uses Workers Free, D1 and KV without R2 or Workers AI
bindings. No vendor account or entitlement is provided. Free quotas are shared with
your other projects and can change; check current vendor limits and your own billing
settings. Storage/delivery can fail at quota. Perpetual free hosting is not promised.

Inbound messages are limited to 5 MiB. Expanded attachments are limited to 1 MiB each,
up to five; additional MIME parts can remain in the original message. Only passive
supported types preview inline; active documents download with restrictive headers.
This is not antivirus scanning.

## Responsible use and privacy

Use domains and accounts you control, and send only to recipients who consented
to receive your communications. Resend prohibits unsolicited messages, cold outreach,
purchased lists and evasion of limits. This is not a bulk-mail or anonymous-relay service.
Review [the policy assessment](docs/COMPLIANCE.md).

Mail passes through Cloudflare; outbound content also goes to Resend. AI drafting
sends selected message context and instructions to the configured AI service and
downstream model provider. Free models do not imply zero retention or zero training.
Optional TypeSafe, Telegram and push features have additional data flows
and are unconfigured by default.

Message HTML can load remote images: the sender may learn your IP address, request
time and image tracking identifiers. `no-referrer` does not block this. The client
does not provide tracking blocking or end-to-end mail encryption.

See [privacy/OAuth boundaries](docs/PRIVACY.md) and [security reporting](SECURITY.md).
Disconnecting locally does not necessarily revoke a vendor-side grant; also use the
provider's authorized-app/API-key settings when ending access.

## Origin and licensing

Application code remains MIT with the original notice in [LICENSE.md](LICENSE.md).
Fonts, icons, artwork and packages have independent terms; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [UPSTREAM.md](UPSTREAM.md).
This independent project is not affiliated with, sponsored by or endorsed by
Google, GitHub, Cloudflare, Resend, OpenRouter, Anthropic or OpenAI.

[The publication review](docs/PUBLICATION_REVIEW.md) records checks and limits.
CI runs tests, type checking, a build, dependency auditing and secret scanning.
No deployment credentials or personal OAuth configuration are stored in Actions.

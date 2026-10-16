# Privacy and OAuth boundaries

This describes source behavior, not a completed operator privacy policy. Before
hosting for others, supply an accurate notice covering organization/contact route,
jurisdiction, purposes, retention, deletion, subprocessors and user rights.

## Default state

No signed-in users, mail, linked identities, AI connections, saved keys or personal
OAuth clients are distributed. Credential examples are blank and resource IDs are
dummy zeros. Migrations create schemas, not a live installation's records.

## Data flows

| Feature | Destination/data | Activation |
| --- | --- | --- |
| Inbound | Cloudflare receives MIME; bodies/indexes in private D1, originals/attachments in private KV | Operator configures routing |
| Outbound | Headers, recipients, body, attachments to Resend | User sends mail |
| Google/GitHub | OAuth transaction and minimum identity data | Operator configures its client; user links/logs in |
| AI drafting | Selected thread text, subject, sender identity, dates, instructions and attachment names/types/sizes to configured AI service/downstream model | User requests a draft |
| TypeSafe | Classification mail text to TypeSafe | Operator supplies optional key |
| Telegram | Mail notification text/attachments to configured chat via Telegram | Operator explicitly configures it |
| Push | Notification payload to browser push service | User subscribes to configured notifications |
| Remote images | IP, time and URL tracking identifiers to image host | A message with remote images renders |

Google asks for `openid email`, not Gmail access. GitHub uses empty scope and public
`/user` identity, not private repositories or private-email scope. Login provider
tokens are not stored as mailbox access credentials. OpenRouter OAuth yields a
separate API key, AES-GCM encrypted in D1 using the operator's Worker secret.

At-rest encryption does not prevent the Worker/operator from reading mail/keys.
HTTPS is transport encryption, not end-to-end mail encryption. Free AI routing
does not imply zero collection/retention/training. Requests do not force
`provider.data_collection='deny'` or zero-data-retention routing; examine the
actual model provider's policy before sending sensitive content.

Local disconnection blocks use by this mailbox, but does not promise vendor-side
revocation. Also revoke the app/key in the provider's authorized-app/API-key settings.
Mail HTML is scriptless, but remote images still load. `no-referrer` hides the
Referer, not IP/time/tracking IDs. Attachment restrictions are not malware scanning.

## User-controlled mail retention

Both automatic policies are disabled by default and belong to the signed-in
account. Users can independently enable either policy and choose 1–3650 days
(presets: 3, 7, 15, 30). A Worker Cron checks hourly in bounded batches; expiry
makes mail eligible, not an exact-time deletion promise.

The read-mail policy moves ordinary inbound inbox mail into Trash after the
configured continuous read period. Starred, archived, spam, draft and sent mail
are excluded. `read_at` records the current read period: marking unread resets
it, rereading does not, and restoring read mail starts a new period. Existing
read mail starts its clock when this schema migration is installed because its
historical read time is unknown.

The separate Trash policy permanently removes any mail that has spent the
configured period in Trash, including starred mail, drafts and sent mail already
placed there. Restoring mail before cleanup prevents this policy deleting it.
“Empty Trash” permanently removes the current user's Trash across all domain
filters after confirmation. These operations cannot be undone in the app.

Permanent deletion atomically removes mail/attachment database rows and queues
stored original/attachment keys for deletion. Bounded background cleanup retries
storage failures; physical object removal can lag behind database deletion.
Operator backups, platform recovery windows and recipient copies are separate
and are not erased by this app's retention controls.

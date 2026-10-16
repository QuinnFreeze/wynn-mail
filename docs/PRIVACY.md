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

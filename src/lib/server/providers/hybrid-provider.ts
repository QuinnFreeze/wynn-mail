import { ProviderError, type EmailProvider, type ProviderDomain } from '../email-provider';

/** Cloudflare handles inbound independently of the Resend sending domain.
 * Domain names are stable IDs even before the Resend account is connected. */
export function createHybridProvider(
	resend: EmailProvider | null,
	domains: string[],
	verifiedSendDomains?: readonly string[]
): EmailProvider {
	// A scoped sending-only key cannot read /domains. An explicit operator-
	// verified list avoids that API entirely; an empty list disables sending.
	const verified = verifiedSendDomains === undefined ? null : new Set(
		verifiedSendDomains.map((name) => name.toLowerCase()).filter((name) => domains.includes(name))
	);
	async function listDomains(): Promise<ProviderDomain[]> {
		const remote = verified === null && resend ? await resend.listDomains() : [];
		return domains.map((name) => {
			if (verified !== null) {
				const sendingEnabled = Boolean(resend) && verified.has(name);
				return {
					id: name, name, status: sendingEnabled ? 'verified' : 'receiving-only',
					region: null, sendingEnabled, receivingEnabled: true
				};
			}
			const sending = remote.find((domain) => domain.name.toLowerCase() === name);
			return {
				id: name,
				name,
				status: sending?.status ?? 'receiving-only',
				region: sending?.region ?? null,
				sendingEnabled: sending?.sendingEnabled ?? false,
				receivingEnabled: true
			};
		});
	}
	return {
		kind: 'resend',
		async send(input) {
			if (!domains.includes(input.from.domain_name.toLowerCase())) {
				throw new ProviderError(403, 'domain_not_allowed', 'Sending domain is not configured');
			}
			if (!resend) throw new ProviderError(503, 'sending_not_configured', 'Resend sending is not connected yet');
			if (verified !== null && !verified.has(input.from.domain_name.toLowerCase())) {
				throw new ProviderError(403, 'sending_domain_not_allowed', 'Domain has not been enabled for sending');
			}
			return resend.send(input);
		},
		listDomains,
		async getDomain(id) {
			const domain = (await listDomains()).find((item) => item.id === id.toLowerCase());
			if (!domain) throw new ProviderError(404, 'domain_not_allowed', 'Domain is not configured');
			return domain;
		}
	};
}

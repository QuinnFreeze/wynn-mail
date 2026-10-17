import type { LayoutServerLoad } from './$types';
import { emptyMailboxCounts } from '$lib/mail/categories';
import { hasAiProvider } from '$lib/server/draft-reply';
import { listLabels } from '$lib/server/labels';
import { getMailboxCounts } from '$lib/server/mail-store';
import { DEFAULT_UI_THEME } from '$lib/ui-theme/ids';
import { DEFAULT_LOCALE } from '$lib/i18n/locales';

export const load: LayoutServerLoad = async ({ locals, platform, depends }) => {
	depends('app:mail');
	const db = platform?.env.DB;
	const ready = Boolean(db && locals.user && !locals.user.must_change_password);

	// The sidebar shows these on every page, so they load with the shell.
	// Offer "Draft reply" only when there is a model to write it.
	const [counts, labels, aiDrafting] = await Promise.all([
		ready ? getMailboxCounts(db!, locals.user!.id, locals.activeDomainId) : emptyMailboxCounts(),
		ready ? listLabels(db!, locals.user!.id) : [],
		ready ? hasAiProvider(db!, locals.user!.id) : false
	]);

	return {
		user: locals.user,
		domains: locals.domains,
		addresses: locals.addresses,
		activeDomainId: locals.activeDomainId,
		accounts: locals.accounts,
		counts,
		labels,
		aiDrafting,
		uiTheme: locals.uiTheme ?? DEFAULT_UI_THEME,
		locale: locals.locale ?? DEFAULT_LOCALE
	};
};

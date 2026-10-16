import type { PageServerLoad } from './$types';
import { configuredSocialProviders } from '$lib/server/social-auth';

export const load: PageServerLoad = async ({ platform }) => ({
	socialProviders: platform?.env ? configuredSocialProviders(platform.env) : []
});

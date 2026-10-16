<script lang="ts">
	import Logo from '$lib/components/Logo.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import GoogleMark from '$lib/components/GoogleMark.svelte';
	import { APP_NAME } from '$lib/constants';
	import { discardPushSubscriptionFromAnotherAccount } from '$lib/push-client';
	import { t } from '$lib/i18n';
	import { safeNextPath } from '$lib/next-url';
	import { page } from '$app/stores';

	type SocialProvider = 'google' | 'github';
	let { data }: { data: { socialProviders?: SocialProvider[] } } = $props();
	const socialProviders: SocialProvider[] = ['google', 'github'];
	let socialBusy = $state<SocialProvider | null>(null);
	let email = $state('');
	let password = $state('');
	let error = $state('');
	let loading = $state(false);

	// Reached from the account menu while signed in: the existing account stays
	// signed in and the new one becomes active.
	const adding = $derived($page.url.searchParams.get('add') === '1');
	// After first-login setup another account may have been promoted meanwhile;
	// keep it rather than silently dropping it from the switcher.
	const keepOthers = $derived(adding || $page.url.searchParams.get('setup') === 'complete');
	// Interrupted OAuth consent: go back to that screen instead of the inbox.
	const next = $derived(safeNextPath($page.url.searchParams.get('next')));

	async function startSocialLogin(provider: SocialProvider) {
		error = '';
		socialBusy = provider;
		try {
			const response = await fetch(`/api/auth/social/${provider}/start`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ intent: 'login', next: next ?? undefined, add: keepOthers })
			});
			const body = (await response.json()) as { url?: string; error?: string };
			if (!response.ok || typeof body.url !== 'string') {
				error = body.error ?? t('social.loginFailed');
				return;
			}
			window.location.assign(body.url);
		} catch {
			error = t('common.networkError');
		} finally {
			socialBusy = null;
		}
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		error = '';
		loading = true;

		try {
			const res = await fetch('/api/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email, password, add: keepOthers })
			});
			const data = await res.json();
			if (!res.ok) {
				error = data.error ?? t('auth.loginFailed');
				return;
			}
			// When adding an account the previous owner of the push subscription is
			// still signed in on this browser, so leave it alone.
			if (!keepOthers) {
				try {
					await discardPushSubscriptionFromAnotherAccount();
				} catch (pushError) {
					console.warn('Could not reconcile the existing push subscription after login', pushError);
				}
			}
			window.location.href = data.user.must_change_password ? '/account/setup' : next ?? '/inbox';
		} catch {
			error = t('common.networkError');
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>{adding ? t('auth.addAccountTitle', { app: APP_NAME }) : t('auth.signInTitle', { app: APP_NAME })}</title>
</svelte:head>

<div class="auth-shell">
	<div class="auth-card">
		<div class="auth-brand">
			<div class="brand-icon"><Logo size={48} /></div>
			<h1>{adding ? t('auth.addAccount') : t('auth.signIn')}</h1>
			{#if adding}
				<p class="auth-hint">{t('auth.addAccountHint')}</p>
			{/if}
		</div>

		<form class="mt-8 space-y-4" onsubmit={submit}>
			{#if $page.url.searchParams.get('setup') === 'complete'}
				<p class="setup-complete">{t('accountSetup.complete')}</p>
			{/if}
			<div>
				<label for="email" class="text-sm text-[var(--color-text-secondary)]">{t('auth.email')}</label>
				<input id="email" type="email" bind:value={email} required autocomplete="username" class="auth-input" />
			</div>
			<div>
				<label for="password" class="text-sm text-[var(--color-text-secondary)]">{t('auth.password')}</label>
				<input
					id="password"
					type="password"
					bind:value={password}
					required
					autocomplete="current-password"
					class="auth-input"
				/>
			</div>

			{#if error}
				<p class="text-sm text-[var(--color-text-secondary)]" role="alert">{error}</p>
			{/if}

			<button type="submit" disabled={loading || socialBusy !== null} class="btn-primary mt-2 w-full py-2.5">
				{loading ? t('auth.signingIn') : t('common.continue')}
			</button>

			{#if adding}
				<a href="/inbox" class="auth-back">{t('auth.backToInbox')}</a>
			{/if}
		</form>

		<div class="social-login">
			<p class="social-divider">{t('social.orSignIn')}</p>
			{#if $page.url.searchParams.get('social') === 'error'}
				<p class="social-feedback" role="alert">{t('social.loginFailed')}</p>
			{/if}
			{#each socialProviders as provider (provider)}
				{@const configured = data.socialProviders?.includes(provider) ?? false}
				<button
					type="button"
					class="btn-ghost social-button"
					disabled={!configured || loading || socialBusy !== null}
					onclick={() => void startSocialLogin(provider)}
				>
					{#if provider === 'google'}<GoogleMark size={17} />{:else}<Icon name="github-fill" size={17} />{/if}
					{socialBusy === provider
						? t('common.connecting')
						: t('social.signInWith', { provider: provider === 'google' ? 'Google' : 'GitHub' })}
				</button>
				{#if !configured}
					<p class="social-unavailable">{t('social.notConfigured', { provider: provider === 'google' ? 'Google' : 'GitHub' })}</p>
				{/if}
			{/each}
			<p class="auth-hint social-hint">{t('social.loginHint')}</p>
		</div>
	</div>
</div>

<style>
	.social-login {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		margin-top: 1.5rem;
	}

	.social-divider {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}

	.social-divider::before,
	.social-divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--color-border);
	}

	.social-button {
		display: flex;
		justify-content: center;
		align-items: center;
		gap: 0.625rem;
		width: 100%;
		padding: 0.625rem;
		border: 1px solid var(--color-border);
		border-radius: 0.625rem;
	}

	.social-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.social-unavailable,
	.social-feedback {
		font-size: 0.75rem;
		line-height: 1.5;
		color: var(--color-text-secondary);
	}

	.social-unavailable { margin-top: -0.375rem; }
	.social-hint { text-align: center; margin-top: 0.125rem; }

	.auth-brand {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
	}

	.auth-hint {
		max-width: 22rem;
		margin-top: 0.5rem;
		font-size: 0.8125rem;
		line-height: 1.45;
		color: var(--color-text-secondary);
	}

	.auth-back {
		display: block;
		padding-top: 0.25rem;
		font-size: 0.8125rem;
		text-align: center;
		color: var(--color-text-secondary);
	}

	.auth-back:hover {
		color: var(--color-text);
	}

	.brand-icon {
		display: flex;
		margin-bottom: 1rem;
		overflow: hidden;
		/* Matches the mark's own corner radius so the shadow hugs the tile. */
		border-radius: 0.775rem;
		box-shadow: var(--shadow-sm);
	}

	.setup-complete {
		border: 1px solid var(--color-border);
		border-radius: 0.625rem;
		padding: 0.75rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		background: var(--color-surface-raised);
	}
</style>

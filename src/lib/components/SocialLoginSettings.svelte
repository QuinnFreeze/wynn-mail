<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import Icon from '$lib/components/Icon.svelte';
	import googleSignInMark from '$lib/assets/google-signin-round.png';
	import googleSignInMarkDark from '$lib/assets/google-signin-round-dark.png';
	import { t } from '$lib/i18n';

	type Provider = 'google' | 'github';
	type Connection = {
		provider: Provider;
		configured: boolean;
		connected: boolean;
		displayName?: string | null;
		connectedAt?: string | null;
	};
	const providerOrder: Provider[] = ['google', 'github'];
	let connections = $state<Connection[]>([]);
	let loading = $state(true);
	let busy = $state<Provider | null>(null);
	let error = $state('');
	let notice = $state('');
	const callback = $derived($page.url.searchParams.get('social'));

	function providerName(provider: Provider): string {
		return provider === 'google' ? 'Google' : 'GitHub';
	}

	onMount(() => { void load(); });

	async function load(): Promise<void> {
		loading = true;
		error = '';
		try {
			const response = await fetch('/api/settings/social', { cache: 'no-store' });
			const body = (await response.json()) as { providers?: Connection[]; error?: string };
			if (!response.ok || !Array.isArray(body.providers)) {
				error = body.error ?? t('social.loadFailed');
				return;
			}
			connections = body.providers;
		} catch {
			error = t('common.networkError');
		} finally {
			loading = false;
		}
	}

	async function connect(provider: Provider) {
		busy = provider;
		error = '';
		notice = '';
		try {
			const response = await fetch(`/api/auth/social/${provider}/start`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ intent: 'link' })
			});
			const body = (await response.json()) as { url?: string; error?: string };
			if (!response.ok || typeof body.url !== 'string') {
				error = body.error ?? t('social.connectionFailed');
				return;
			}
			window.location.assign(body.url);
		} catch {
			error = t('common.networkError');
		} finally {
			busy = null;
		}
	}

	async function disconnect(provider: Provider) {
		if (!confirm(t('social.disconnectConfirm', { provider: providerName(provider) }))) return;
		busy = provider;
		error = '';
		notice = '';
		try {
			const response = await fetch('/api/settings/social', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ provider })
			});
			if (!response.ok) {
				const body = (await response.json()) as { error?: string };
				error = body.error ?? t('social.disconnectFailed');
				return;
			}
			await load();
			if (!error) notice = t('social.disconnected', { provider: providerName(provider) });
		} catch {
			error = t('common.networkError');
		} finally {
			busy = null;
		}
	}
</script>

<section class="surface-lg card">
	<h2><Icon name="shield-user-line" size={18} /> {t('social.title')}</h2>
	<p class="card-hint">{t('social.settingsHint')}</p>
	{#if callback === 'connected' && !loading && connections.some((item) => item.connected) && !notice}
		<p class="feedback" role="status">{t('social.connectedNotice')}</p>
	{:else if callback === 'error' && !notice}
		<p class="feedback error" role="alert">{t('social.connectionFailed')}</p>
	{/if}

	{#if loading}
		<p class="card-hint" role="status">{t('common.loading')}</p>
	{:else if connections.length}
		<ul class="providers">
			{#each providerOrder as provider (provider)}
				{@const connection = connections.find((item) => item.provider === provider)}
				<li class="provider-row">
					<span class="provider-icon" class:google={provider === 'google'} aria-hidden="true">
						{#if provider === 'google'}
							<img class="google-mark google-mark-light" src={googleSignInMark} width="36" height="36" alt="" />
							<img class="google-mark google-mark-dark" src={googleSignInMarkDark} width="36" height="36" alt="" />
						{:else}
							<Icon name="github-fill" size={20} />
						{/if}
					</span>
					<div class="provider-details">
						<p class="provider-name">{providerName(provider)} <span class="connection-status">{connection?.connected ? t('social.connected') : t('social.notConnected')}</span></p>
						{#if connection?.connected}
							{#if connection.displayName}<p class="provider-hint">{connection.displayName}</p>{/if}
						{:else if !connection?.configured}
							<p class="provider-hint">{t('social.notConfigured', { provider: providerName(provider) })}</p>
						{/if}
					</div>
					{#if connection?.connected}
						<button type="button" class="btn-ghost" disabled={busy !== null} onclick={() => void disconnect(provider)}>
							{busy === provider ? t('common.disconnecting') : t('common.disconnect')}
						</button>
					{:else}
						<button type="button" class="btn-ghost" disabled={!connection?.configured || busy !== null} onclick={() => void connect(provider)}>
							{busy === provider ? t('common.connecting') : t('common.connect')}
						</button>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
	{#if notice}<p class="feedback" role="status">{notice}</p>{/if}
	{#if error}
		<p class="feedback error" role="alert">{error}</p>
		{#if !connections.length}<button type="button" class="btn-ghost retry" onclick={() => void load()}>{t('common.tryAgain')}</button>{/if}
	{/if}
</section>

<style>
	.card { margin-top: 1.5rem; padding: 1.5rem; }
	h2 { display: flex; align-items: center; gap: 0.5rem; margin: 0; font-size: 0.9375rem; font-weight: 600; }
	.card-hint, .provider-hint { margin: 0.375rem 0 0; font-size: 0.8125rem; line-height: 1.5; color: var(--color-muted); }
	.providers { display: flex; flex-direction: column; margin: 0.875rem 0 0; padding: 0; list-style: none; }
	.provider-row { display: flex; align-items: center; gap: 0.75rem; padding: 0.875rem 0; }
	.provider-row + .provider-row { border-top: 1px solid var(--color-line); }
	.provider-icon { display: flex; align-items: center; justify-content: center; width: 2.25rem; height: 2.25rem; border: 1px solid #747775; border-radius: 50%; background: #fff; flex-shrink: 0; }
	.provider-icon.google { border: 0; background: transparent; }
	.google-mark { display: block; width: 100%; height: 100%; }
	.google-mark-dark { display: none; }
	:global(:root[data-theme='dark']) .provider-icon { border-color: #8e918f; background: #131314; }
	:global(:root[data-theme='dark']) .provider-icon.google { background: transparent; }
	:global(:root[data-theme='dark']) .google-mark-light { display: none; }
	:global(:root[data-theme='dark']) .google-mark-dark { display: block; }
	.provider-details { flex: 1; min-width: 0; }
	.provider-name { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin: 0; font-size: 0.875rem; font-weight: 500; }
	.connection-status { font-size: 0.75rem; font-weight: 400; color: var(--color-muted); }
	.provider-hint { margin-top: 0.125rem; overflow-wrap: anywhere; }
	.feedback { margin: 0.75rem 0 0; font-size: 0.8125rem; line-height: 1.5; }
	.error { color: var(--color-danger); }
	.retry { margin-top: 0.5rem; }
	button:disabled { opacity: 0.5; cursor: not-allowed; }
	@media (max-width: 900px) { .card { padding: 1.25rem 1rem; } }
</style>

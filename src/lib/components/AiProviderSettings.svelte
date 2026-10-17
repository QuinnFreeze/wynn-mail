<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';
	import Icon from '$lib/components/Icon.svelte';
	import { t } from '$lib/i18n';

	type Kind = 'workers_ai' | 'openai' | 'anthropic' | 'openrouter' | 'gemini';
	type Provider = { kind: Kind; base_url: string | null; model: string; key_hint: string | null; auth_method?: 'api_key' | 'oauth' };
	type Settings = {
		provider: Provider | null;
		/** What a user without their own key drafts with. */
		fallback?: { kind: Kind; model: string } | null;
		canStoreKeys: boolean;
		workersAiAvailable?: boolean;
		oauth?: { openrouter: { available: boolean; freeOnly: true } };
		/** The user's standing instructions for every draft. */
		instructions?: string;
	};

	/** `user`: the signed-in person's own key. `instance`: the admin's default for everyone. */
	let { scope }: { scope: 'user' | 'instance' } = $props();

	const endpoint = $derived(scope === 'instance' ? '/api/admin/ai' : '/api/settings/ai');
	const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
	const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash-lite';

	const MODEL_PLACEHOLDERS: Record<Kind, string> = {
		workers_ai: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
		openai: 'gpt-5-mini',
		anthropic: 'claude-opus-5',
		openrouter: 'openrouter/free',
		gemini: GEMINI_DEFAULT_MODEL
	};

	let settings = $state<Settings | null>(null);
	let kind = $state<Kind>('openai');
	let baseUrl = $state('');
	let model = $state('');
	let apiKey = $state('');
	let busy = $state(false);
	let testing = $state(false);
	let removing = $state(false);
	let connectingOAuth = $state(false);
	let oauthError = $state('');
	let oauthNotice = $state('');
	let loadError = $state('');
	// Each form reports under its own buttons, even when both are busy at once.
	let providerNotice = $state('');
	let providerError = $state('');
	let instructionsNotice = $state('');
	let instructionsError = $state('');
	let instructions = $state('');
	let savingInstructions = $state(false);

	const kinds = $derived<Kind[]>(
		scope === 'instance' && settings?.workersAiAvailable
			? ['workers_ai', 'openai', 'gemini', 'anthropic']
			: scope === 'user' ? ['openrouter', 'openai', 'gemini', 'anthropic'] : ['openai', 'gemini', 'anthropic']
	);
	const needsKey = $derived(kind !== 'workers_ai' && kind !== 'openrouter');
	const openrouterConnected = $derived(settings?.provider?.kind === 'openrouter' && settings.provider.auth_method === 'oauth');
	const oauthCallback = $derived($page.url.searchParams.get('ai_oauth'));
	const oauthFeedback = $derived.by(() => {
		switch (oauthCallback) {
			case 'connected': return openrouterConnected ? t('ai.oauthConnected') : '';
			case 'invalid': return t('ai.oauthInvalid');
			case 'expired': return t('ai.oauthExpired');
			case 'cancelled': return t('ai.oauthCancelled');
			case 'failed': return t('ai.oauthFailed');
			default: return '';
		}
	});
	const savedKeyHint = $derived(
		settings?.provider?.kind === kind ? settings.provider.key_hint : null
	);

	function kindLabel(value: Kind): string {
		switch (value) {
			case 'workers_ai':
				return t('ai.kindWorkersAi');
			case 'openai':
				return t('ai.kindOpenai');
			case 'anthropic':
				return t('ai.kindAnthropic');
			case 'gemini':
				return t('ai.kindGemini');
			case 'openrouter':
				return 'OpenRouter';
			default: {
				const _never: never = value;
				return _never;
			}
		}
	}

	const status = $derived.by(() => {
		if (!settings) return '';
		const own = settings.provider;
		if (scope === 'instance') {
			return own
				? t('ai.instanceActive', { provider: kindLabel(own.kind), model: own.model })
				: t('ai.instanceOff');
		}
		if (own) return t(own.auth_method === 'oauth' ? 'ai.usingOAuth' : 'ai.usingOwn', { provider: kindLabel(own.kind), model: own.model });
		if (settings.fallback) {
			return t('ai.usingInstance', {
				provider: kindLabel(settings.fallback.kind),
				model: settings.fallback.model
			});
		}
		return t('ai.notSetUp');
	});

	onMount(() => {
		void load();
	});

	function defaultModel(value: Kind): string {
		return value === 'openrouter' ? 'openrouter/free' : value === 'gemini' ? GEMINI_DEFAULT_MODEL : '';
	}

	function fill(provider: Provider | null) {
		kind = provider?.kind ?? kinds[0];
		baseUrl = provider?.base_url ?? '';
		model = provider?.model ?? defaultModel(kind);
		apiKey = '';
	}

	/**
	 * Switching provider must not carry the old one's details over: saving would
	 * send the new key to the old address, or a key typed for one provider to the
	 * other. Switching back restores what is saved.
	 */
	function chooseKind(next: Kind) {
		if (next === kind) return;
		kind = next;
		const saved = settings?.provider?.kind === next ? settings.provider : null;
		baseUrl = saved?.base_url ?? '';
		model = saved?.model ?? defaultModel(next);
		apiKey = '';
	}

	async function load(): Promise<void> {
		try {
			const response = await fetch(endpoint, { cache: 'no-store' });
			const body = (await response.json()) as Settings & { error?: string };
			if (!response.ok) {
				loadError = body.error ?? t('common.tryAgain');
				return;
			}
			settings = body;
			fill(body.provider);
			instructions = body.instructions ?? '';
		} catch {
			loadError = t('common.networkError');
		}
	}

	async function connectOpenRouter() {
		connectingOAuth = true;
		oauthError = '';
		oauthNotice = '';
		try {
			const response = await fetch('/api/settings/ai/oauth/openrouter/start', { method: 'POST' });
			const body = (await response.json()) as { url?: string; error?: string };
			if (!response.ok || typeof body.url !== 'string') {
				oauthError = body.error ?? t('ai.oauthFailed');
				return;
			}
			window.location.assign(body.url);
		} catch {
			oauthError = t('common.networkError');
		} finally {
			connectingOAuth = false;
		}
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (kind === 'openrouter' && !openrouterConnected) {
			providerError = t('ai.connectFirst');
			return;
		}
		busy = true;
		providerError = '';
		providerNotice = '';
		try {
			const response = await fetch(endpoint, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					kind,
					baseUrl: kind === 'openrouter' ? 'https://openrouter.ai/api/v1' : kind === 'gemini' ? GEMINI_BASE_URL : baseUrl,
					model,
					apiKey
				})
			});
			const body = (await response.json()) as { provider?: Provider; error?: string };
			if (!response.ok || !body.provider) {
				providerError = body.error ?? t('common.tryAgain');
				return;
			}
			settings = { ...settings!, provider: body.provider };
			fill(body.provider);
			providerNotice = t('ai.saved');
			// The shell decides whether to offer "Draft reply" from the layout data.
			await invalidateAll();
		} catch {
			providerError = t('common.networkError');
		} finally {
			busy = false;
		}
	}

	async function saveInstructions(event: SubmitEvent) {
		event.preventDefault();
		savingInstructions = true;
		instructionsError = '';
		instructionsNotice = '';
		try {
			const response = await fetch(endpoint, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ instructions })
			});
			const body = (await response.json()) as { instructions?: string; error?: string };
			if (!response.ok) {
				instructionsError = body.error ?? t('common.tryAgain');
				return;
			}
			instructions = body.instructions ?? '';
			instructionsNotice = t('ai.instructionsSaved');
		} catch {
			instructionsError = t('common.networkError');
		} finally {
			savingInstructions = false;
		}
	}

	async function test() {
		testing = true;
		providerError = '';
		providerNotice = '';
		try {
			const response = await fetch(`${endpoint}/test`, { method: 'POST' });
			const body = (await response.json()) as { model?: string; reply?: string; error?: string };
			if (!response.ok) {
				providerError = body.error ?? t('common.tryAgain');
				return;
			}
			providerNotice = t('ai.testPassed', { model: body.model ?? '', reply: body.reply ?? '' });
		} catch {
			providerError = t('common.networkError');
		} finally {
			testing = false;
		}
	}

	async function remove() {
		const cancellingOnly = scope === 'user' && !settings?.provider;
		const confirmation = scope === 'instance'
			? t('ai.removeInstanceConfirm')
			: cancellingOnly
				? t('ai.cancelPendingOAuthConfirm')
				: openrouterConnected ? t('ai.removeOAuthConfirm') : t('ai.removeOwnConfirm');
		if (!confirm(confirmation)) return;
		removing = true;
		providerError = '';
		providerNotice = '';
		oauthError = '';
		oauthNotice = '';
		try {
			const response = await fetch(endpoint, { method: 'DELETE' });
			if (!response.ok) {
				if (cancellingOnly) oauthError = t('common.tryAgain');
				else providerError = t('common.tryAgain');
				return;
			}
			settings = { ...settings!, provider: null };
			fill(null);
			if (cancellingOnly) oauthNotice = t('ai.pendingOAuthCancelled');
			await invalidateAll();
		} catch {
			if (cancellingOnly) oauthError = t('common.networkError');
			else providerError = t('common.networkError');
		} finally {
			removing = false;
		}
	}
</script>

<section class="surface-lg card">
	<h2>
		<Icon name="sparkling-line" size={18} />
		{scope === 'instance' ? t('ai.instanceTitle') : t('ai.title')}
	</h2>
	<p class="card-hint">{scope === 'instance' ? t('ai.instanceHint') : t('ai.userHint')}</p>
	{#if status}<p class="status" role="status">{status}</p>{/if}

	{#if settings && scope === 'user'}
		<div class="oauth-connections">
			<h3>{t('ai.oauthTitle')}</h3>
			<p class="field-hint">{t('ai.oauthHint')}</p>
			<div class="oauth-provider">
				<div class="oauth-provider-details">
					<p class="oauth-provider-name">OpenRouter {#if openrouterConnected}<span class="oauth-badge">{t('social.connected')}</span>{/if}</p>
					<p class="field-hint">{t('ai.openrouterOauthHint')}</p>
					<a class="docs-link" href="https://openrouter.ai/docs/guides/overview/auth/oauth" target="_blank" rel="noopener noreferrer">{t('ai.officialDocs')} <Icon name="external-link-line" size={12} /></a>
				</div>
				<button
					type="button"
					class="btn-primary"
					disabled={connectingOAuth || busy || removing || !settings.oauth?.openrouter.available}
					onclick={() => void connectOpenRouter()}
				>
					{connectingOAuth ? t('common.connecting') : openrouterConnected ? t('ai.reconnectOpenrouter') : t('ai.connectOpenrouter')}
				</button>
				{#if !settings.provider}
					<button
						type="button"
						class="btn-ghost"
						disabled={connectingOAuth || busy || removing}
						onclick={() => void remove()}
					>
						{removing ? t('ai.cancellingPendingOAuth') : t('ai.cancelPendingOAuth')}
					</button>
				{/if}
			</div>
			{#if !settings.oauth?.openrouter.available}<p class="field-hint warn">{t('ai.oauthUnavailable')}</p>{/if}
			{#if oauthFeedback && !oauthNotice && !oauthError}<p class="oauth-feedback" class:error={oauthCallback !== 'connected'} role={oauthCallback === 'connected' ? 'status' : 'alert'}>{oauthFeedback}</p>{/if}
			{@render feedback(oauthNotice, oauthError)}

			<div class="oauth-availability">
				<div>
					<p class="oauth-provider-name">ChatGPT / OpenAI</p>
					<p class="field-hint">{t('ai.chatgptOauthUnavailable')}</p>
					<a class="docs-link" href="https://developers.openai.com/siwc/token-sharing-open-source" target="_blank" rel="noopener noreferrer">{t('ai.officialDocs')} <Icon name="external-link-line" size={12} /></a>
				</div>
				<div>
					<p class="oauth-provider-name">Claude / Anthropic</p>
					<p class="field-hint">{t('ai.claudeOauthUnavailable')}</p>
					<a class="docs-link" href="https://code.claude.com/docs/en/agent-sdk/overview" target="_blank" rel="noopener noreferrer">{t('ai.officialDocs')} <Icon name="external-link-line" size={12} /></a>
				</div>
			</div>
		</div>
	{/if}

	{#if settings}
		<form class="ai-form" onsubmit={save}>
			<fieldset class="kinds">
				<legend class="sr-only">{t('ai.provider')}</legend>
				{#each kinds as option (option)}
					<label class="kind" class:selected={kind === option}>
						<input
							type="radio"
							name="ai-kind-{scope}"
							value={option}
							checked={kind === option}
							onchange={() => chooseKind(option)}
						/>
						{kindLabel(option)}
					</label>
				{/each}
			</fieldset>

			<p class="field-hint">
				{#if kind === 'workers_ai'}
					{t('ai.workersAiHint')}
				{:else if kind === 'openrouter'}
					{t('ai.openrouterFreeHint')}
				{:else if kind === 'openai'}
					{t('ai.openaiHint')}
				{:else if kind === 'gemini'}
					{t('ai.geminiHint')}
				{:else}
					{t('ai.anthropicHint')}
				{/if}
			</p>
			{#if kind === 'gemini'}
				<div class="gemini-links">
					<a class="docs-link" href="https://aistudio.google.com/api-keys" target="_blank" rel="noopener noreferrer">{t('ai.geminiApiKeys')} <Icon name="external-link-line" size={12} /></a>
					<a class="docs-link" href="https://ai.google.dev/gemini-api/terms" target="_blank" rel="noopener noreferrer">{t('ai.geminiTerms')} <Icon name="external-link-line" size={12} /></a>
				</div>
			{/if}

			{#if kind === 'openai' || kind === 'anthropic'}
				<label class="field">
					<span>{t('ai.baseUrl')}</span>
					<input
						type="url"
						bind:value={baseUrl}
						required={kind === 'openai'}
						placeholder={kind === 'openai'
							? 'https://api.openai.com/v1'
							: t('ai.baseUrlOptional')}
						autocomplete="off"
					/>
				</label>
			{/if}

			<label class="field">
				<span>{t('ai.model')}</span>
				<input
					type="text"
					bind:value={model}
					required={kind === 'openai' || kind === 'openrouter'}
					placeholder={MODEL_PLACEHOLDERS[kind]}
					autocomplete="off"
				/>
			</label>

			{#if needsKey}
				<label class="field">
					<span>{t('ai.apiKey')}</span>
					<input
						type="password"
						bind:value={apiKey}
						required={!savedKeyHint}
						placeholder={savedKeyHint ? t('ai.keepKey', { hint: savedKeyHint }) : ''}
						autocomplete="off"
					/>
				</label>
				{#if !settings.canStoreKeys}
					<p class="field-hint warn">
						{scope === 'instance' ? t('ai.noEncryptionKeyAdmin') : t('ai.noEncryptionKey')}
					</p>
				{/if}
			{/if}

			<div class="actions">
				{#if settings.provider}
					<button type="button" class="btn-ghost text-xs danger" disabled={busy || connectingOAuth || removing} onclick={() => void remove()}>
						{t('common.remove')}
					</button>
					<button type="button" class="btn-ghost" disabled={testing || removing} onclick={() => void test()}>
						{testing ? t('ai.testing') : t('ai.test')}
					</button>
				{/if}
				<button type="submit" class="btn-primary" disabled={busy || connectingOAuth || removing || (kind === 'openrouter' && !openrouterConnected)}>
					{busy ? t('common.saving') : t('common.save')}
				</button>
			</div>
			{@render feedback(providerNotice, providerError)}
		</form>
	{/if}

	{#if settings && scope === 'user'}
		<form class="ai-form instructions" onsubmit={saveInstructions}>
			<label class="field">
				<span>{t('ai.instructions')}</span>
				<textarea
					bind:value={instructions}
					rows="4"
					maxlength={4000}
					placeholder={t('ai.instructionsPlaceholder')}
				></textarea>
			</label>
			<p class="field-hint">{t('ai.instructionsHint')}</p>
			<div class="actions">
				<button type="submit" class="btn-primary" disabled={savingInstructions}>
					{savingInstructions ? t('common.saving') : t('common.save')}
				</button>
			</div>
			{@render feedback(instructionsNotice, instructionsError)}
		</form>
	{/if}

	<!-- Before the settings load there is no form to put a message under. -->
	{#if !settings && loadError}<p class="error" role="alert">{loadError}</p>{/if}
</section>

{#snippet feedback(notice: string, error: string)}
	{#if notice}
		<p class="notice" role="status"><Icon name="check-line" size={15} /> {notice}</p>
	{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}
{/snippet}

<style>
	.card {
		margin-top: 1.5rem;
		padding: 1.5rem;
	}

	h2 {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0;
		font-size: 0.9375rem;
		font-weight: 600;
	}

	.card-hint,
	.field-hint {
		margin: 0.375rem 0 0;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--color-muted);
	}

	.status {
		margin: 0.75rem 0 0;
		font-size: 0.875rem;
		font-weight: 500;
	}

	.oauth-connections { margin-top: 1.25rem; }
	.oauth-connections h3 { margin: 0; font-size: 0.875rem; font-weight: 600; }
	.oauth-provider { display: flex; align-items: center; flex-wrap: wrap; gap: 0.875rem; margin-top: 0.875rem; padding: 1rem; border: 1px solid var(--color-line); border-radius: 0.625rem; }
	.oauth-provider-details { flex: 1; min-width: 12rem; }
	.oauth-provider-name { display: flex; align-items: center; gap: 0.5rem; margin: 0; font-size: 0.8125rem; font-weight: 500; }
	.oauth-badge { color: var(--color-muted); font-size: 0.75rem; font-weight: 400; }
	.oauth-feedback { margin: 0.75rem 0 0; font-size: 0.8125rem; line-height: 1.5; }
	.oauth-availability { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--color-line); }
	.docs-link { display: inline-flex; align-items: center; gap: 0.25rem; margin-top: 0.375rem; font-size: 0.75rem; color: var(--color-muted); text-decoration: underline; text-underline-offset: 0.15rem; }
	.docs-link:hover { color: var(--color-text); }
	.gemini-links { display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; }
	button:disabled { cursor: not-allowed; }

	.ai-form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-top: 1rem;
	}

	.kinds {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
		margin: 0;
		padding: 0;
		border: none;
	}

	.kind {
		position: relative;
		padding: 0.375rem 0.75rem;
		border: 1px solid var(--color-line);
		border-radius: 999px;
		font-size: 0.8125rem;
		cursor: pointer;
	}

	.kind input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}

	.kind:has(input:focus-visible) {
		outline: 2px solid var(--color-accent);
		outline-offset: 3px;
	}

	.kind.selected {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 1px var(--color-accent);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		font-size: 0.8125rem;
		font-weight: 500;
	}

	.instructions {
		margin-top: 1.5rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--color-line);
	}

	.field input,
	.field textarea {
		border: 1px solid var(--color-line);
		border-radius: 0.5rem;
		padding: 0.5rem 0.625rem;
		font: inherit;
		font-weight: 400;
		background: var(--color-surface);
		color: var(--color-text);
		min-width: 0;
	}

	.warn {
		color: var(--color-danger);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	.danger {
		color: var(--color-danger);
		margin-right: auto;
	}

	.notice,
	.error {
		margin: 0;
		font-size: 0.8125rem;
		overflow-wrap: anywhere;
	}

	.notice {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.error {
		color: var(--color-danger);
	}

	@media (max-width: 600px) {
		.oauth-availability { grid-template-columns: 1fr; }
		.oauth-provider .btn-primary { width: 100%; }
	}

	@media (max-width: 900px) {
		.card {
			padding: 1.25rem 1rem;
		}
	}
</style>

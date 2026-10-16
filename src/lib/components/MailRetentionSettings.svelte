<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { t } from '$lib/i18n';

	type RetentionSettings = {
		readEnabled: boolean;
		readDays: number;
		trashEnabled: boolean;
		trashDays: number;
	};

	const presets = [3, 7, 15, 30];
	const id = $props.id();
	let readEnabled = $state(false);
	let readDays = $state<number | undefined>(30);
	let trashEnabled = $state(false);
	let trashDays = $state<number | undefined>(30);
	let readChoice = $state('30');
	let trashChoice = $state('30');
	let baseline = $state<RetentionSettings | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let saved = $state(false);
	let editVersion = 0;
	let disposed = false;
	let loadController: AbortController | null = null;
	let saveController: AbortController | null = null;

	const dirty = $derived(baseline !== null && (
		readEnabled !== baseline.readEnabled || readDays !== baseline.readDays ||
		trashEnabled !== baseline.trashEnabled || trashDays !== baseline.trashDays
	));
	const validDays = $derived(isDayCount(readDays) && isDayCount(trashDays));
	const disabled = $derived(loading || saving || baseline === null);

	function isDayCount(value: unknown): value is number {
		return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3650;
	}

	function parseSettings(value: unknown): RetentionSettings | null {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
		const settings = value as Record<string, unknown>;
		if (typeof settings.readEnabled !== 'boolean' || !isDayCount(settings.readDays) ||
			typeof settings.trashEnabled !== 'boolean' || !isDayCount(settings.trashDays)) return null;
		return {
			readEnabled: settings.readEnabled,
			readDays: settings.readDays,
			trashEnabled: settings.trashEnabled,
			trashDays: settings.trashDays
		};
	}

	function applySettings(settings: RetentionSettings) {
		readEnabled = settings.readEnabled;
		readDays = settings.readDays;
		trashEnabled = settings.trashEnabled;
		trashDays = settings.trashDays;
		readChoice = presets.includes(settings.readDays) ? String(settings.readDays) : 'custom';
		trashChoice = presets.includes(settings.trashDays) ? String(settings.trashDays) : 'custom';
	}

	function edited() {
		editVersion += 1;
		saved = false;
		error = '';
	}

	function chooseDays(kind: 'read' | 'trash', choice: string) {
		if (kind === 'read') {
			readChoice = choice;
			if (choice !== 'custom') readDays = Number(choice);
		} else {
			trashChoice = choice;
			if (choice !== 'custom') trashDays = Number(choice);
		}
		edited();
	}

	function toggleRule(kind: 'read' | 'trash', enabled: boolean) {
		if (kind === 'read') {
			readEnabled = enabled;
			if (!enabled && !isDayCount(readDays)) readDays = baseline?.readDays ?? 30;
		} else {
			trashEnabled = enabled;
			if (!enabled && !isDayCount(trashDays)) trashDays = baseline?.trashDays ?? 30;
		}
		edited();
	}

	onMount(() => {
		void load();
		return () => {
			disposed = true;
			loadController?.abort();
			saveController?.abort();
		};
	});

	async function load() {
		loadController?.abort();
		const controller = new AbortController();
		loadController = controller;
		const version = editVersion;
		loading = true;
		error = '';
		try {
			const response = await fetch('/api/settings/mail-retention', {
				cache: 'no-store', signal: controller.signal
			});
			const settings = parseSettings(await response.json());
			if (disposed || controller.signal.aborted) return;
			if (!response.ok || !settings) {
				error = t('mailRetention.loadFailed');
				return;
			}
			// A delayed response must not overwrite edits made after this request began.
			if (editVersion === version) applySettings(settings);
			baseline = settings;
		} catch {
			if (!disposed && !controller.signal.aborted) error = t('mailRetention.loadFailed');
		} finally {
			if (!disposed && loadController === controller) loading = false;
		}
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (disabled || !dirty) return;
		if (!isDayCount(readDays) || !isDayCount(trashDays)) {
			error = t('mailRetention.invalidDays');
			return;
		}
		const settings: RetentionSettings = { readEnabled, readDays, trashEnabled, trashDays };
		const version = editVersion;
		const controller = new AbortController();
		saveController = controller;
		saving = true;
		saved = false;
		error = '';
		try {
			const response = await fetch('/api/settings/mail-retention', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(settings),
				signal: controller.signal
			});
			const updated = parseSettings(await response.json());
			if (disposed || controller.signal.aborted) return;
			if (!response.ok || !updated) {
				error = t('mailRetention.saveFailed');
				return;
			}
			if (editVersion === version) {
				applySettings(updated);
				saved = true;
			}
			baseline = updated;
		} catch {
			if (!disposed && !controller.signal.aborted) error = t('mailRetention.saveFailed');
		} finally {
			if (!disposed && saveController === controller) saving = false;
		}
	}
</script>

<section class="surface-lg card" aria-labelledby={`${id}-title`} aria-busy={loading || saving}>
	<h2 id={`${id}-title`}><Icon name="time-line" size={18} /> {t('mailRetention.title')}</h2>
	<p class="card-hint">{t('mailRetention.description')}</p>
	{#if loading}<p class="feedback" role="status">{t('common.loading')}</p>{/if}
	<form onsubmit={save}>
		<fieldset {disabled}>
			<div class="rule">
				<label class="toggle-label">
					<input
						type="checkbox"
						checked={readEnabled}
						aria-describedby={`${id}-read-hint ${id}-read-protected`}
						onchange={(event) => toggleRule('read', event.currentTarget.checked)}
					/>
					<span>{t('mailRetention.readLabel')}</span>
				</label>
				<p class="card-hint" id={`${id}-read-hint`}>{t('mailRetention.readHint')}</p>
				<p class="card-hint" id={`${id}-read-protected`}>{t('mailRetention.readProtected')}</p>
				<div class="day-controls">
					<label for={`${id}-read-preset`}>{t('mailRetention.after')}</label>
					<select id={`${id}-read-preset`} value={readChoice} disabled={!readEnabled} onchange={(event) => chooseDays('read', event.currentTarget.value)}>
						{#each presets as days}<option value={String(days)}>{t('mailRetention.days', { count: days })}</option>{/each}
						<option value="custom">{t('mailRetention.custom')}</option>
					</select>
					{#if readChoice === 'custom'}
						<label class="custom-label" for={`${id}-read-days`}>{t('mailRetention.customDays')}</label>
						<input id={`${id}-read-days`} type="number" min="1" max="3650" step="1" inputmode="numeric" bind:value={readDays} disabled={!readEnabled} required={readEnabled} aria-invalid={!isDayCount(readDays)} aria-describedby={`${id}-day-range`} oninput={edited} />
					{/if}
				</div>
			</div>
			<div class="rule">
				<label class="toggle-label">
					<input
						type="checkbox"
						checked={trashEnabled}
						aria-describedby={`${id}-trash-hint ${id}-trash-warning`}
						onchange={(event) => toggleRule('trash', event.currentTarget.checked)}
					/>
					<span>{t('mailRetention.trashLabel')}</span>
				</label>
				<p class="card-hint" id={`${id}-trash-hint`}>{t('mailRetention.trashHint')}</p>
				<p class="warning" id={`${id}-trash-warning`}><Icon name="error-warning-line" size={15} /> {t('mailRetention.trashWarning')}</p>
				<div class="day-controls">
					<label for={`${id}-trash-preset`}>{t('mailRetention.after')}</label>
					<select id={`${id}-trash-preset`} value={trashChoice} disabled={!trashEnabled} onchange={(event) => chooseDays('trash', event.currentTarget.value)}>
						{#each presets as days}<option value={String(days)}>{t('mailRetention.days', { count: days })}</option>{/each}
						<option value="custom">{t('mailRetention.custom')}</option>
					</select>
					{#if trashChoice === 'custom'}
						<label class="custom-label" for={`${id}-trash-days`}>{t('mailRetention.customDays')}</label>
						<input id={`${id}-trash-days`} type="number" min="1" max="3650" step="1" inputmode="numeric" bind:value={trashDays} disabled={!trashEnabled} required={trashEnabled} aria-invalid={!isDayCount(trashDays)} aria-describedby={`${id}-day-range`} oninput={edited} />
					{/if}
				</div>
			</div>
			{#if readChoice === 'custom' || trashChoice === 'custom'}
				<p class="card-hint" id={`${id}-day-range`}>{t('mailRetention.invalidDays')}</p>
			{/if}
			<p class="card-hint schedule-note">{t('mailRetention.scheduleHint')}</p>
			<div class="actions">
				{#if dirty}<span class="card-hint">{t('mailRetention.unsaved')}</span>{/if}
				<button type="submit" class="btn-primary" disabled={disabled || !dirty || !validDays}>
					{saving ? t('common.saving') : t('common.save')}
				</button>
			</div>
		</fieldset>
	</form>
	{#if saved}<p class="feedback saved" role="status">{t('mailRetention.saved')}</p>{/if}
	{#if error}
		<p class="feedback error" role="alert">{error}</p>
		{#if !baseline}<button type="button" class="btn-ghost retry" disabled={loading} onclick={() => void load()}>{t('common.tryAgain')}</button>{/if}
	{/if}
</section>

<style>
	.card { margin-top: 1.5rem; padding: 1.5rem; }
	h2 { display: flex; align-items: center; gap: 0.5rem; margin: 0; font-size: 0.9375rem; font-weight: 600; }
	.card-hint { margin: 0.375rem 0 0; font-size: 0.8125rem; line-height: 1.5; color: var(--color-muted); }
	fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
	.rule { padding: 1rem 0; }
	.rule + .rule { border-top: 1px solid var(--color-line); }
	.toggle-label { display: flex; align-items: center; gap: 0.625rem; min-height: 2.75rem; font-size: 0.875rem; font-weight: 500; cursor: pointer; }
	.toggle-label input { flex-shrink: 0; width: 1.125rem; height: 1.125rem; accent-color: var(--color-accent); }
	.day-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 0.625rem; margin-top: 0.75rem; font-size: 0.8125rem; color: var(--color-text-secondary); }
	.day-controls select, .day-controls input { min-height: 2.75rem; padding: 0.5rem 0.75rem; border: 1px solid var(--color-line); border-radius: 0.625rem; color: var(--color-text); background: var(--color-surface-muted); font: inherit; }
	.day-controls select { max-width: 100%; }
	.day-controls input { width: 6.5rem; }
	input:focus-visible, select:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
	input:disabled, select:disabled { opacity: 0.5; cursor: default; }
	.warning { display: flex; align-items: flex-start; gap: 0.375rem; margin: 0.5rem 0 0; font-size: 0.8125rem; line-height: 1.5; color: var(--color-danger); }
	.warning :global(i) { flex-shrink: 0; margin-top: 0.15rem; }
	.schedule-note { border-top: 1px solid var(--color-line); padding-top: 0.875rem; }
	.actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 0.75rem; margin-top: 1rem; }
	.actions .card-hint { flex: 1; min-width: 0; margin: 0; }
	.actions button { min-height: 2.75rem; }
	.feedback { margin: 0.75rem 0 0; font-size: 0.8125rem; line-height: 1.5; }
	.saved { color: var(--tone-good-fg); }
	.error { color: var(--color-danger); }
	.retry { margin-top: 0.5rem; }
	@media (max-width: 30rem) {
		.card { padding: 1rem; }
		.day-controls { column-gap: 0.5rem; }
		.custom-label { flex-basis: 100%; }
	}
</style>

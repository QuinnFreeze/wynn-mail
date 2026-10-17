import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
// @ts-expect-error bun:sqlite is supplied by the test runtime.
import { Database } from 'bun:sqlite';
import {
	AiProviderError,
	chatCompletionsUrl,
	generateText,
	getAiProvider,
	GEMINI_BASE_URL,
	INSTANCE_OWNER,
	OPENROUTER_BASE_URL,
	resolveAiProvider,
	saveAiProvider,
	saveOpenRouterOAuthProvider,
	type AiEnv,
	type ResolvedAiProvider
} from './ai-provider';
import { createTestDb, insertTestUser } from './test-db';

const env: AiEnv = { ENCRYPTION_KEY: 'e'.repeat(40) };

function setup() {
	const { db, sqlite } = createTestDb();
	insertTestUser(sqlite, 'user-1');
	insertTestUser(sqlite, 'user-2');
	return { db, sqlite };
}

const openai = {
	kind: 'openai',
	baseUrl: 'https://sub2api.example.com/v1/',
	model: 'gpt-5-mini',
	apiKey: 'sk-secret-9876'
};

describe('saveAiProvider', () => {
	test('Gemini seals a key for its owner, fixes the host and keeps a saved key when changing models', async () => {
		const { db, sqlite } = setup();
		const saved = await saveAiProvider(db, env, 'user-1', { kind: 'gemini', apiKey: 'gemini-test-key-9876' });
		assert.equal(saved.kind, 'gemini');
		assert.equal(saved.base_url, GEMINI_BASE_URL);
		assert.equal(saved.auth_method, 'api_key');
		assert.equal(saved.key_hint, '9876');
		assert.ok(!JSON.stringify(saved).includes('gemini-test-key'));
		const stored = sqlite.query("SELECT api_key FROM ai_providers WHERE owner = 'user-1'").all()[0];
		assert.ok(!String(stored.api_key).includes('gemini-test-key'));
		await saveAiProvider(db, env, 'user-1', { kind: 'gemini', model: 'models/gemini-test-model' });
		const resolved = await resolveAiProvider(db, env, 'user-1');
		assert.equal(resolved?.apiKey, 'gemini-test-key-9876');
		assert.equal(resolved?.model, 'gemini-test-model');
		assert.equal(await resolveAiProvider(db, env, 'user-2'), null);
		await assert.rejects(saveAiProvider(db, env, 'user-1', { kind: 'gemini', baseUrl: 'https://attacker.example', apiKey: 'other-test-key' }), /fixed API URL/);
		await assert.rejects(saveAiProvider(db, env, 'user-2', { kind: 'gemini' }), /API key is required/);
		await assert.rejects(saveAiProvider(db, env, 'user-1', { kind: 'openai', baseUrl: GEMINI_BASE_URL, model: 'gemini-test-model' }), /API key is required/);
		await saveAiProvider(db, env, INSTANCE_OWNER, { kind: 'gemini', apiKey: 'instance-test-key' });
		assert.equal((await resolveAiProvider(db, env, 'user-2'))?.source, 'instance');
		assert.equal((await resolveAiProvider(db, env, 'user-1'))?.source, 'user');
	});

	test('Gemini model IDs cannot inject paths, query parameters or fragments', async () => {
		const { db } = setup();
		for (const model of ['../other', 'gemini-test?key=other', 'gemini-test#other', 'gemini-test/other', 'models/models/gemini-test', 'https://attacker.example']) {
			await assert.rejects(saveAiProvider(db, env, 'user-1', { kind: 'gemini', model, apiKey: 'gemini-test-key' }), /Gemini model ID/);
		}
		assert.equal(await getAiProvider(db, 'user-1'), null);
	});

	test('stores a personal key sealed, showing only its last four characters', async () => {
		const { db, sqlite } = setup();
		const saved = await saveAiProvider(db, env, 'user-1', openai);

		assert.deepEqual(
			{ kind: saved.kind, base_url: saved.base_url, model: saved.model, key_hint: saved.key_hint },
			{ kind: 'openai', base_url: 'https://sub2api.example.com/v1', model: 'gpt-5-mini', key_hint: '9876' }
		);
		const stored = sqlite.query('SELECT api_key FROM ai_providers WHERE owner = ?').all('user-1')[0] as {
			api_key: string;
		};
		assert.ok(!stored.api_key.includes('sk-secret'));
	});

	test('keeps the saved key when only the model changes', async () => {
		const { db } = setup();
		await saveAiProvider(db, env, 'user-1', openai);
		await saveAiProvider(db, env, 'user-1', { ...openai, model: 'gpt-5', apiKey: '' });

		const resolved = await resolveAiProvider(db, env, 'user-1');
		assert.equal(resolved?.model, 'gpt-5');
		assert.equal(resolved?.apiKey, 'sk-secret-9876');
	});

	test('asks for a new key when the base URL changes', async () => {
		const { db } = setup();
		await saveAiProvider(db, env, 'user-1', openai);

		await assert.rejects(
			saveAiProvider(db, env, 'user-1', {
				...openai,
				baseUrl: 'https://elsewhere.example/v1',
				apiKey: ''
			}),
			/API key is required/
		);
		const resolved = await resolveAiProvider(db, env, 'user-1');
		assert.match(resolved?.baseUrl ?? '', /sub2api\.example\.com/);
	});

	test('asks for a new key when switching provider', async () => {
		const { db } = setup();
		await saveAiProvider(db, env, 'user-1', openai);

		await assert.rejects(
			saveAiProvider(db, env, 'user-1', { kind: 'anthropic', apiKey: '' }),
			/API key is required/
		);
	});

	test('only an admin-owned instance provider may use Workers AI', async () => {
		const { db } = setup();
		const withAi: AiEnv = { ...env, AI: { run: async () => ({ response: 'ok' }) } };

		await assert.rejects(
			saveAiProvider(db, withAi, 'user-1', { kind: 'workers_ai' }),
			/supported provider/
		);
		const saved = await saveAiProvider(db, withAi, INSTANCE_OWNER, { kind: 'workers_ai' });
		assert.equal(saved.model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
		assert.equal(saved.key_hint, null);
	});

	test('refuses to store a key without ENCRYPTION_KEY', async () => {
		const { db } = setup();
		await assert.rejects(
			saveAiProvider(db, {}, 'user-1', openai),
			(error: unknown) => error instanceof AiProviderError && error.status === 503
		);
	});

	test('requires https and, for OpenAI-compatible servers, a base URL and model', async () => {
		const { db } = setup();
		await assert.rejects(
			saveAiProvider(db, env, 'user-1', { ...openai, baseUrl: 'http://sub2api.example.com/v1' }),
			/https/
		);
		await assert.rejects(saveAiProvider(db, env, 'user-1', { ...openai, baseUrl: '' }), /Base URL/);
		await assert.rejects(saveAiProvider(db, env, 'user-1', { ...openai, model: '' }), /Model/);
	});

	test('OpenRouter fixes the API host and only accepts free model IDs', async () => {
		const { db } = setup();
		const saved = await saveAiProvider(db, env, 'user-1', { kind: 'openrouter', apiKey: 'sk-or-key' });
		assert.equal(saved.base_url, OPENROUTER_BASE_URL);
		assert.equal(saved.model, 'openrouter/free');
		assert.equal(saved.auth_method, 'api_key');
		await saveAiProvider(db, env, 'user-1', { kind: 'openrouter', model: 'vendor/model:free' });
		await assert.rejects(saveAiProvider(db, env, 'user-1', {
			kind: 'openrouter', model: 'vendor/paid', apiKey: ''
		}), /only accepts/);
		await assert.rejects(saveAiProvider(db, env, 'user-1', {
			kind: 'openrouter', baseUrl: 'https://attacker.example/v1', apiKey: 'sk-or-key'
		}), /fixed API URL/);
		assert.equal((await resolveAiProvider(db, env, 'user-1'))?.apiKey, 'sk-or-key');
	});

	test('an OAuth connection keeps its authentication label when the free model changes', async () => {
		const { db, sqlite } = setup();
		sqlite.query("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ('oauth-session', 'user-1', 'oauth-hash', '2999-01-01')").run();
		sqlite.query("INSERT INTO ai_connection_generations (user_id, generation) VALUES ('user-1', 1)").run();
		const connection = { generation: 1, sessionId: 'oauth-session' };
		const connected = await saveOpenRouterOAuthProvider(db, env, 'user-1', 'sk-or-oauth', connection);
		assert.equal(connected.auth_method, 'oauth');
		const edited = await saveAiProvider(db, env, 'user-1', { kind: 'openrouter', model: 'vendor/model:free' });
		assert.equal(edited.auth_method, 'oauth');
		const replaced = await saveAiProvider(db, env, 'user-1', { kind: 'openrouter', apiKey: 'sk-or-manual' });
		assert.equal(replaced.auth_method, 'api_key');
		await assert.rejects(saveOpenRouterOAuthProvider(db, env, INSTANCE_OWNER, 'sk-or-key', connection), /individual/);
	});
});

describe('resolveAiProvider', () => {
	test('a personal key wins over the instance provider', async () => {
		const { db } = setup();
		await saveAiProvider(db, env, INSTANCE_OWNER, { kind: 'anthropic', apiKey: 'sk-ant-shared' });
		await saveAiProvider(db, env, 'user-1', openai);

		assert.equal((await resolveAiProvider(db, env, 'user-1'))?.source, 'user');
		const other = await resolveAiProvider(db, env, 'user-2');
		assert.deepEqual(other, {
			source: 'instance',
			kind: 'anthropic',
			baseUrl: null,
			model: 'claude-opus-5',
			apiKey: 'sk-ant-shared'
		});
	});

	test('is null when nothing is set up', async () => {
		const { db } = setup();
		assert.equal(await resolveAiProvider(db, env, 'user-1'), null);
		assert.equal(await getAiProvider(db, 'user-1'), null);
	});

	test('explains a key that no longer decrypts', async () => {
		const { db } = setup();
		await saveAiProvider(db, env, 'user-1', openai);

		await assert.rejects(
			resolveAiProvider(db, { ENCRYPTION_KEY: 'r'.repeat(40) }, 'user-1'),
			/ENCRYPTION_KEY may have changed/
		);
	});
});

describe('generateText', () => {
	const request = { system: 'Be brief.', prompt: 'Say hi.' };
	const gemini: ResolvedAiProvider = { source: 'user', kind: 'gemini', baseUrl: 'https://attacker.example', model: 'gemini-test-model', apiKey: 'gemini-test-secret' };

	test('Gemini uses the native fixed endpoint, header-only key and separate system instruction', async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const fetcher = (async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'Internal thought.' }, { text: ' Hello' }, { inlineData: { data: 'not-text' } }, { text: ' there. ' }] } }] });
		}) as unknown as typeof fetch;
		assert.equal(await generateText(env, gemini, { ...request, maxTokens: 1_024 }, fetcher), 'Hello there.');
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, `${GEMINI_BASE_URL}/models/gemini-test-model:generateContent`);
		assert.ok(!calls[0].url.includes('gemini-test-secret'));
		assert.equal(calls[0].init.redirect, 'manual');
		assert.equal(new Headers(calls[0].init.headers).get('x-goog-api-key'), gemini.apiKey);
		const body = JSON.parse(String(calls[0].init.body));
		assert.deepEqual(body.systemInstruction, { parts: [{ text: 'Be brief.' }] });
		assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'Say hi.' }] }]);
		assert.equal(body.generationConfig.maxOutputTokens, 1_024);
	});

	test('Gemini rejects tampered model paths and missing keys before sending anything', async () => {
		let sent = false;
		const fetcher = (async () => { sent = true; throw new Error('must not send'); }) as typeof fetch;
		await assert.rejects(generateText(env, { ...gemini, model: 'gemini-test?key=other' }, request, fetcher), /Gemini model ID/);
		await assert.rejects(generateText(env, { ...gemini, apiKey: null }, request, fetcher), /no API key/);
		assert.equal(sent, false);
	});

	test('Gemini quota, authorization, redirects and transport errors never reflect credentials or response data', async () => {
		for (const status of [307, 400, 401, 403, 404, 429, 500]) {
			const fetcher = (async () => Response.json({ error: { message: 'gemini-test-secret private@example.test' } }, { status, headers: { Location: 'https://attacker.example/gemini-test-secret' } })) as typeof fetch;
			await assert.rejects(generateText(env, gemini, request, fetcher), (error: unknown) =>
				error instanceof AiProviderError && !error.message.includes('gemini-test-secret') && !error.message.includes('private@example.test') &&
				!error.message.includes('attacker.example') && (status !== 429 || error.status === 429));
		}
		const fetcher = (async () => { throw new Error('gemini-test-secret'); }) as typeof fetch;
		await assert.rejects(generateText(env, gemini, request, fetcher), (error: unknown) => error instanceof AiProviderError && !error.message.includes('gemini-test-secret'));
	});

	test('Gemini safety blocks, truncation, invalid JSON and thought-only replies never become drafts', async () => {
		for (const body of [
			{ promptFeedback: { blockReason: 'SAFETY' } },
			{ candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: 'Do not return this.' }] } }] },
			{ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'Unfinished sentence' }] } }] },
			{ candidates: [{ content: { parts: [{ text: 'No completion status.' }] } }] },
			{ candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'Internal thought.' }] } }] },
			{ candidates: [{ finishReason: 'STOP', content: { parts: 'invalid' } }] }
		]) {
			const fetcher = (async () => Response.json(body)) as typeof fetch;
			await assert.rejects(generateText(env, gemini, request, fetcher), AiProviderError);
		}
		const fetcher = (async () => new Response('not-json')) as typeof fetch;
		await assert.rejects(generateText(env, gemini, request, fetcher), /incomplete response/);
	});

	test('OpenRouter never sends the OAuth key to a configured custom host or a paid model', async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const fetcher = (async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return Response.json({ choices: [{ message: { content: 'Free draft.' } }] });
		}) as unknown as typeof fetch;
		const provider: ResolvedAiProvider = {
			source: 'user', kind: 'openrouter', baseUrl: 'https://attacker.example',
			model: 'openrouter/free', apiKey: 'sk-or-secret'
		};
		assert.equal(await generateText(env, provider, request, fetcher), 'Free draft.');
		assert.equal(calls[0].url, `${OPENROUTER_BASE_URL}/chat/completions`);
		assert.equal(calls[0].init.redirect, 'manual');
		await assert.rejects(generateText(env, { ...provider, model: 'openai/paid' }, request, fetcher), /free models/);
		assert.equal(calls.length, 1);
	});

	test('OpenRouter errors never reflect provider error bodies or redirect URLs', async () => {
		const provider: ResolvedAiProvider = {
			source: 'user', kind: 'openrouter', baseUrl: OPENROUTER_BASE_URL,
			model: 'openrouter/free', apiKey: 'sk-or-secret'
		};
		const responses = [
			Response.json({ error: { message: 'sk-or-secret' } }, { status: 401 }),
			new Response(null, { status: 307, headers: { Location: 'https://attacker.example/sk-or-secret' } })
		];
		for (const response of responses) {
			const fetcher = (async () => response) as typeof fetch;
			await assert.rejects(generateText(env, provider, request, fetcher), (error: unknown) =>
				error instanceof AiProviderError && !error.message.includes('sk-or-secret'));
		}
		const fetcher = (async () => { throw new Error('sk-or-secret'); }) as typeof fetch;
		await assert.rejects(generateText(env, provider, request, fetcher), (error: unknown) =>
			error instanceof AiProviderError && !error.message.includes('sk-or-secret'));
	});

	test('calls an OpenAI-compatible server with the key and model', async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const fetcher = (async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return Response.json({ choices: [{ message: { content: ' Hi there. ' } }] });
		}) as unknown as typeof fetch;
		const provider: ResolvedAiProvider = {
			source: 'user',
			kind: 'openai',
			baseUrl: 'https://sub2api.example.com/v1',
			model: 'gpt-5-mini',
			apiKey: 'sk-secret'
		};

		assert.equal(await generateText(env, provider, request, fetcher), 'Hi there.');
		assert.equal(calls[0].url, 'https://sub2api.example.com/v1/chat/completions');
		assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer sk-secret');
		const body = JSON.parse(String(calls[0].init.body));
		assert.equal(body.model, 'gpt-5-mini');
		assert.deepEqual(body.messages[0], { role: 'system', content: 'Be brief.' });
	});

	test('surfaces the error an OpenAI-compatible server returns', async () => {
		const fetcher = (async () =>
			Response.json({ error: { message: 'model not found' } }, { status: 404 })) as unknown as typeof fetch;
		const provider: ResolvedAiProvider = {
			source: 'user',
			kind: 'openai',
			baseUrl: 'https://sub2api.example.com/v1',
			model: 'nope',
			apiKey: 'sk'
		};

		await assert.rejects(generateText(env, provider, request, fetcher), /404: model not found/);
	});

	test('refuses to follow a redirect with the key attached', async () => {
		const calls: RequestInit[] = [];
		const fetcher = (async (_url: string, init: RequestInit) => {
			calls.push(init);
			return new Response(null, {
				status: 307,
				headers: { location: 'https://elsewhere.example/v1/chat/completions' }
			});
		}) as unknown as typeof fetch;
		const provider: ResolvedAiProvider = {
			source: 'user',
			kind: 'openai',
			baseUrl: 'https://gateway.example.com/v1',
			model: 'gpt-5-mini',
			apiKey: 'sk-secret'
		};

		await assert.rejects(
			generateText(env, provider, request, fetcher),
			/redirected to https:\/\/elsewhere\.example/
		);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].redirect, 'manual');
	});

	test('calls the Anthropic Messages API', async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const fetcher = (async (url: string, init: RequestInit) => {
			calls.push({ url: String(url), init });
			return Response.json({
				id: 'msg_1',
				type: 'message',
				role: 'assistant',
				model: 'claude-opus-5',
				content: [{ type: 'text', text: 'Hello!' }],
				stop_reason: 'end_turn',
				stop_sequence: null,
				usage: { input_tokens: 5, output_tokens: 2 }
			});
		}) as unknown as typeof fetch;
		const provider: ResolvedAiProvider = {
			source: 'instance',
			kind: 'anthropic',
			baseUrl: null,
			model: 'claude-opus-5',
			apiKey: 'sk-ant'
		};

		assert.equal(await generateText(env, provider, request, fetcher), 'Hello!');
		assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
		const body = JSON.parse(String(calls[0].init.body));
		assert.equal(body.system, 'Be brief.');
		assert.equal(body.model, 'claude-opus-5');
	});

	test('does not let the Anthropic client follow a redirect with the key', async () => {
		const calls: RequestInit[] = [];
		const fetcher = (async (_url: string, init: RequestInit) => {
			calls.push(init);
			return new Response(null, {
				status: 307,
				headers: { location: 'https://elsewhere.example/v1/messages' }
			});
		}) as unknown as typeof fetch;
		const provider: ResolvedAiProvider = {
			source: 'user',
			kind: 'anthropic',
			baseUrl: 'https://proxy.example.com',
			model: 'claude-opus-5',
			apiKey: 'sk-ant'
		};

		await assert.rejects(generateText(env, provider, request, fetcher), /307/);
		assert.ok(calls.length > 0);
		assert.ok(calls.every((init) => init.redirect === 'manual'));
	});

	test('reports a refusal instead of an empty draft', async () => {
		const fetcher = (async () =>
			Response.json({
				id: 'msg_1',
				type: 'message',
				role: 'assistant',
				model: 'claude-opus-5',
				content: [],
				stop_reason: 'refusal',
				stop_sequence: null,
				usage: { input_tokens: 5, output_tokens: 0 }
			})) as unknown as typeof fetch;
		const provider: ResolvedAiProvider = {
			source: 'user',
			kind: 'anthropic',
			baseUrl: null,
			model: 'claude-opus-5',
			apiKey: 'sk-ant'
		};

		await assert.rejects(generateText(env, provider, request, fetcher), /declined/);
	});

	test('runs Workers AI through the binding', async () => {
		const runs: { model: string; inputs: Record<string, unknown> }[] = [];
		const withAi: AiEnv = {
			AI: {
				async run(model, inputs) {
					runs.push({ model, inputs });
					return { response: 'From the edge.' };
				}
			}
		};
		const provider: ResolvedAiProvider = {
			source: 'instance',
			kind: 'workers_ai',
			baseUrl: null,
			model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
			apiKey: null
		};

		assert.equal(await generateText(withAi, provider, request), 'From the edge.');
		assert.equal(runs[0].model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
		assert.ok(Number(runs[0].inputs.max_tokens) > 256);
	});
});

describe('chatCompletionsUrl', () => {
	test('accepts the API root or the full endpoint', () => {
		assert.equal(chatCompletionsUrl('https://x.test/v1'), 'https://x.test/v1/chat/completions');
		assert.equal(chatCompletionsUrl('https://x.test/v1/chat/completions/'), 'https://x.test/v1/chat/completions');
	});
});

test('Gemini migration preserves ciphertext, OAuth authentication and ownership constraints', () => {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON');
	const directory = new URL('../../../migrations/', import.meta.url);
	for (const migration of readdirSync(directory).filter((name) => name.endsWith('.sql') && name < '0035_gemini_provider.sql').sort()) {
		sqlite.exec(readFileSync(new URL(migration, directory), 'utf8'));
	}
	for (const id of ['legacy', 'new-user']) sqlite.query('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run(id, `${id}@example.test`, id, 'synthetic');
	sqlite.query(`INSERT INTO ai_providers (owner, user_id, kind, model, api_key, key_hint, updated_at, auth_method)
		VALUES ('legacy', 'legacy', 'openrouter', 'openrouter/free', 'v1.unchanged.ciphertext', 'kept', '2026-10-01', 'oauth')`).run();
	sqlite.query("INSERT INTO ai_providers (owner, kind, model, auth_method) VALUES ('instance', 'workers_ai', 'kept-model', 'binding')").run();
	const before = sqlite.query('SELECT * FROM ai_providers ORDER BY owner').all();
	sqlite.exec('BEGIN');
	sqlite.exec(readFileSync(new URL('0035_gemini_provider.sql', directory), 'utf8'));
	sqlite.exec('COMMIT');
	assert.deepEqual(sqlite.query('SELECT * FROM ai_providers ORDER BY owner').all(), before);
	sqlite.query("INSERT INTO ai_providers (owner, user_id, kind, model) VALUES ('new-user', 'new-user', 'gemini', 'gemini-test-model')").run();
	assert.throws(() => sqlite.query("UPDATE ai_providers SET auth_method = 'oauth' WHERE owner = 'new-user'").run());
	assert.throws(() => sqlite.query("UPDATE ai_providers SET auth_method = 'binding' WHERE owner = 'new-user'").run());
	assert.throws(() => sqlite.query("INSERT INTO ai_providers (owner, user_id, kind, model) VALUES ('mismatch', 'new-user', 'gemini', 'gemini-test-model')").run());
	sqlite.query("DELETE FROM users WHERE id = 'new-user'").run();
	assert.equal(sqlite.query("SELECT * FROM ai_providers WHERE owner = 'new-user'").get(), null);
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Cookies, RequestHandler } from '@sveltejs/kit';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
	beginSocialFlow, configuredSocialProviders, consumeSocialFlow, exchangeSocialIdentity,
	linkSocialIdentity, requireSocialOrigin, socialAppOrigin, socialCookieName,
	socialIdentitySummaries, SocialAuthError, unlinkSocialIdentity, userForSocialIdentity,
	validateSocialInitiator, verifyGoogleIdentity, type SocialAuthEnvironment, type SocialTransaction
} from './social-auth';
import { hashToken } from './crypto';
import { createTestDb, insertTestUser } from './test-db';
import { POST as start } from '../../routes/api/auth/social/[provider]/start/+server';
import { GET as settings, DELETE as disconnect } from '../../routes/api/settings/social/+server';
import { GET as callback } from '../../routes/api/auth/social/[provider]/callback/+server';
import { SESSION_COOKIE } from './constants';

const ENV: SocialAuthEnvironment = {
	APP_URL: 'https://mail.example.com',
	OAUTH_GOOGLE_CLIENT_ID: 'google-client', OAUTH_GOOGLE_CLIENT_SECRET: 'test-google-secret',
	OAUTH_GITHUB_CLIENT_ID: 'github-client', OAUTH_GITHUB_CLIENT_SECRET: 'test-github-secret'
};
const URL_BASE = new URL(ENV.APP_URL!);

function cookieJar() {
	const values = new Map<string, string>();
	const options = new Map<string, unknown>();
	return {
		values, options,
		get: (name: string) => values.get(name),
		set: (name: string, value: string, opts: unknown) => { values.set(name, value); options.set(name, opts); },
		delete: (name: string) => { values.delete(name); }
	} as unknown as Pick<Cookies, 'get' | 'set' | 'delete'> & {values: Map<string,string>; options: Map<string,unknown>};
}

type Event = Parameters<RequestHandler>[0];
function requestEvent(db: ReturnType<typeof createTestDb>['db'], body: unknown, options: {
	user?: { id: string; must_change_password: boolean };
	authMethod?: 'session' | 'api_token' | 'mobile_session'; origin?: string; method?: string;
	provider?: string; cookies?: ReturnType<typeof cookieJar>;
} = {}): Event {
	const url = new URL('/api/auth/social/google/start', URL_BASE);
	return {
		url,
		request: new Request(url, { method: options.method ?? 'POST',
			headers: { 'content-type': 'application/json', origin: options.origin ?? URL_BASE.origin },
			body: JSON.stringify(body) }),
		params: { provider: options.provider ?? 'google' },
		platform: { env: { DB: db, ...ENV } },
		cookies: options.cookies ?? cookieJar(), getClientAddress: () => '198.51.100.20',
		locals: { user: options.user ?? null, authMethod: options.authMethod ?? (options.user ? 'session' : null),
			currentSessionId: options.user ? 'session-owner' : null }
	} as unknown as Event;
}

function owner(db: ReturnType<typeof createTestDb>) {
	insertTestUser(db.sqlite, 'owner');
	db.sqlite.query("INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES ('session-owner','owner','test-hash','2099-01-01T00:00:00Z')").run();
	return { id: 'owner', must_change_password: false };
}

describe('social provider configuration and fixed origins', () => {
	test('only advertises fully configured providers and rejects placeholders', () => {
		assert.deepEqual(configuredSocialProviders(ENV), ['google', 'github']);
		assert.deepEqual(configuredSocialProviders({ ...ENV, OAUTH_GOOGLE_CLIENT_SECRET: '', OAUTH_GITHUB_CLIENT_ID: 'REPLACE_WITH_ID' }), []);
		assert.deepEqual(configuredSocialProviders({ ...ENV, APP_URL: undefined }), []);
	});
	test('requires an HTTPS application origin and rejects external request origins', () => {
		for (const APP_URL of ['http://mail.example.com', 'https://mail.example.com/path', 'https://user:pass@mail.example.com', 'https://mail.example.com/?next=x']) {
			assert.throws(() => socialAppOrigin({ ...ENV, APP_URL }), SocialAuthError);
		}
		assert.throws(() => requireSocialOrigin(ENV, URL_BASE, new Request(URL_BASE)), SocialAuthError);
		assert.throws(() => requireSocialOrigin(ENV, new URL('https://evil.example')), SocialAuthError);
		assert.equal(requireSocialOrigin(ENV, URL_BASE, new Request(URL_BASE, {headers: {origin: URL_BASE.origin}})), URL_BASE.origin);
	});
});

describe('browser-bound single-use OAuth transactions', () => {
	test('uses S256, nonce, minimal scopes and an HttpOnly secure cookie', async () => {
		const { db, sqlite } = createTestDb();
		const cookies = cookieJar();
		const auth = new URL(await beginSocialFlow(db, ENV, 'google', cookies, URL_BASE,
			{ intent: 'login', userId: null, sessionId: null, next: 'https://evil.example' }));
		assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
		assert.equal(auth.searchParams.get('scope'), 'openid email');
		assert.ok(auth.searchParams.get('nonce'));
		assert.equal(auth.searchParams.get('redirect_uri'), `${URL_BASE.origin}/api/auth/social/google/callback`);
		assert.deepEqual(cookies.options.get(socialCookieName('google', URL_BASE)),
			{path:'/',httpOnly:true,secure:true,sameSite:'lax',maxAge:600});
		const row = sqlite.query('SELECT * FROM social_login_transactions').all()[0];
		assert.equal(row.next_path, null);
		assert.notEqual(row.state_hash, auth.searchParams.get('state'));
		assert.notEqual(row.nonce_hash, auth.searchParams.get('nonce'));
		assert.equal('access_token' in row, false);
		assert.equal('verifier' in row, false);
		const github = new URL(await beginSocialFlow(db, ENV, 'github', cookies, URL_BASE,
			{intent:'login',userId:null,sessionId:null}));
		assert.equal(github.searchParams.get('scope'), '');
		assert.equal(github.searchParams.get('allow_signup'), 'false');
		assert.equal(github.searchParams.get('code_challenge_method'), 'S256');
	});
	test('another browser cannot consume the flow and a valid callback cannot replay', async () => {
		const { db } = createTestDb();
		const cookies = cookieJar();
		const auth = new URL(await beginSocialFlow(db, ENV, 'google', cookies, URL_BASE,
			{intent:'login',userId:null,sessionId:null,next:'/oauth/authorize?client_id=x'}));
		await assert.rejects(consumeSocialFlow(db, 'google', cookieJar(), URL_BASE, auth.searchParams.get('state')), SocialAuthError);
		const raw = cookies.get(socialCookieName('google', URL_BASE))!;
		const result = await consumeSocialFlow(db, 'google', cookies, URL_BASE, auth.searchParams.get('state'));
		assert.equal(result.transaction.next_path, '/oauth/authorize?client_id=x');
		cookies.set(socialCookieName('google', URL_BASE), raw, { path: '/' });
		await assert.rejects(consumeSocialFlow(db, 'google', cookies, URL_BASE, auth.searchParams.get('state')), SocialAuthError);
	});
	test('a forged binding or verifier cannot claim a known state', async () => {
		for (const field of ['binding','verifier']) {
			const { db } = createTestDb();
			const cookies = cookieJar();
			const auth = new URL(await beginSocialFlow(db, ENV, 'google', cookies, URL_BASE, {intent:'login',userId:null,sessionId:null}));
			const raw = cookies.get(socialCookieName('google', URL_BASE))!;
			const data = JSON.parse(raw); data[field] = 'x'.repeat(43);
			cookies.set(socialCookieName('google', URL_BASE), JSON.stringify(data), { path: '/' });
			await assert.rejects(consumeSocialFlow(db,'google',cookies,URL_BASE,auth.searchParams.get('state')), SocialAuthError);
			cookies.set(socialCookieName('google', URL_BASE), raw, { path: '/' });
			assert.ok(await consumeSocialFlow(db,'google',cookies,URL_BASE,auth.searchParams.get('state')));
		}
	});
	test('expired flows fail and changed mailbox sessions cannot link', async () => {
		const testDb = createTestDb(); owner(testDb);
		const cookies = cookieJar();
		const auth = new URL(await beginSocialFlow(testDb.db,ENV,'google',cookies,URL_BASE,
			{intent:'link',userId:'owner',sessionId:'session-owner'}));
		testDb.sqlite.query("UPDATE social_login_transactions SET expires_at = '2000-01-01T00:00:00Z'").run();
		await assert.rejects(consumeSocialFlow(testDb.db,'google',cookies,URL_BASE,auth.searchParams.get('state')), SocialAuthError);
		const transaction = {intent:'link',initiator_user_id:'owner',initiator_session_id:'session-owner'} as SocialTransaction;
		assert.throws(() => validateSocialInitiator(transaction,'owner','other-session'), SocialAuthError);
		assert.throws(() => validateSocialInitiator(transaction,null,null), SocialAuthError);
		assert.doesNotThrow(() => validateSocialInitiator(transaction,'owner','session-owner'));
	});
});

describe('explicit identity ownership', () => {
	test('unknown identity cannot create or claim an account, including a matching email', async () => {
		const testDb = createTestDb(); owner(testDb);
		await assert.rejects(userForSocialIdentity(testDb.db,'google','123456'), SocialAuthError);
		assert.equal(testDb.sqlite.query('SELECT id FROM users').all().length, 1);
		assert.equal(testDb.sqlite.query('SELECT * FROM social_identities').all().length, 0);
	});
	test('subject is unique across users and a provider cannot be silently replaced', async () => {
		const testDb = createTestDb(); owner(testDb); insertTestUser(testDb.sqlite,'other');
		await linkSocialIdentity(testDb.db,'owner','google',{subject:'123456',displayName:'owner@example.com'});
		await assert.rejects(linkSocialIdentity(testDb.db,'other','google',{subject:'123456',displayName:'same@example.com'}), SocialAuthError);
		await assert.rejects(linkSocialIdentity(testDb.db,'owner','google',{subject:'999999',displayName:'replacement@example.com'}), SocialAuthError);
		assert.equal((await userForSocialIdentity(testDb.db,'google','123456')).id,'owner');
		assert.equal(testDb.sqlite.query('SELECT * FROM social_identities').all().length, 1);
	});
	test('unfinished setup blocks linking and sign-in, unlink preserves mailbox password', async () => {
		const testDb=createTestDb(); owner(testDb);
		await linkSocialIdentity(testDb.db,'owner','github',{subject:'2468',displayName:'original-login'});
		testDb.sqlite.query('UPDATE users SET must_change_password = 1 WHERE id = ?').run('owner');
		await assert.rejects(userForSocialIdentity(testDb.db,'github','2468'),SocialAuthError);
		await assert.rejects(linkSocialIdentity(testDb.db,'owner','google',{subject:'1234',displayName:'mail'}),SocialAuthError);
		testDb.sqlite.query('UPDATE users SET must_change_password = 0 WHERE id = ?').run('owner');
		await unlinkSocialIdentity(testDb.db,'owner','github');
		assert.equal(testDb.sqlite.query("SELECT password_hash FROM users WHERE id='owner'").all()[0].password_hash,'x');
		assert.equal((await socialIdentitySummaries(testDb.db,ENV,'owner')).some(item=>item.connected),false);
	});
});

describe('Google signed ID tokens', () => {
	async function signer() {
		const { privateKey, publicKey } = await generateKeyPair('RS256');
		const jwk = await exportJWK(publicKey); jwk.kid = 'test'; jwk.alg = 'RS256';
		const keys = createLocalJWKSet({keys:[jwk]});
		const sign = (claims: Record<string,unknown> = {}) => new SignJWT({sub:'123456789',nonce:'test-nonce',email:'owner@example.com',email_verified:true,...claims})
			.setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer('https://accounts.google.com')
			.setAudience('google-client').setIssuedAt().setExpirationTime('5m').sign(privateKey);
		return {keys,sign,privateKey};
	}
	test('accepts signed provider identity and rejects nonce, audience, issuer, azp, expiry and signature changes', async () => {
		const {keys,sign,privateKey}=await signer();
		const nonce=await hashToken('test-nonce');
		assert.deepEqual(await verifyGoogleIdentity(await sign(),'google-client',nonce,keys),{subject:'123456789',displayName:'owner@example.com'});
		await assert.rejects(verifyGoogleIdentity(await sign(),'wrong-client',nonce,keys),SocialAuthError);
		for (const claims of [{nonce:'wrong-nonce'},{azp:'wrong-client'},{sub:''}]) {
			await assert.rejects(verifyGoogleIdentity(await sign(claims),'google-client',nonce,keys),SocialAuthError);
		}
		for (const [issuer,expiry] of [['https://evil.example','5m'],['https://accounts.google.com','-5m']]) {
			const invalid=await new SignJWT({sub:'123',nonce:'test-nonce'}).setProtectedHeader({alg:'RS256',kid:'test'})
				.setIssuer(issuer).setAudience('google-client').setIssuedAt().setExpirationTime(expiry).sign(privateKey);
			await assert.rejects(verifyGoogleIdentity(invalid,'google-client',nonce,keys),SocialAuthError);
		}
		const other=await signer();
		await assert.rejects(verifyGoogleIdentity(await other.sign(),'google-client',nonce,keys),SocialAuthError);
	});
});

describe('GitHub exchange uses stable identity without retaining provider credentials', () => {
	test('sends PKCE verifier and fixed callback, discards token after querying /user', async () => {
		const calls: Array<{url:string;init?:RequestInit}>=[];
		const fake=async (input: string | URL | Request,init?: RequestInit) => {
			calls.push({url:String(input),init});
			return new Response(JSON.stringify(calls.length === 1 ? {access_token:'test-transient-token'} : {id:98765,login:'renamable-login',email:'owner@example.com'}));
		};
		const identity=await exchangeSocialIdentity(ENV,'github','test-code','test-verifier','',fake as typeof fetch);
		assert.deepEqual(identity,{subject:'98765',displayName:'renamable-login'});
		assert.equal((calls[0].init?.body as URLSearchParams).get('code_verifier'),'test-verifier');
		assert.equal((calls[0].init?.body as URLSearchParams).get('redirect_uri'),`${URL_BASE.origin}/api/auth/social/github/callback`);
		assert.equal(calls[1].url,'https://api.github.com/user');
		assert.equal(new Headers(calls[1].init?.headers).get('authorization'),'Bearer test-transient-token');
		assert.equal('access_token' in identity,false);
	});
	test('rejects malformed identity and provider errors without exposing token contents', async () => {
		for (const id of ['98765',0,-1,Number.MAX_SAFE_INTEGER+1]) {
			let count=0;
			const fake=async()=>new Response(JSON.stringify(++count===1?{access_token:'test-token'}:{id,login:'name'}));
			await assert.rejects(exchangeSocialIdentity(ENV,'github','code','verifier','',fake as typeof fetch),SocialAuthError);
		}
		const fake=async()=>new Response('sensitive-provider-error',{status:400});
		await assert.rejects(exchangeSocialIdentity(ENV,'github','code','verifier','',fake as typeof fetch),
			(error:unknown)=>error instanceof SocialAuthError && !error.message.includes('sensitive-provider-error'));
	});
	test('provider diagnostics only log fixed endpoint, HTTP status and allowlisted reasons', async () => {
		const original=console.warn; const logs: unknown[][]=[];
		console.warn=(...values: unknown[])=>{logs.push(values);};
		try {
			for(const providerError of ['invalid_client','invalid_grant','invalid_request','sensitive-provider-error']) {
				const fake=async()=>Response.json({error:providerError,error_description:'sensitive-provider-description'},{status:400});
				await assert.rejects(exchangeSocialIdentity(ENV,'google','test-code','verifier','',fake as typeof fetch),SocialAuthError);
			}
			assert.deepEqual(logs.map(row=>row[1]),['invalid_client','invalid_grant','invalid_request','other'].map(reason=>({endpoint:'google_token',status:400,reason})));
			assert.equal(JSON.stringify(logs).includes('sensitive-provider'),false);
		} finally {console.warn=original;}
	});
	test('bounds streamed success and error bodies before parsing, even with a forged short Content-Length', async () => {
		const original=console.warn; const logs: unknown[][]=[];
		console.warn=(...values: unknown[])=>{logs.push(values);};
		try {
			for(const status of [200,400]) {
				let cancelled=false;
				const stream=new ReadableStream<Uint8Array>({
					start(controller){
						for(let i=0;i<3;i++) controller.enqueue(new Uint8Array(32_768));
					},
					cancel(){cancelled=true;}
				});
				const fake=async()=>new Response(stream,{status,headers:{'content-length':'1'}});
				await assert.rejects(exchangeSocialIdentity(ENV,'google','test-code','verifier','',fake as typeof fetch),SocialAuthError);
				assert.equal(cancelled,true);
			}
			assert.deepEqual(logs,[['social-provider-response',{endpoint:'google_token',status:400,reason:'other'}]]);
		} finally {console.warn=original;}
	});
});

describe('social endpoints enforce their own browser session and origin guards', () => {
	test('anonymous login can start but anonymous linking and cross-origin login cannot', async () => {
		const {db}=createTestDb();
		assert.equal((await start(requestEvent(db,{intent:'login'}))).status,200);
		assert.equal((await start(requestEvent(db,{intent:'link'}))).status,401);
		assert.equal((await start(requestEvent(db,{intent:'login'},{origin:'https://evil.example'}))).status,403);
		assert.equal((await start(requestEvent(db,{intent:'login'},{provider:'unknown'}))).status,404);
	});
	test('only an established browser session can connect or manage identities', async () => {
		const testDb=createTestDb(); const user=owner(testDb);
		assert.equal((await start(requestEvent(testDb.db,{intent:'link'},{user}))).status,200);
		assert.equal((await start(requestEvent(testDb.db,{intent:'link'},{user,authMethod:'api_token'}))).status,403);
		assert.equal((await start(requestEvent(testDb.db,{intent:'link'},{user:{...user,must_change_password:true}}))).status,403);
		assert.equal((await settings(requestEvent(testDb.db,{}))).status,401);
		assert.equal((await settings(requestEvent(testDb.db,{},{user,authMethod:'api_token'}))).status,401);
		assert.equal((await settings(requestEvent(testDb.db,{},{user}))).status,200);
		assert.equal((await disconnect(requestEvent(testDb.db,{provider:'google'},{user,method:'DELETE',origin:'https://evil.example'}))).status,403);
	});
	test('start is rate-limited across changing providers', async () => {
		const {db}=createTestDb();
		for(let attempt=0;attempt<21;attempt++) {
			const response=await start(requestEvent(db,{intent:'login'},{provider:attempt%2?'google':'github'}));
			assert.equal(response.status,attempt<20?200:429);
		}
	});
});

describe('complete GitHub callbacks using simulated provider responses', () => {
	function callbackEvent(db: ReturnType<typeof createTestDb>['db'], authUrl: URL, cookies: ReturnType<typeof cookieJar>,
		user?: {id: string;must_change_password:boolean}, extra: Record<string,string> = {}): Event {
		const event = requestEvent(db, {}, {provider:'github',cookies,user});
		const url = new URL('/api/auth/social/github/callback',URL_BASE);
		url.searchParams.set('state',authUrl.searchParams.get('state')!);
		url.searchParams.set('code','test-authorization-code');
		for(const [key,value] of Object.entries(extra)) url.searchParams.set(key,value);
		return {...event,url,request:new Request(url)} as Event;
	}

	async function withGithubProfile(run:()=>Promise<void>, profile={id:98765,login:'example-developer',email:'owner@example.com'}) {
		const original=globalThis.fetch;
		globalThis.fetch=(async(input:string|URL|Request)=>new Response(JSON.stringify(
			String(input)==='https://api.github.com/user'?profile:{access_token:'test-callback-transient-token'}))) as typeof fetch;
		try {await run();} finally {globalThis.fetch=original;}
	}

	test('signed-in linking preserves the mailbox and then permits an OAuth login by stable numeric ID',async()=>{
		await withGithubProfile(async()=>{
			const testDb=createTestDb();const user=owner(testDb);const cookies=cookieJar();
			const authUrl=new URL(await beginSocialFlow(testDb.db,ENV,'github',cookies,URL_BASE,
				{intent:'link',userId:'owner',sessionId:'session-owner'}));
			const response=await callback(callbackEvent(testDb.db,authUrl,cookies,user));
			assert.equal(response.status,303);
			assert.equal(response.headers.get('location'),'/settings/connections?social=connected');
			assert.equal(response.headers.get('referrer-policy'),'no-referrer');
			const row=testDb.sqlite.query('SELECT * FROM social_identities').all()[0];
			assert.equal(row.subject,'98765'); assert.equal(row.user_id,'owner');
			assert.equal(testDb.sqlite.query('SELECT * FROM users').all().length,1);
			assert.equal(testDb.sqlite.query('SELECT * FROM sessions').all().length,1,'link must not mint a login session');
			const loginCookies=cookieJar();
			const loginUrl=new URL(await beginSocialFlow(testDb.db,ENV,'github',loginCookies,URL_BASE,
				{intent:'login',userId:null,sessionId:null,next:'/oauth/authorize?client_id=existing'}));
			const signedIn=await callback(callbackEvent(testDb.db,loginUrl,loginCookies));
			assert.equal(signedIn.headers.get('location'),'/oauth/authorize?client_id=existing');
			assert.ok(loginCookies.get(SESSION_COOKIE));
			assert.equal(testDb.sqlite.query('SELECT * FROM sessions').all().length,2);
			assert.equal(testDb.sqlite.query('SELECT * FROM social_login_transactions').all().length,0);
			assert.equal(JSON.stringify(row).includes('test-callback-transient-token'),false);
		});
	});

	test('an unbound OAuth identity with the same email cannot claim the private mailbox',async()=>{
		await withGithubProfile(async()=>{
			const testDb=createTestDb();owner(testDb);const cookies=cookieJar();
			const authUrl=new URL(await beginSocialFlow(testDb.db,ENV,'github',cookies,URL_BASE,{intent:'login',userId:null,sessionId:null}));
			const response=await callback(callbackEvent(testDb.db,authUrl,cookies));
			assert.equal(response.headers.get('location'),'/login?social=error');
			assert.equal(cookies.get(SESSION_COOKIE),undefined);
			assert.equal(testDb.sqlite.query('SELECT * FROM users').all().length,1);
			assert.equal(testDb.sqlite.query('SELECT * FROM sessions').all().length,1);
			assert.equal(testDb.sqlite.query('SELECT * FROM social_identities').all().length,0);
		});
	});

	test('cancellation and a changed local session consume the flow without any external request',async()=>{
		const original=globalThis.fetch;let calls=0;
		globalThis.fetch=(async()=>{calls++;throw new Error('Must not reach provider');}) as typeof fetch;
		try {
			for(const cancel of [true,false]) {
				const testDb=createTestDb();const user=owner(testDb);const cookies=cookieJar();
				const authUrl=new URL(await beginSocialFlow(testDb.db,ENV,'github',cookies,URL_BASE,
					{intent:'link',userId:'owner',sessionId:'session-owner'}));
				const event=callbackEvent(testDb.db,authUrl,cookies,cancel?user:undefined,cancel?{error:'access_denied'}:{});
				const response=await callback(event);
				assert.equal(response.headers.get('location'),'/settings/connections?social=error');
				assert.equal(testDb.sqlite.query('SELECT * FROM social_login_transactions').all().length,0);
				assert.equal(testDb.sqlite.query('SELECT * FROM social_identities').all().length,0);
			}
			assert.equal(calls,0);
		}finally{globalThis.fetch=original;}
	});

	test('concurrent callbacks cannot mint two sessions from one flow',async()=>{
		await withGithubProfile(async()=>{
			const testDb=createTestDb();owner(testDb);
			await linkSocialIdentity(testDb.db,'owner','github',{subject:'98765',displayName:'original-name'});
			const first=cookieJar();
			const authUrl=new URL(await beginSocialFlow(testDb.db,ENV,'github',first,URL_BASE,{intent:'login',userId:null,sessionId:null}));
			const second=cookieJar();
			second.set(socialCookieName('github',URL_BASE),first.get(socialCookieName('github',URL_BASE))!,{ path: '/' });
			const results=await Promise.all([callback(callbackEvent(testDb.db,authUrl,first)),callback(callbackEvent(testDb.db,authUrl,second))]);
			assert.deepEqual(results.map(r=>r.headers.get('location')).sort(),['/inbox','/login?social=error']);
			assert.equal(testDb.sqlite.query('SELECT * FROM sessions').all().length,2);
			assert.equal((await userForSocialIdentity(testDb.db,'github','98765')).id,'owner','a changed GitHub username does not change mailbox identity');
		});
	});

	test('revoking the initiating mailbox session during provider exchange blocks link and account login',async()=>{
		for(const intent of ['link','login'] as const) {
			const testDb=createTestDb();const user=owner(testDb);const cookies=cookieJar();
			if(intent==='login') await linkSocialIdentity(testDb.db,'owner','github',{subject:'98765',displayName:'already-bound'});
			const authUrl=new URL(await beginSocialFlow(testDb.db,ENV,'github',cookies,URL_BASE,
				{intent,userId:'owner',sessionId:'session-owner',add:intent==='login'}));
			const original=globalThis.fetch;
			globalThis.fetch=(async(input:string|URL|Request)=>{
				testDb.sqlite.query("DELETE FROM sessions WHERE id='session-owner'").run();
				return new Response(JSON.stringify(String(input)==='https://api.github.com/user'
					?{id:98765,login:'new-login'}:{access_token:'transient-test-token'}));
			}) as typeof fetch;
			try {
				const response=await callback(callbackEvent(testDb.db,authUrl,cookies,user));
				assert.equal(response.headers.get('location'),intent==='link'?'/settings/connections?social=error':'/login?social=error');
				assert.equal(cookies.get(SESSION_COOKIE),undefined);
				assert.equal(testDb.sqlite.query('SELECT * FROM sessions').all().length,0);
				if(intent==='link') assert.equal(testDb.sqlite.query('SELECT * FROM social_identities').all().length,0);
			}finally{globalThis.fetch=original;}
		}
	});
});

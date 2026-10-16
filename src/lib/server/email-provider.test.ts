import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { MailAddress } from '$lib/types';
import type { EmailProvider } from './email-provider';
import { parseMailDomains, ProviderError } from './email-provider';
import { getEmailProvider } from './context';
import { createHybridProvider } from './providers/hybrid-provider';
import { createTestDb, insertTestUser } from './test-db';
import { createAddress, getAddressForUser, syncDomains, upsertDomain } from './domains';
import {
	createCloudflareProvider,
	type CloudflareSendPayload
} from './providers/cloudflare-provider';
import { createResendProvider } from './providers/resend-provider';
import { sendOutboundEmail, type OutboundMailInput } from './send-mail';

describe('parseMailDomains', () => {
	test('splits comma-separated domains and lowercases them', () => {
		assert.deepEqual(parseMailDomains('Mail.Yours.com, YourDomain.com'), [
			'mail.yours.com',
			'yourdomain.com'
		]);
	});

	test('ignores the dashboard placeholder so Resend deploys can leave example.com', () => {
		assert.deepEqual(parseMailDomains('example.com'), []);
		assert.deepEqual(parseMailDomains('example.com, mail.example.com'), ['mail.example.com']);
	});

	test('returns an empty list for blank values', () => {
		assert.deepEqual(parseMailDomains(''), []);
		assert.deepEqual(parseMailDomains('   '), []);
		assert.deepEqual(parseMailDomains(null), []);
	});
});

test('a forwarded send uses its selected identity and has no reply-chain headers', async () => {
	let sent: OutboundMailInput | undefined;
	const provider: EmailProvider = {
		kind: 'resend',
		async send(input) {
			sent = input;
			return { providerId: 'provider-id' };
		},
		async listDomains() {
			return [];
		},
		async getDomain() {
			throw new Error('unused');
		}
	};
	const from: MailAddress = {
		id: 'address-1',
		user_id: 'user-1',
		domain_id: 'domain-1',
		domain_name: 'example.com',
		address: 'me@example.com',
		label: 'Me',
		is_default: true,
		signature: null,
		created_at: '2026-01-01'
	};

	await sendOutboundEmail(provider, {
		from,
		senderName: 'Me',
		to: 'recipient@example.com',
		subject: 'Fwd: Original',
		text: 'Forwarded message'
	});

	assert.equal(sent?.from.address, 'me@example.com');
	assert.equal(sent?.inReplyTo, undefined);
	assert.equal(sent?.references, undefined);
	assert.equal(sent?.headers, undefined);
});

const providerTestFrom: MailAddress = {
	id: 'address-1',
	user_id: 'user-1',
	domain_id: 'domain-1',
	domain_name: 'example.com',
	address: 'me@example.com',
	label: 'Me',
	is_default: true,
	signature: null,
	created_at: '2026-01-01'
};

const inlineSvg = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="4" cy="4" r="4"/></svg>';
const inlineSvgBase64 = Buffer.from(inlineSvg).toString('base64');
const ordinaryFile = 'plain attachment';
const ordinaryFileBase64 = Buffer.from(ordinaryFile).toString('base64');

function providerAttachmentInput(): OutboundMailInput {
	// Keep the ordinary part free of metadata to verify the provider default.
	const attachments = [
		{
			filename: 'logo.svg',
			type: 'image/svg+xml',
			content: inlineSvgBase64,
			disposition: 'inline' as const,
			contentId: 'logo@example.com'
		},
		{
			filename: 'notes.txt',
			type: 'text/plain',
			content: ordinaryFileBase64
		}
	];

	return {
		from: providerTestFrom,
		senderName: 'Me',
		to: ['recipient@example.com'],
		subject: 'Attachment metadata',
		text: 'See the files.',
		html: '<p>See the logo.</p><img src="cid:logo@example.com" alt="Logo">',
		attachments
	};
}

test('Resend sends CID SVGs inline and leaves ordinary files without content_id', async () => {
	let requestBody:
		| { html?: string; attachments?: Array<Record<string, unknown>> }
		| undefined;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_input, init) => {
		requestBody = JSON.parse(String(init?.body)) as {
			html?: string;
			attachments?: Array<Record<string, unknown>>;
		};
		return new Response(JSON.stringify({ id: 'resend-message-id' }), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	};

	try {
		const result = await createResendProvider('test-resend-key').send(providerAttachmentInput());
		assert.equal(result.providerId, 'resend-message-id');
	} finally {
		globalThis.fetch = originalFetch;
	}

	const attachments = requestBody?.attachments;
	assert.ok(attachments);
	assert.match(requestBody?.html ?? '', /src="cid:logo@example\.com"/);
	assert.deepEqual(attachments[0], {
		filename: 'logo.svg',
		content: inlineSvgBase64,
		content_type: 'image/svg+xml',
		content_id: 'logo@example.com'
	});
	assert.deepEqual(attachments[1], {
		filename: 'notes.txt',
		content: ordinaryFileBase64,
		content_type: 'text/plain'
	});
});

test('Cloudflare sends CID SVGs inline and ordinary files as attachments', async () => {
	let payload: CloudflareSendPayload | undefined;
	const provider = createCloudflareProvider(
		{
			async send(nextPayload) {
				payload = nextPayload;
				return { messageId: 'cloudflare-message-id' };
			}
		},
		'example.com'
	);

	const result = await provider.send(providerAttachmentInput());
	assert.equal(result.providerId, 'cloudflare-message-id');

	const attachments = payload?.attachments;
	assert.ok(attachments);
	assert.match(payload?.html ?? '', /src="cid:logo@example\.com"/);
	assert.equal(attachments.length, 2);

	const inlineAttachment = attachments[0];
	assert.equal(inlineAttachment.filename, 'logo.svg');
	assert.equal(inlineAttachment.type, 'image/svg+xml');
	assert.equal(inlineAttachment.disposition, 'inline');
	if (inlineAttachment.disposition === 'inline') {
		assert.equal(inlineAttachment.contentId, 'logo@example.com');
	}
	assert.deepEqual(
		new Uint8Array(inlineAttachment.content as ArrayBuffer),
		new Uint8Array(Buffer.from(inlineSvg))
	);

	const ordinaryAttachment = attachments[1];
	assert.equal(ordinaryAttachment.filename, 'notes.txt');
	assert.equal(ordinaryAttachment.type, 'text/plain');
	assert.equal(ordinaryAttachment.disposition, 'attachment');
	assert.equal(ordinaryAttachment.contentId, undefined);
	assert.deepEqual(
		new Uint8Array(ordinaryAttachment.content as ArrayBuffer),
		new Uint8Array(Buffer.from(ordinaryFile))
	);
});

describe('hybrid provider with an operator-verified sending list', () => {
	const domain = 'mailbox.test';
	function input(fromDomain = domain): OutboundMailInput {
		return {
			from: { ...providerTestFrom, domain_id: fromDomain, domain_name: fromDomain, address: `alice@${fromDomain}` },
			senderName: 'Wynn', to: ['recipient@external.test'], subject: 'Scoped sending', text: 'Test message'
		};
	}
	function remote() {
		const calls = { list: 0, get: 0, send: 0 };
		const provider: EmailProvider = {
			kind: 'resend',
			async listDomains() {
				calls.list++;
				return [
					{id:'resend-uuid',name:domain,status:'verified',region:'us-east-1',sendingEnabled:true,receivingEnabled:false},
					{id:'unrelated-uuid',name:'unrelated.test',status:'verified',sendingEnabled:true,receivingEnabled:true}
				];
			},
			async getDomain() { calls.get++; throw new Error('Unexpected remote domain read'); },
			async send() { calls.send++; return {providerId:'scoped-send-id'}; }
		};
		return {provider,calls};
	}

	test('undefined preserves dynamic domain lookup while keeping stable IDs and Cloudflare receiving', async () => {
		const {provider,calls}=remote();
		const hybrid=createHybridProvider(provider,[domain]);
		assert.deepEqual(await hybrid.listDomains(),[
			{id:domain,name:domain,status:'verified',region:'us-east-1',sendingEnabled:true,receivingEnabled:true}
		]);
		assert.equal(calls.list,1);
		assert.equal((await hybrid.send(input())).providerId,'scoped-send-id');
	});

	test('explicit sending list never reads remote domains and enables only the Cloudflare intersection', async () => {
		const {provider,calls}=remote();
		const hybrid=createHybridProvider(provider,[domain,'receiving.test'],[domain,'unrelated.test']);
		assert.deepEqual(await hybrid.listDomains(),[
			{id:domain,name:domain,status:'verified',region:null,sendingEnabled:true,receivingEnabled:true},
			{id:'receiving.test',name:'receiving.test',status:'receiving-only',region:null,sendingEnabled:false,receivingEnabled:true}
		]);
		assert.equal((await hybrid.getDomain(domain)).id,domain);
		await assert.rejects(hybrid.getDomain('unrelated.test'),ProviderError);
		assert.deepEqual(calls,{list:0,get:0,send:0});
		await assert.rejects(hybrid.send(input('receiving.test')),(error:unknown)=>error instanceof ProviderError && error.status===403);
		await assert.rejects(hybrid.send(input('unrelated.test')),(error:unknown)=>error instanceof ProviderError && error.status===403);
		assert.equal(calls.send,0);
		assert.equal((await hybrid.send(input())).providerId,'scoped-send-id');
		assert.deepEqual(calls,{list:0,get:0,send:1});
	});

	test('an explicit empty list disables sending without falling back to remote discovery', async () => {
		const {provider,calls}=remote();
		const hybrid=createHybridProvider(provider,[domain],[]);
		assert.equal((await hybrid.getDomain(domain)).sendingEnabled,false);
		assert.equal((await hybrid.getDomain(domain)).receivingEnabled,true);
		await assert.rejects(hybrid.send(input()),(error:unknown)=>error instanceof ProviderError && error.code==='sending_domain_not_allowed');
		assert.deepEqual(calls,{list:0,get:0,send:0});
	});

	test('a verified list without a sending key remains receiving-only and refuses sends with 503', async () => {
		const hybrid=createHybridProvider(null,[domain],[domain]);
		assert.deepEqual(await hybrid.getDomain(domain),
			{id:domain,name:domain,status:'receiving-only',region:null,sendingEnabled:false,receivingEnabled:true});
		await assert.rejects(hybrid.send(input()),(error:unknown)=>error instanceof ProviderError && error.status===503);
	});

	test('application configuration supports a scoped key and treats an empty configured list as disabled', async () => {
		const originalFetch=globalThis.fetch;
		const requests: Array<{url:string;method:string}>=[];
		globalThis.fetch=async(input,init)=>{
			requests.push({url:String(input),method:init?.method??'GET'});
			assert.equal(String(input),'https://api.resend.com/emails');
			assert.equal(init?.method,'POST');
			return Response.json({id:'scoped-send-id'});
		};
		try {
			const platform = (list:string)=>({env:{EMAIL_PROVIDER:'resend',INBOUND_EMAIL_PROVIDER:'cloudflare',
				CLOUDFLARE_MAIL_DOMAINS:'Mailbox.Test',RESEND_API_KEY:'test-only-scoped-key',RESEND_VERIFIED_SEND_DOMAINS:list}}) as unknown as App.Platform;
			const configured=getEmailProvider(platform('MAILBOX.TEST, unrelated.test'));
			assert.equal((await configured.getDomain(domain)).sendingEnabled,true);
			assert.equal((await configured.listDomains()).length,1);
			assert.equal((await configured.send(input())).providerId,'scoped-send-id');
			const disabled=getEmailProvider(platform(''));
			assert.equal((await disabled.getDomain(domain)).sendingEnabled,false);
			await assert.rejects(disabled.send(input()),ProviderError);
			assert.deepEqual(requests,[{url:'https://api.resend.com/emails',method:'POST'}]);
		} finally {globalThis.fetch=originalFetch;}
	});

	test('refreshing an existing D1 domain preserves its mailbox address and ID', async () => {
		const {db,sqlite}=createTestDb();insertTestUser(sqlite,'hybrid-user');
		await upsertDomain(db,{id:domain,name:domain,status:'receiving-only',sendingEnabled:false,receivingEnabled:true});
		const address=await createAddress(db,{userId:'hybrid-user',domainId:domain,localPart:'alice'});
		const {provider,calls}=remote();
		const synced=await syncDomains(db,createHybridProvider(provider,[domain],[domain]));
		assert.equal(synced[0].id,domain);
		assert.equal(synced[0].sending_enabled,true);
		assert.equal(synced[0].receiving_enabled,true);
		const preserved=await getAddressForUser(db,'hybrid-user',address.id);
		assert.equal(preserved?.domain_id,domain);
		assert.equal(preserved?.address,`alice@${domain}`);
		assert.deepEqual(calls,{list:0,get:0,send:0});
	});
});

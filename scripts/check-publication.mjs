#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
assert(files.length > 0, 'Stage the public source before checking it.');
const forbiddenPath = /(^|\/)(node_modules|\.svelte-kit|\.wrangler|\.build|\.git|evidence|backups|\.private|coverage)(\/|$)|\.(?:db|sqlite\d*|eml|mbox|har|pem|key|p12|pfx|log|zip|tgz)$/i;
const credentials = /(?:GOCSPX-[A-Za-z0-9_-]{15,}|gh[pousr]_[A-Za-z0-9_]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b\d{10,}-[a-z0-9]{10,}\.apps\.googleusercontent\.com\b)/;
for (const file of files) {
  assert(!forbiddenPath.test(file), `Private/runtime file is tracked: ${file}`);
  const name = basename(file);
  assert(!/^\.env(?:\.|$)/i.test(name) || file === '.env.example', `Environment file is tracked: ${file}`);
  assert(!/^\.dev\.vars(?:\.|$)/i.test(name) || file === '.dev.vars.example', `Secret file is tracked: ${file}`);
  assert(!['deployment-resources.json', 'DEPLOYMENT.zh-CN.md', 'package-lock.json'].includes(name), `Local/stale file: ${file}`);
  const stat = lstatSync(file);
  assert(!stat.isSymbolicLink(), `Symlink is tracked: ${file}`);
  assert(stat.size < 2 * 1024 * 1024, `Unexpectedly large source file: ${file}`);
  if (!/\.(png|woff2?)$/.test(file)) {
    const body = readFileSync(file, 'utf8');
    assert(!credentials.test(body), `Credential-shaped content: ${file}`);
    assert(!/\/(?:Users|home)\/[^\s/'"]+\//.test(body), `Machine-specific path: ${file}`);
  }
}
const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
assert(!config.account_id && !config.routes, 'Personal account/domain route must not be shipped.');
assert.equal(config.d1_databases[0].database_id, '00000000-0000-0000-0000-000000000000');
assert.equal(config.kv_namespaces[0].id, '00000000000000000000000000000000');
for (const key of ['APP_URL', 'CLOUDFLARE_MAIL_DOMAINS', 'RESEND_VERIFIED_SEND_DOMAINS']) assert.equal(config.vars[key], '');
assert.equal(config.vars.API_SEND_ENABLED, 'false');
assert(!config.r2_buckets && !config.ai, 'Reference config must not provision R2 or Workers AI.');
for (const line of readFileSync('.dev.vars.example', 'utf8').split('\n')) {
  if (!line.trim() || line.startsWith('#')) continue;
  assert(/^[A-Z0-9_]+=$/.test(line), 'Secret examples must be blank.');
}
console.log(`Publication baseline passed for ${files.length} tracked files; OAuth/secrets are unconfigured.`);

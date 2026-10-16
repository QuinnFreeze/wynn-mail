-- Extend the existing provider constraint without discarding saved ciphertext.
-- OAuth keys are acquired by the server and remain encrypted exactly like
-- manually supplied keys. No OpenAI or Anthropic subscription tokens are used.
CREATE TABLE _ai_providers_oauth (
	owner       TEXT PRIMARY KEY,
	user_id     TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
	kind        TEXT NOT NULL CHECK (kind IN ('workers_ai', 'openai', 'anthropic', 'openrouter')),
	base_url    TEXT,
	model       TEXT NOT NULL,
	api_key     TEXT,
	key_hint    TEXT,
	updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
	auth_method TEXT NOT NULL DEFAULT 'api_key' CHECK (auth_method IN ('api_key', 'oauth', 'binding')),
	CHECK ((owner = 'instance' AND user_id IS NULL) OR owner = user_id),
	CHECK (auth_method <> 'oauth' OR (kind = 'openrouter' AND user_id IS NOT NULL)),
	CHECK ((kind = 'workers_ai') = (auth_method = 'binding'))
);

INSERT INTO _ai_providers_oauth
	(owner, user_id, kind, base_url, model, api_key, key_hint, updated_at, auth_method)
	SELECT owner, user_id, kind, base_url, model, api_key, key_hint, updated_at,
	       CASE WHEN kind = 'workers_ai' THEN 'binding' ELSE 'api_key' END
	FROM ai_providers;

DROP TABLE ai_providers;
ALTER TABLE _ai_providers_oauth RENAME TO ai_providers;

-- Connection intent outlives the provider row: deleting a provider must also
-- invalidate an OAuth callback that has already claimed its transaction and
-- is still waiting for the remote exchange to finish.
CREATE TABLE ai_connection_generations (
	user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0)
);

-- Short-lived, single-use transactions bind provider authorization to the
-- exact mailbox session and initiating browser. The PKCE verifier is sealed;
-- raw state, browser secrets and provider keys are never stored here.
CREATE TABLE ai_oauth_transactions (
	state_hash      TEXT PRIMARY KEY,
	user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	generation      INTEGER NOT NULL,
	browser_hash    TEXT NOT NULL,
	verifier_sealed TEXT NOT NULL,
	redirect_uri    TEXT NOT NULL,
	expires_at      INTEGER NOT NULL,
	created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ai_oauth_expiry ON ai_oauth_transactions(expires_at);
CREATE INDEX idx_ai_oauth_session ON ai_oauth_transactions(session_id);

-- External identities are explicitly connected from an existing mailbox session.
-- They never create a mailbox or match accounts by email address.
CREATE TABLE social_identities (
	provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
	subject TEXT NOT NULL,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	display_name TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (provider, subject),
	UNIQUE (user_id, provider)
);

-- No provider access or refresh tokens are persisted. PKCE verifiers live only
-- in a short-lived, HttpOnly browser cookie, bound to this single-use row.
CREATE TABLE social_login_transactions (
	state_hash TEXT PRIMARY KEY,
	provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
	browser_hash TEXT NOT NULL,
	code_challenge TEXT NOT NULL,
	nonce_hash TEXT NOT NULL,
	intent TEXT NOT NULL CHECK (intent IN ('login', 'link')),
	initiator_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
	initiator_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
	next_path TEXT,
	add_account INTEGER NOT NULL DEFAULT 0 CHECK (add_account IN (0, 1)),
	expires_at TEXT NOT NULL
);
CREATE INDEX idx_social_transactions_expiry ON social_login_transactions(expires_at);

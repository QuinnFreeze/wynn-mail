-- Add the native Gemini API without changing saved keys or OAuth connections.
CREATE TABLE _ai_providers_gemini (
	owner       TEXT PRIMARY KEY,
	user_id     TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
	kind        TEXT NOT NULL CHECK (kind IN ('workers_ai', 'openai', 'anthropic', 'openrouter', 'gemini')),
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

INSERT INTO _ai_providers_gemini
	(owner, user_id, kind, base_url, model, api_key, key_hint, updated_at, auth_method)
	SELECT owner, user_id, kind, base_url, model, api_key, key_hint, updated_at, auth_method
	FROM ai_providers;

DROP TABLE ai_providers;
ALTER TABLE _ai_providers_gemini RENAME TO ai_providers;

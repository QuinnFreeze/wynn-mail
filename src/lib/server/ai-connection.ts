import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

/**
 * This record survives deleting a provider. Advance it in the same database
 * batch as every new connection intent so an older OAuth exchange cannot
 * recreate a disconnected key or overwrite a newer connection.
 */
export function advanceAiConnectionStatement(db: D1Database, userId: string): D1PreparedStatement {
	return db.prepare(
		`INSERT INTO ai_connection_generations (user_id, generation) VALUES (?, 1)
		 ON CONFLICT(user_id) DO UPDATE SET generation = generation + 1`
	).bind(userId);
}

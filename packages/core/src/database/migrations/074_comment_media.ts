import type { Kysely } from "kysely";
import { sql } from "kysely";

import { columnExists, indexExists } from "../dialect-helpers.js";

const DUPLICATE_COLUMN_RE = /(?:duplicate column|column .* already exists|already exists.*column)/i;

/**
 * One optional image attachment per comment.
 *
 * Additive: existing comments keep `media_id` NULL. ON DELETE SET NULL so
 * deleting a library asset does not cascade-delete the comment. The unique
 * partial index prevents two comments from claiming the same media row.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await addMediaIdIfMissing(db);
	if (!(await indexExists(db, "idx_comments_media"))) {
		await sql`
			CREATE UNIQUE INDEX idx_comments_media
			ON ${sql.ref("_emdash_comments")} (media_id)
			WHERE media_id IS NOT NULL
		`.execute(db);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (await indexExists(db, "idx_comments_media")) {
		await db.schema.dropIndex("idx_comments_media").execute();
	}
	if (await columnExists(db, "_emdash_comments", "media_id")) {
		await db.schema.alterTable("_emdash_comments").dropColumn("media_id").execute();
	}
}

async function addMediaIdIfMissing(db: Kysely<unknown>): Promise<void> {
	if (await columnExists(db, "_emdash_comments", "media_id")) return;

	try {
		await db.schema
			.alterTable("_emdash_comments")
			.addColumn("media_id", "text", (col) => col.references("media.id").onDelete("set null"))
			.execute();
	} catch (error) {
		if (DUPLICATE_COLUMN_RE.test(deepErrorMessage(error))) {
			if (await columnExists(db, "_emdash_comments", "media_id")) return;
		}
		throw error;
	}
}

function deepErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		const own = error.message ?? "";
		if (error.cause) {
			const causeMessage = deepErrorMessage(error.cause);
			return own ? `${own}: ${causeMessage}` : causeMessage;
		}
		return own;
	}
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

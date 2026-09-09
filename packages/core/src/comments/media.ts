/**
 * Comment image attachments.
 *
 * One optional raster image per comment. MIME is sniffed from bytes (not
 * trusted from the client Content-Type) so SVG/HTML cannot sneak through
 * a spoofed type. Public lists batch-resolve media in one query when any
 * comment on the page has an attachment — zero extra queries otherwise.
 */

import type { Kysely } from "kysely";

import type { Comment } from "../database/repositories/comment.js";
import { MediaRepository, type MediaItem } from "../database/repositories/media.js";
import type { Database } from "../database/types.js";
import { chunks, SQL_BATCH_SIZE } from "../utils/chunks.js";

export const COMMENT_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type CommentImageMime = (typeof COMMENT_IMAGE_MIME_TYPES)[number];

/** Tight cap for untrusted comment uploads (library default is 50 MB). */
export const COMMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export interface CommentMedia {
	id: string;
	url: string;
	width?: number | null;
	height?: number | null;
	alt?: string | null;
}

export function commentMediaUrl(storageKey: string): string {
	return `/_emdash/api/media/file/${storageKey}`;
}

export function toCommentMedia(item: MediaItem): CommentMedia {
	return {
		id: item.id,
		url: commentMediaUrl(item.storageKey),
		width: item.width,
		height: item.height,
		alt: item.alt,
	};
}

export function sniffCommentImageMime(bytes: Uint8Array): CommentImageMime | null {
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg";
	}
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return "image/png";
	}
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return "image/webp";
	}
	return null;
}

export function isCommentImageMime(mime: string): mime is CommentImageMime {
	return (COMMENT_IMAGE_MIME_TYPES as readonly string[]).includes(mime);
}

export async function findCommentIdByMediaId(
	db: Kysely<Database>,
	mediaId: string,
): Promise<string | null> {
	const row = await db
		.selectFrom("_emdash_comments")
		.select("id")
		.where("media_id", "=", mediaId)
		.executeTakeFirst();
	return row?.id ?? null;
}

export async function validateCommentMediaId(
	db: Kysely<Database>,
	mediaId: string,
): Promise<{ ok: true; media: MediaItem } | { ok: false; code: string; message: string }> {
	const media = await new MediaRepository(db).findById(mediaId);
	if (!media || media.status !== "ready") {
		return { ok: false, code: "VALIDATION_ERROR", message: "Image attachment not found" };
	}
	if (!isCommentImageMime(media.mimeType)) {
		return {
			ok: false,
			code: "INVALID_TYPE",
			message: "Comment images must be JPEG, PNG, or WebP",
		};
	}
	if (media.size != null && media.size > COMMENT_IMAGE_MAX_BYTES) {
		return { ok: false, code: "PAYLOAD_TOO_LARGE", message: "Image is too large" };
	}
	const existing = await findCommentIdByMediaId(db, mediaId);
	if (existing) {
		return {
			ok: false,
			code: "VALIDATION_ERROR",
			message: "Image is already attached to a comment",
		};
	}
	return { ok: true, media };
}

/**
 * Attach public media payloads onto comments (and threaded replies).
 * Skips the media table entirely when no comment has a media_id.
 */
export async function attachCommentMedia(
	db: Kysely<Database>,
	comments: Array<Comment & { _replies?: Comment[] }>,
): Promise<void> {
	const ids: string[] = [];
	for (const comment of comments) {
		if (comment.mediaId) ids.push(comment.mediaId);
		if (comment._replies) {
			for (const reply of comment._replies) {
				if (reply.mediaId) ids.push(reply.mediaId);
			}
		}
	}
	if (ids.length === 0) return;

	const unique = [...new Set(ids)];
	const byId = new Map<string, CommentMedia>();
	const repo = new MediaRepository(db);
	for (const chunk of chunks(unique, SQL_BATCH_SIZE)) {
		const items = await repo.findByIds(chunk);
		for (const item of items) {
			if (item.status !== "ready") continue;
			byId.set(item.id, toCommentMedia(item));
		}
	}

	const assign = (comment: Comment) => {
		if (!comment.mediaId) return;
		const media = byId.get(comment.mediaId);
		if (media) comment.media = media;
	};
	for (const comment of comments) {
		assign(comment);
		comment._replies?.forEach(assign);
	}
}

/**
 * Comment-scoped image upload — anonymous visitors may attach one JPEG/PNG/WebP
 * without the Contributor `media:upload` permission.
 */

import * as path from "node:path";

import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import {
	COMMENT_IMAGE_MAX_BYTES,
	isCommentImageMime,
	sniffCommentImageMime,
	toCommentMedia,
	type CommentMedia,
} from "../../comments/media.js";
import { MediaRepository } from "../../database/repositories/media.js";
import type { Database } from "../../database/types.js";
import { enrichImageMetadata } from "../../media/enrich.js";
import type { Storage } from "../../storage/types.js";
import { computeContentHash } from "../../utils/hash.js";
import { formatFileSize } from "../schemas/media.js";
import type { ApiResult } from "../types.js";

const EXT_FOR_MIME: Record<string, string> = {
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/webp": ".webp",
};

export async function handleCommentMediaUpload(
	db: Kysely<Database>,
	storage: Storage,
	file: File,
	authorId?: string | null,
): Promise<ApiResult<CommentMedia & { mediaId: string }>> {
	if (file.size <= 0) {
		return { success: false, error: { code: "VALIDATION_ERROR", message: "Empty file" } };
	}
	if (file.size > COMMENT_IMAGE_MAX_BYTES) {
		return {
			success: false,
			error: {
				code: "PAYLOAD_TOO_LARGE",
				message: `Image exceeds maximum size of ${formatFileSize(COMMENT_IMAGE_MAX_BYTES)}`,
			},
		};
	}

	const bytes = new Uint8Array(await file.arrayBuffer());
	const sniffed = sniffCommentImageMime(bytes);
	if (!sniffed || !isCommentImageMime(sniffed)) {
		return {
			success: false,
			error: { code: "INVALID_TYPE", message: "Comment images must be JPEG, PNG, or WebP" },
		};
	}

	const repo = new MediaRepository(db);
	const contentHash = await computeContentHash(bytes);

	const basename = path.basename(file.name || "comment-image").replace(/[^\w.-]+/g, "_");
	const ext = EXT_FOR_MIME[sniffed] ?? path.extname(basename);
	const storageKey = `${ulid()}${ext}`;

	await storage.upload({ key: storageKey, body: bytes, contentType: sniffed });

	try {
		const enriched = await enrichImageMetadata(bytes, sniffed);
		const item = await repo.create({
			filename: basename || `comment-image${ext}`,
			mimeType: sniffed,
			size: bytes.byteLength,
			width: enriched.width,
			height: enriched.height,
			storageKey,
			contentHash,
			blurhash: enriched.blurhash,
			dominantColor: enriched.dominantColor,
			authorId: authorId ?? undefined,
		});
		const media = toCommentMedia(item);
		return { success: true, data: { ...media, mediaId: item.id } };
	} catch (error) {
		try {
			await storage.delete(storageKey);
		} catch {
			// Ignore cleanup errors
		}
		throw error;
	}
}

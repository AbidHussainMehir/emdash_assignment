/**
 * Public comment image upload
 *
 * POST /_emdash/api/comments/:collection/:contentId/media
 *
 * Multipart field `file`. No CMS auth — gated by comments-enabled, published
 * content, honeypot, and the same IP rate limit as comment create. MIME is
 * sniffed from bytes (JPEG/PNG/WebP only, 5 MB cap).
 */

import type { APIRoute } from "astro";

import { apiError, handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleCommentMediaUpload } from "#api/handlers/comment-media.js";
import { checkRateLimit, hashIp } from "#api/handlers/comments.js";
import { validateIdentifier } from "#db/validate.js";
import { extractRequestMeta } from "#plugins/request-meta.js";
import { resolveSecretsCached } from "#config/secrets.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const { collection, contentId } = params;

	if (!collection || !contentId) {
		return apiError(
			"VALIDATION_ERROR",
			"Collection and content ID required",
			400,
		);
	}

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	if (!emdash?.storage) {
		return apiError("NO_STORAGE", "Storage is not configured", 501);
	}

	try {
		const collectionRow = await emdash.db
			.selectFrom("_emdash_collections")
			.select(["comments_enabled", "comments_closed_after_days"])
			.where("slug", "=", collection)
			.executeTakeFirst();

		if (!collectionRow) {
			return apiError("NOT_FOUND", `Collection '${collection}' not found`, 404);
		}
		if (!collectionRow.comments_enabled) {
			return apiError(
				"COMMENTS_DISABLED",
				"Comments are not enabled for this collection",
				403,
			);
		}

		validateIdentifier(collection, "collection");
		const contentRow = await emdash.db
			.selectFrom(`ec_${collection}` as never)
			.select(["id" as never, "published_at" as never])
			.where("id" as never, "=", contentId as never)
			.where("status" as never, "=", "published" as never)
			.where("deleted_at" as never, "is", null as never)
			.executeTakeFirst();

		if (!contentRow) {
			return apiError("NOT_FOUND", "Content not found", 404);
		}

		if (collectionRow.comments_closed_after_days > 0) {
			const publishedAt = (contentRow as { published_at: string | null })
				.published_at;
			if (publishedAt) {
				const closedDate = new Date(publishedAt);
				closedDate.setDate(
					closedDate.getDate() + collectionRow.comments_closed_after_days,
				);
				if (new Date() > closedDate) {
					return apiError(
						"COMMENTS_CLOSED",
						"Comments are closed for this content",
						403,
					);
				}
			}
		}

		const formData = await request.formData();
		if (formData.get("website_url")) {
			return unwrapResult({
				success: true,
				data: { mediaId: "ok", url: "" },
			});
		}

		const file = formData.get("file");
		if (!(file instanceof File)) {
			return apiError("VALIDATION_ERROR", "file is required", 400);
		}

		const meta = extractRequestMeta(request, emdash.config);
		const { ipSalt } = await resolveSecretsCached(emdash.db);
		const ipHash = meta.ip ? await hashIp(meta.ip, ipSalt) : "unknown";
		const unknownBucketLimit = ipHash === "unknown" ? 20 : undefined;
		if (await checkRateLimit(emdash.db, ipHash, unknownBucketLimit)) {
			return apiError(
				"RATE_LIMITED",
				"Too many comments. Please try again later.",
				429,
			);
		}

		const result = await handleCommentMediaUpload(
			emdash.db,
			emdash.storage,
			file,
			user?.id,
		);
		if (!result.success) {
			const status =
				result.error.code === "PAYLOAD_TOO_LARGE"
					? 413
					: result.error.code === "INVALID_TYPE"
						? 400
						: 400;
			return apiError(result.error.code, result.error.message, status);
		}
		return unwrapResult(result);
	} catch (error) {
		return handleError(
			error,
			"Failed to upload comment image",
			"COMMENT_MEDIA_UPLOAD_ERROR",
		);
	}
};

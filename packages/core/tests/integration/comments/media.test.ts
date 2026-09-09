import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleCommentMediaUpload } from "../../../src/api/handlers/comment-media.js";
import { handleCommentList } from "../../../src/api/handlers/comments.js";
import { attachCommentMedia, validateCommentMediaId } from "../../../src/comments/media.js";
import { createComment, type CommentHookRunner } from "../../../src/comments/service.js";
import { CommentRepository } from "../../../src/database/repositories/comment.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import type { Storage } from "../../../src/storage/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const PNG_1X1 = Uint8Array.of(
	0x89,
	0x50,
	0x4e,
	0x47,
	0x0d,
	0x0a,
	0x1a,
	0x0a,
	0x00,
	0x00,
	0x00,
	0x0d,
	0x49,
	0x48,
	0x44,
	0x52,
	0x00,
	0x00,
	0x00,
	0x01,
	0x00,
	0x00,
	0x00,
	0x01,
	0x08,
	0x06,
	0x00,
	0x00,
	0x00,
	0x1f,
	0x15,
	0xc4,
	0x89,
	0x00,
	0x00,
	0x00,
	0x0a,
	0x49,
	0x44,
	0x41,
	0x54,
	0x78,
	0x9c,
	0x63,
	0x00,
	0x01,
	0x00,
	0x00,
	0x05,
	0x00,
	0x01,
	0x0d,
	0x0a,
	0x2d,
	0xb4,
	0x00,
	0x00,
	0x00,
	0x00,
	0x49,
	0x45,
	0x4e,
	0x44,
	0xae,
	0x42,
	0x60,
	0x82,
);

describe("comment image attachments", () => {
	let db: Kysely<Database>;
	let comments: CommentRepository;
	let media: MediaRepository;

	beforeEach(async () => {
		db = await setupTestDatabase();
		comments = new CommentRepository(db);
		media = new MediaRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function readyPng(filename = "photo.png") {
		return media.create({
			filename,
			mimeType: "image/png",
			size: 128,
			storageKey: `${filename}`,
			status: "ready",
		});
	}

	function approveHooks(): CommentHookRunner {
		return {
			runBeforeCreate: async (event) => event,
			runModerate: async () => ({ status: "approved", reason: "Test" }),
			fireAfterCreate: vi.fn(),
			fireAfterModerate: vi.fn(),
		};
	}

	it("defaults mediaId to null and round-trips an attached image", async () => {
		const bare = await comments.create({
			collection: "post",
			contentId: "content-1",
			authorName: "Jane",
			authorEmail: "jane@example.com",
			body: "Hi",
			status: "approved",
		});
		expect(bare.mediaId).toBeNull();

		const image = await readyPng();
		const withImage = await comments.create({
			collection: "post",
			contentId: "content-1",
			authorName: "Jane",
			authorEmail: "jane@example.com",
			body: "With photo",
			status: "approved",
			mediaId: image.id,
		});
		expect(withImage.mediaId).toBe(image.id);

		const listed = await comments.findByContent("post", "content-1", { status: "approved" });
		await attachCommentMedia(db, listed.items);
		const attached = listed.items.find((c) => c.id === withImage.id);
		expect(attached?.media?.url).toBe(`/_emdash/api/media/file/${image.storageKey}`);
		const unattached = listed.items.find((c) => c.id === bare.id);
		expect(unattached?.media).toBeUndefined();
	});

	it("rejects attaching missing, non-image, or already-used media", async () => {
		const missing = await validateCommentMediaId(db, "no-such-media");
		expect(missing.ok).toBe(false);

		const pdf = await media.create({
			filename: "doc.pdf",
			mimeType: "application/pdf",
			storageKey: "doc.pdf",
			status: "ready",
		});
		const badType = await validateCommentMediaId(db, pdf.id);
		expect(badType).toMatchObject({ ok: false, code: "INVALID_TYPE" });

		const image = await readyPng("used.png");
		await comments.create({
			collection: "post",
			contentId: "content-1",
			authorName: "Jane",
			authorEmail: "jane@example.com",
			body: "First",
			status: "approved",
			mediaId: image.id,
		});
		const reused = await validateCommentMediaId(db, image.id);
		expect(reused).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
	});

	it("holds an image comment for review even when the moderator would approve", async () => {
		const image = await readyPng("held.png");
		const result = await createComment(
			db,
			{
				collection: "post",
				contentId: "content-1",
				authorName: "Jane",
				authorEmail: "jane@example.com",
				body: "Look",
				mediaId: image.id,
			},
			{
				commentsEnabled: true,
				commentsModeration: "none",
				commentsClosedAfterDays: 0,
				commentsAutoApproveUsers: true,
			},
			approveHooks(),
		);
		expect(result?.comment.status).toBe("pending");
		expect(result?.decision.reason).toBe("Image attachment held for review");
		expect(result?.comment.mediaId).toBe(image.id);
	});

	it("includes media on the public list payload", async () => {
		const image = await readyPng("public.png");
		await comments.create({
			collection: "post",
			contentId: "content-1",
			authorName: "Jane",
			authorEmail: "jane@example.com",
			body: "Photo",
			status: "approved",
			mediaId: image.id,
		});
		const listed = await handleCommentList(db, "post", "content-1");
		expect(listed.success).toBe(true);
		if (!listed.success) return;
		expect(listed.data.items[0]?.media?.id).toBe(image.id);
		expect(listed.data.items[0]?.media?.url).toContain(image.storageKey);
	});

	it("uploads a sniffed PNG through the comment media handler", async () => {
		const stored: string[] = [];
		const storage = {
			upload: vi.fn(async ({ key }) => {
				stored.push(key);
				return { key, url: `/${key}`, size: PNG_1X1.byteLength };
			}),
			download: vi.fn(),
			delete: vi.fn(),
			exists: vi.fn(),
			list: vi.fn(),
			getSignedUploadUrl: vi.fn(),
			getPublicUrl: vi.fn((key: string) => `/${key}`),
		} as unknown as Storage;
		const file = new File([PNG_1X1], "pic.png", { type: "application/octet-stream" });
		const result = await handleCommentMediaUpload(db, storage, file);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.mediaId).toBeTruthy();
		expect(stored).toHaveLength(1);
		const saved = await media.findById(result.data.mediaId);
		expect(saved?.mimeType).toBe("image/png");
		expect(saved?.status).toBe("ready");
	});

	it("rejects a spoofed SVG even if the client claims image/png", async () => {
		const storage = {
			upload: vi.fn(),
			download: vi.fn(),
			delete: vi.fn(),
			exists: vi.fn(),
			list: vi.fn(),
			getSignedUploadUrl: vi.fn(),
			getPublicUrl: vi.fn(),
		} as unknown as Storage;
		const file = new File(["<svg xmlns='http://www.w3.org/2000/svg'></svg>"], "x.png", {
			type: "image/png",
		});
		const result = await handleCommentMediaUpload(db, storage, file);
		expect(result).toMatchObject({ success: false, error: { code: "INVALID_TYPE" } });
		expect(storage.upload).not.toHaveBeenCalled();
	});
});

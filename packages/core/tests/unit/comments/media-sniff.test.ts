import { describe, expect, it } from "vitest";

import { sniffCommentImageMime } from "../../../src/comments/media.js";

describe("sniffCommentImageMime", () => {
	it("detects JPEG, PNG, and WebP from magic bytes", () => {
		expect(sniffCommentImageMime(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
		expect(
			sniffCommentImageMime(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
		).toBe("image/png");
		const webp = new Uint8Array(12);
		webp.set([0x52, 0x49, 0x46, 0x46], 0);
		webp.set([0x57, 0x45, 0x42, 0x50], 8);
		expect(sniffCommentImageMime(webp)).toBe("image/webp");
	});

	it("rejects SVG and empty payloads", () => {
		expect(
			sniffCommentImageMime(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'>")),
		).toBe(null);
		expect(sniffCommentImageMime(new Uint8Array())).toBe(null);
	});
});

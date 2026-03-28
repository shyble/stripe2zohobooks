import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config before importing crypto module
vi.mock("../config.js", () => ({
	config: {
		encryptionKey: "a".repeat(64), // 32-byte hex key
	},
}));

import { encrypt, decrypt } from "./crypto.js";

describe("crypto", () => {
	it("encrypts and decrypts a string", () => {
		const plaintext = "sk_live_abc123";
		const encrypted = encrypt(plaintext);

		expect(encrypted).not.toBe(plaintext);
		expect(encrypted.startsWith("enc:")).toBe(true);
		expect(decrypt(encrypted)).toBe(plaintext);
	});

	it("produces different ciphertexts for same input (random IV)", () => {
		const plaintext = "whsec_test123";
		const a = encrypt(plaintext);
		const b = encrypt(plaintext);

		expect(a).not.toBe(b);
		expect(decrypt(a)).toBe(plaintext);
		expect(decrypt(b)).toBe(plaintext);
	});

	it("returns plaintext as-is if not encrypted", () => {
		expect(decrypt("sk_live_abc123")).toBe("sk_live_abc123");
	});

	it("handles empty strings", () => {
		const encrypted = encrypt("");
		expect(decrypt(encrypted)).toBe("");
	});

	it("handles special characters", () => {
		const plaintext = "key_with_special=chars&symbols/+!@#$%";
		const encrypted = encrypt(plaintext);
		expect(decrypt(encrypted)).toBe(plaintext);
	});
});

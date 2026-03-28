import crypto from "node:crypto";
import { config } from "../config.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer | null {
	if (!config.encryptionKey) return null;
	return Buffer.from(config.encryptionKey, "hex");
}

export function encrypt(plaintext: string): string {
	const key = getKey();
	if (!key) return plaintext; // No encryption key configured — store as-is

	const iv = crypto.randomBytes(IV_LENGTH);
	const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

	let encrypted = cipher.update(plaintext, "utf8", "hex");
	encrypted += cipher.final("hex");
	const authTag = cipher.getAuthTag();

	// Format: iv:authTag:ciphertext
	return `enc:${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

export function decrypt(ciphertext: string): string {
	// Not encrypted — return as-is
	if (!ciphertext.startsWith("enc:")) return ciphertext;

	const key = getKey();
	if (!key) {
		throw new Error(
			"ENCRYPTION_KEY is required to decrypt stored secrets. Check your .env file.",
		);
	}

	const parts = ciphertext.split(":");
	if (parts.length !== 4) {
		throw new Error("Invalid encrypted value format");
	}

	const iv = Buffer.from(parts[1], "hex");
	const authTag = Buffer.from(parts[2], "hex");
	const encrypted = parts[3];

	const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
	decipher.setAuthTag(authTag);

	let decrypted = decipher.update(encrypted, "hex", "utf8");
	decrypted += decipher.final("utf8");
	return decrypted;
}

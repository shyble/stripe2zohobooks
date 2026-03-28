import { describe, it, expect } from "vitest";
import { stripeToCurrencyAmount, formatDate } from "./currency.js";

describe("stripeToCurrencyAmount", () => {
	it("converts cents to dollars for USD", () => {
		expect(stripeToCurrencyAmount(1000, "usd")).toBe(10);
		expect(stripeToCurrencyAmount(2999, "usd")).toBe(29.99);
		expect(stripeToCurrencyAmount(50, "usd")).toBe(0.5);
	});

	it("converts cents to euros for EUR", () => {
		expect(stripeToCurrencyAmount(1500, "eur")).toBe(15);
	});

	it("handles zero-decimal currencies (JPY)", () => {
		expect(stripeToCurrencyAmount(1000, "jpy")).toBe(1000);
		expect(stripeToCurrencyAmount(500, "JPY")).toBe(500);
	});

	it("handles zero-decimal currencies (KRW)", () => {
		expect(stripeToCurrencyAmount(50000, "krw")).toBe(50000);
	});

	it("handles zero amount", () => {
		expect(stripeToCurrencyAmount(0, "usd")).toBe(0);
		expect(stripeToCurrencyAmount(0, "jpy")).toBe(0);
	});
});

describe("formatDate", () => {
	it("converts unix timestamp to YYYY-MM-DD", () => {
		// 2024-01-15T00:00:00Z
		expect(formatDate(1705276800)).toBe("2024-01-15");
	});

	it("handles epoch zero", () => {
		expect(formatDate(0)).toBe("1970-01-01");
	});
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the database
const mockGet = vi.fn();
const mockRun = vi.fn();

vi.mock("../db/connection.js", () => {
	const mockChain = {
		from: vi.fn().mockReturnThis(),
		where: vi.fn().mockReturnThis(),
		get: () => mockGet(),
		values: vi.fn().mockReturnThis(),
		run: () => mockRun(),
	};
	return {
		db: {
			select: vi.fn(() => mockChain),
			insert: vi.fn(() => mockChain),
		},
	};
});

vi.mock("../db/schema.js", () => ({
	syncMappings: {
		stripeAccountId: "stripe_account_id",
		stripeObjectType: "stripe_object_type",
		stripeObjectId: "stripe_object_id",
		zohoEntityType: "zoho_entity_type",
		zohoEntityId: "zoho_entity_id",
	},
	syncLog: {},
}));

import { getMapping, createMapping } from "./idempotency.js";

describe("idempotency", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("getMapping returns undefined when no mapping exists", () => {
		mockGet.mockReturnValue(undefined);
		const result = getMapping("acct_123", "customer", "cus_abc");
		expect(result).toBeUndefined();
	});

	it("getMapping returns mapping when found", () => {
		mockGet.mockReturnValue({
			zohoEntityType: "contact",
			zohoEntityId: "zoho_123",
		});
		const result = getMapping("acct_123", "customer", "cus_abc");
		expect(result).toEqual({
			zohoEntityType: "contact",
			zohoEntityId: "zoho_123",
		});
	});

	it("createMapping calls insert", () => {
		createMapping({
			stripeAccountId: "acct_123",
			stripeObjectType: "customer",
			stripeObjectId: "cus_abc",
			zohoEntityType: "contact",
			zohoEntityId: "zoho_123",
		});
		expect(mockRun).toHaveBeenCalled();
	});
});

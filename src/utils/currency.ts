// Stripe amounts are in cents (smallest currency unit).
// Zero-decimal currencies don't need division.
const ZERO_DECIMAL_CURRENCIES = new Set([
	"bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
	"pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

export function stripeToCurrencyAmount(
	amountInCents: number,
	currency: string,
): number {
	if (ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase())) {
		return amountInCents;
	}
	return amountInCents / 100;
}

export function formatDate(timestamp: number): string {
	return new Date(timestamp * 1000).toISOString().split("T")[0];
}

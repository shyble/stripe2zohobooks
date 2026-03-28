import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { zohoConfig } from "../db/schema.js";
import { logger } from "../utils/logger.js";

interface ZohoTokens {
	accessToken: string;
	expiresAt: Date;
}

interface ZohoApiResponse {
	code: number;
	message: string;
	[key: string]: unknown;
}

interface UsageCounters {
	dailyApiCalls: number;
	dailyApiDate: string; // YYYY-MM-DD
	monthlyInvoices: number;
	monthlyInvoiceDate: string; // YYYY-MM
}

// Configurable limits — users can override via env vars
const LIMITS = {
	dailyApiCalls: Number(process.env.ZOHO_DAILY_API_LIMIT) || 1000,
	dailyApiWarnPct: 0.8, // warn at 80%
	yearlyInvoices: Number(process.env.ZOHO_YEARLY_INVOICE_LIMIT) || 1000,
	yearlyInvoiceWarnPct: 0.8,
};

class ZohoClient {
	private accessToken: string | null = null;
	private accessTokenExpiresAt: Date | null = null;
	private lastRequestTime = 0;
	private readonly minRequestInterval = 600; // ~100 req/min
	private usage: UsageCounters = {
		dailyApiCalls: 0,
		dailyApiDate: new Date().toISOString().slice(0, 10),
		monthlyInvoices: 0,
		monthlyInvoiceDate: new Date().toISOString().slice(0, 7),
	};
	private yearlyInvoices = 0;
	private yearlyInvoiceYear = new Date().getFullYear();
	private warningsEmitted = new Set<string>();

	getUsageStats() {
		this.rolloverCounters();
		const dailyPct = this.usage.dailyApiCalls / LIMITS.dailyApiCalls;
		const yearlyPct = this.yearlyInvoices / LIMITS.yearlyInvoices;
		return {
			daily: {
				apiCalls: this.usage.dailyApiCalls,
				limit: LIMITS.dailyApiCalls,
				percent: Math.round(dailyPct * 100),
			},
			invoices: {
				yearly: this.yearlyInvoices,
				yearlyLimit: LIMITS.yearlyInvoices,
				percent: Math.round(yearlyPct * 100),
				monthly: this.usage.monthlyInvoices,
			},
		};
	}

	private rolloverCounters() {
		const today = new Date().toISOString().slice(0, 10);
		if (this.usage.dailyApiDate !== today) {
			this.usage.dailyApiCalls = 0;
			this.usage.dailyApiDate = today;
			this.warningsEmitted.delete("daily_api");
		}

		const thisMonth = new Date().toISOString().slice(0, 7);
		if (this.usage.monthlyInvoiceDate !== thisMonth) {
			this.usage.monthlyInvoices = 0;
			this.usage.monthlyInvoiceDate = thisMonth;
		}

		const thisYear = new Date().getFullYear();
		if (this.yearlyInvoiceYear !== thisYear) {
			this.yearlyInvoices = 0;
			this.yearlyInvoiceYear = thisYear;
			this.warningsEmitted.delete("yearly_invoice");
		}
	}

	private trackApiCall() {
		this.rolloverCounters();
		this.usage.dailyApiCalls++;

		const pct = this.usage.dailyApiCalls / LIMITS.dailyApiCalls;

		if (pct >= 1) {
			logger.error(
				{ calls: this.usage.dailyApiCalls, limit: LIMITS.dailyApiCalls },
				"Zoho daily API limit REACHED — requests will be rejected",
			);
		} else if (pct >= LIMITS.dailyApiWarnPct && !this.warningsEmitted.has("daily_api")) {
			this.warningsEmitted.add("daily_api");
			logger.warn(
				{ calls: this.usage.dailyApiCalls, limit: LIMITS.dailyApiCalls, percent: Math.round(pct * 100) },
				"Approaching Zoho daily API call limit",
			);
		}
	}

	private trackInvoiceCreated() {
		this.rolloverCounters();
		this.usage.monthlyInvoices++;
		this.yearlyInvoices++;

		const pct = this.yearlyInvoices / LIMITS.yearlyInvoices;

		if (pct >= 1) {
			logger.error(
				{ invoices: this.yearlyInvoices, limit: LIMITS.yearlyInvoices },
				"Zoho yearly invoice limit REACHED — new invoices will be rejected",
			);
		} else if (pct >= LIMITS.yearlyInvoiceWarnPct && !this.warningsEmitted.has("yearly_invoice")) {
			this.warningsEmitted.add("yearly_invoice");
			logger.warn(
				{ invoices: this.yearlyInvoices, limit: LIMITS.yearlyInvoices, percent: Math.round(pct * 100) },
				"Approaching Zoho yearly invoice limit",
			);
		}
	}

	private getConfig() {
		const row = db.select().from(zohoConfig).where(eq(zohoConfig.id, 1)).get();
		if (!row) {
			throw new Error("Zoho Books is not configured. Run the setup wizard first.");
		}
		return row;
	}

	private async refreshAccessToken(): Promise<ZohoTokens> {
		const cfg = this.getConfig();

		// Determine the accounts URL from the API domain
		const accountsUrl = cfg.apiDomain.replace("www.zohoapis", "accounts.zoho");
		const tokenUrl = `${accountsUrl}/oauth/v2/token`;

		const params = new URLSearchParams({
			refresh_token: cfg.refreshToken,
			client_id: cfg.clientId,
			client_secret: cfg.clientSecret,
			grant_type: "refresh_token",
		});

		const response = await fetch(tokenUrl, {
			method: "POST",
			body: params,
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Failed to refresh Zoho token: ${response.status} ${text}`);
		}

		const data = (await response.json()) as {
			access_token: string;
			expires_in: number;
			error?: string;
		};

		if (data.error) {
			throw new Error(`Zoho token refresh error: ${data.error}`);
		}

		const expiresAt = new Date(Date.now() + data.expires_in * 1000);

		// Store in DB
		db.update(zohoConfig)
			.set({
				accessToken: data.access_token,
				accessTokenExpiresAt: expiresAt.toISOString(),
				updatedAt: new Date().toISOString(),
			})
			.where(eq(zohoConfig.id, 1))
			.run();

		this.accessToken = data.access_token;
		this.accessTokenExpiresAt = expiresAt;

		logger.debug("Zoho access token refreshed");

		return { accessToken: data.access_token, expiresAt };
	}

	private async getAccessToken(): Promise<string> {
		// Check in-memory cache first
		if (this.accessToken && this.accessTokenExpiresAt) {
			const bufferMs = 5 * 60 * 1000; // 5 min buffer
			if (this.accessTokenExpiresAt.getTime() - bufferMs > Date.now()) {
				return this.accessToken;
			}
		}

		// Check DB cache
		const cfg = this.getConfig();
		if (cfg.accessToken && cfg.accessTokenExpiresAt) {
			const expiresAt = new Date(cfg.accessTokenExpiresAt);
			const bufferMs = 5 * 60 * 1000;
			if (expiresAt.getTime() - bufferMs > Date.now()) {
				this.accessToken = cfg.accessToken;
				this.accessTokenExpiresAt = expiresAt;
				return cfg.accessToken;
			}
		}

		// Refresh
		const tokens = await this.refreshAccessToken();
		return tokens.accessToken;
	}

	private async rateLimit(): Promise<void> {
		const now = Date.now();
		const elapsed = now - this.lastRequestTime;
		if (elapsed < this.minRequestInterval) {
			await new Promise((resolve) =>
				setTimeout(resolve, this.minRequestInterval - elapsed),
			);
		}
		this.lastRequestTime = Date.now();
	}

	async request<T = ZohoApiResponse>(
		method: string,
		path: string,
		body?: Record<string, unknown>,
	): Promise<T> {
		await this.rateLimit();

		const cfg = this.getConfig();
		const token = await this.getAccessToken();
		const url = `${cfg.apiDomain}/books/v3${path}${path.includes("?") ? "&" : "?"}organization_id=${cfg.organizationId}`;

		const headers: Record<string, string> = {
			Authorization: `Zoho-oauthtoken ${token}`,
			"Content-Type": "application/json",
		};

		const options: RequestInit = { method, headers };
		if (body && (method === "POST" || method === "PUT")) {
			options.body = JSON.stringify(body);
		}

		this.trackApiCall();
		logger.debug({ method, path }, "Zoho API request");

		const response = await fetch(url, options);
		const data = (await response.json()) as T;

		if (!response.ok) {
			const apiData = data as unknown as ZohoApiResponse;
			throw new Error(
				`Zoho API error: ${response.status} - ${apiData.message || JSON.stringify(data)}`,
			);
		}

		return data;
	}

	// Contacts
	async createContact(contact: {
		contact_name: string;
		email?: string;
		company_name?: string;
		contact_type?: string;
		notes?: string;
	}) {
		return this.request<ZohoApiResponse & { contact: { contact_id: string } }>(
			"POST",
			"/contacts",
			contact,
		);
	}

	async updateContact(
		contactId: string,
		contact: Record<string, unknown>,
	) {
		return this.request("PUT", `/contacts/${contactId}`, contact);
	}

	async markContactInactive(contactId: string) {
		return this.request("POST", `/contacts/${contactId}/inactive`);
	}

	// Invoices
	async createInvoice(invoice: {
		customer_id: string;
		invoice_number?: string;
		reference_number?: string;
		date?: string;
		line_items: Array<{
			name: string;
			description?: string;
			rate: number;
			quantity: number;
		}>;
		notes?: string;
	}) {
		const result = await this.request<ZohoApiResponse & { invoice: { invoice_id: string } }>(
			"POST",
			"/invoices",
			invoice,
		);
		this.trackInvoiceCreated();
		return result;
	}

	async updateInvoice(
		invoiceId: string,
		invoice: Record<string, unknown>,
	) {
		return this.request("PUT", `/invoices/${invoiceId}`, invoice);
	}

	// Payments
	async createPayment(payment: {
		customer_id: string;
		payment_mode?: string;
		amount: number;
		date: string;
		reference_number?: string;
		invoices?: Array<{
			invoice_id: string;
			amount_applied: number;
		}>;
	}) {
		return this.request<
			ZohoApiResponse & { payment: { payment_id: string } }
		>("POST", "/customerpayments", payment);
	}

	// Credit Notes
	async createCreditNote(creditNote: {
		customer_id: string;
		creditnote_number?: string;
		reference_number?: string;
		date?: string;
		line_items: Array<{
			name: string;
			description?: string;
			rate: number;
			quantity: number;
		}>;
	}) {
		return this.request<
			ZohoApiResponse & { creditnote: { creditnote_id: string } }
		>("POST", "/creditnotes", creditNote);
	}

	async applyCreditNoteToInvoice(
		creditNoteId: string,
		invoices: Array<{ invoice_id: string; amount_applied: number }>,
	) {
		return this.request("POST", `/creditnotes/${creditNoteId}/invoices`, {
			invoices,
		});
	}

	// Journals
	async createJournal(journal: {
		journal_date: string;
		reference_number?: string;
		notes?: string;
		line_items: Array<{
			account_id: string;
			debit_or_credit: "debit" | "credit";
			amount: number;
			description?: string;
		}>;
	}) {
		return this.request<
			ZohoApiResponse & { journal: { journal_id: string } }
		>("POST", "/journals", journal);
	}

	// Bank Transactions
	async createBankTransaction(transaction: {
		from_account_id?: string;
		to_account_id?: string;
		account_id?: string;
		transaction_type: string;
		amount: number;
		date: string;
		reference_number?: string;
		description?: string;
		customer_id?: string;
	}) {
		return this.request<
			ZohoApiResponse & { banktransaction: { transaction_id: string } }
		>("POST", "/banktransactions", transaction);
	}

	async createExpense(expense: {
		account_id?: string;
		paid_through_account_id: string;
		date: string;
		amount: number;
		reference_number?: string;
		description?: string;
	}) {
		return this.request<
			ZohoApiResponse & { expense: { expense_id: string } }
		>("POST", "/expenses", expense);
	}

	async getBankTransaction(transactionId: string) {
		return this.request<ZohoApiResponse & { banktransaction: Record<string, unknown> }>(
			"GET", `/banktransactions/${transactionId}`,
		);
	}

	async updateBankTransaction(transactionId: string, data: Record<string, unknown>) {
		return this.request<
			ZohoApiResponse & { banktransaction: { transaction_id: string } }
		>("PUT", `/banktransactions/${transactionId}`, data);
	}

	async updateExpense(expenseId: string, data: {
		reference_number?: string;
		description?: string;
	}) {
		return this.request<ZohoApiResponse>(
			"PUT", `/expenses/${expenseId}`, data,
		);
	}

	// Recurring Invoices
	async createRecurringInvoice(recurringInvoice: {
		customer_id: string;
		recurrence_name: string;
		recurrence_frequency:
			| "days"
			| "weeks"
			| "months"
			| "years";
		repeat_every: number;
		start_date: string;
		end_date?: string;
		line_items: Array<{
			name: string;
			rate: number;
			quantity: number;
		}>;
	}) {
		return this.request<
			ZohoApiResponse & {
				recurring_invoice: { recurring_invoice_id: string };
			}
		>("POST", "/recurringinvoices", recurringInvoice);
	}

	async stopRecurringInvoice(recurringInvoiceId: string) {
		return this.request(
			"POST",
			`/recurringinvoices/${recurringInvoiceId}/status/stop`,
		);
	}

	// Search / List methods for duplicate detection

	async searchBankTransactions(accountId: string, date?: string) {
		let path = `/banktransactions?account_id=${accountId}`;
		if (date) path += `&date=${date}`;
		return this.request<ZohoApiResponse & {
			banktransactions: Array<{
				transaction_id: string;
				date: string;
				amount: number;
				transaction_type: string;
				reference_number: string;
				description: string;
			}>;
		}>("GET", path);
	}

	async searchInvoices(referenceNumber: string) {
		return this.request<ZohoApiResponse & {
			invoices: Array<{
				invoice_id: string;
				invoice_number: string;
				reference_number: string;
				date: string;
				total: number;
			}>;
		}>("GET", `/invoices?reference_number=${encodeURIComponent(referenceNumber)}`);
	}

	async listInvoices(dateFrom?: string, dateTo?: string) {
		let path = "/invoices?per_page=200";
		if (dateFrom) path += `&date_start=${dateFrom}`;
		if (dateTo) path += `&date_end=${dateTo}`;
		const result = await this.request<ZohoApiResponse & {
			invoices: Array<{
				invoice_id: string;
				invoice_number: string;
				reference_number: string;
				customer_name: string;
				date: string;
				total: number;
			}>;
		}>("GET", path);
		return result;
	}

	async searchContacts(email: string) {
		return this.request<ZohoApiResponse & {
			contacts: Array<{
				contact_id: string;
				contact_name: string;
				email: string;
			}>;
		}>("GET", `/contacts?email=${encodeURIComponent(email)}`);
	}

	async searchPayments(referenceNumber: string) {
		return this.request<ZohoApiResponse & {
			customerpayments: Array<{
				payment_id: string;
				reference_number: string;
				date: string;
				amount: number;
			}>;
		}>("GET", `/customerpayments?reference_number=${encodeURIComponent(referenceNumber)}`);
	}

	async listBankTransactionsByAccount(accountId: string, dateFrom?: string, dateTo?: string) {
		let path = `/banktransactions?account_id=${accountId}`;
		if (dateFrom) path += `&date_start=${dateFrom}`;
		if (dateTo) path += `&date_end=${dateTo}`;
		path += "&per_page=200";
		return this.request<ZohoApiResponse & {
			banktransactions: Array<{
				transaction_id: string;
				date: string;
				amount: number;
				transaction_type: string;
				reference_number: string;
				description: string;
			}>;
		}>("GET", path);
	}
}

export const zoho = new ZohoClient();

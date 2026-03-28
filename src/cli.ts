import { input, password, confirm } from "@inquirer/prompts";
import { writeFileSync, existsSync } from "node:fs";
import crypto from "node:crypto";

async function setup() {
	console.log("\n  stripe2zohobooks — Setup Wizard\n");
	console.log("  This will create a .env file with your configuration.\n");

	if (existsSync(".env")) {
		const overwrite = await confirm({
			message: ".env file already exists. Overwrite?",
			default: false,
		});
		if (!overwrite) {
			console.log("Setup cancelled.");
			process.exit(0);
		}
	}

	// Admin password
	const adminPassword = await password({
		message: "Set an admin password for the dashboard:",
		validate: (v) => (v.length >= 6 ? true : "Must be at least 6 characters"),
	});

	// Zoho OAuth
	console.log("\n  Zoho Books OAuth Configuration");
	console.log("  Create a Self Client at https://api-console.zoho.com/\n");

	const zohoClientId = await input({
		message: "Zoho Client ID:",
	});

	const zohoClientSecret = await password({
		message: "Zoho Client Secret:",
	});

	const zohoRefreshToken = await password({
		message: "Zoho Refresh Token:",
	});

	const zohoOrgId = await input({
		message: "Zoho Organization ID:",
	});

	const zohoApiDomain = await input({
		message: "Zoho API Domain:",
		default: "https://www.zohoapis.com",
	});

	// Generate encryption key
	const encryptionKey = crypto.randomBytes(32).toString("hex");

	const port = await input({
		message: "Server port:",
		default: "3000",
	});

	const envContent = `# Server
PORT=${port}
HOST=0.0.0.0
LOG_LEVEL=info

# Database
DATABASE_PATH=./data/stripe2zoho.db

# Security
ADMIN_PASSWORD=${adminPassword}
ENCRYPTION_KEY=${encryptionKey}

# Zoho OAuth
ZOHO_CLIENT_ID=${zohoClientId}
ZOHO_CLIENT_SECRET=${zohoClientSecret}
ZOHO_REFRESH_TOKEN=${zohoRefreshToken}
ZOHO_ORGANIZATION_ID=${zohoOrgId}
ZOHO_API_DOMAIN=${zohoApiDomain}
`;

	writeFileSync(".env", envContent);
	console.log("\n  .env file created successfully!");
	console.log("  Run 'pnpm dev' to start the server.\n");
	console.log("  Next steps:");
	console.log("  1. Start the server: pnpm dev");
	console.log("  2. Open http://localhost:" + port + "/dashboard");
	console.log("  3. Add your Stripe accounts in the dashboard");
	console.log(
		"  4. Configure Stripe webhooks to point to: http://your-domain/webhooks/stripe/<account_id>\n",
	);
}

setup().catch((err) => {
	console.error("Setup failed:", err);
	process.exit(1);
});

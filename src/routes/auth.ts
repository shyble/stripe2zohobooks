import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { config } from "../config.js";
import { layout } from "../views/layout.js";
import crypto from "node:crypto";

const authRouter = new Hono();

const SESSION_COOKIE = "s2zb_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

function hashPassword(password: string): string {
	return crypto.createHash("sha256").update(password).digest("hex");
}

const validSessionHash = hashPassword(config.adminPassword);

// Login page
authRouter.get("/login", (c) => {
	const html = layout(
		"Login",
		`
		<div style="max-width:400px;margin:3rem auto">
			<h3>Login</h3>
			<form method="POST" action="/dashboard/login">
				<label>
					Password
					<input type="password" name="password" required autofocus>
				</label>
				<button type="submit">Login</button>
			</form>
		</div>
	`,
	);
	return c.html(html);
});

authRouter.post("/login", async (c) => {
	const body = await c.req.parseBody();
	const password = body.password as string;

	if (hashPassword(password) === validSessionHash) {
		const sessionToken = crypto.randomBytes(32).toString("hex");
		// Store hash of session token as cookie
		setCookie(c, SESSION_COOKIE, sessionToken, {
			httpOnly: true,
			sameSite: "Lax",
			maxAge: SESSION_MAX_AGE,
			path: "/",
		});
		// In a real app, store session server-side. For simplicity,
		// we validate by re-checking the password hash.
		setCookie(c, "s2zb_auth", validSessionHash, {
			httpOnly: true,
			sameSite: "Lax",
			maxAge: SESSION_MAX_AGE,
			path: "/",
		});
		return c.redirect("/dashboard");
	}

	const html = layout(
		"Login",
		`
		<div style="max-width:400px;margin:3rem auto">
			<h3>Login</h3>
			<p style="color:var(--pico-del-color)">Invalid password</p>
			<form method="POST" action="/dashboard/login">
				<label>
					Password
					<input type="password" name="password" required autofocus>
				</label>
				<button type="submit">Login</button>
			</form>
		</div>
	`,
	);
	return c.html(html, 401);
});

// Auth middleware for dashboard routes
export function requireAuth() {
	return async (c: any, next: any) => {
		// Skip auth for login routes
		const path = new URL(c.req.url).pathname;
		if (path === "/dashboard/login") {
			return next();
		}

		const authCookie = getCookie(c, "s2zb_auth");
		if (authCookie !== validSessionHash) {
			return c.redirect("/dashboard/login");
		}

		return next();
	};
}

export { authRouter };

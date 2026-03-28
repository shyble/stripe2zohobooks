import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";
import { apiRouter } from "./routes/api.js";
import { webhookRouter } from "./routes/webhooks.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { authRouter, requireAuth } from "./routes/auth.js";

const app = new Hono();

app.use("*", honoLogger());

// Webhook routes (no auth — Stripe verifies via signature)
app.route("/webhooks", webhookRouter);

// API routes
app.route("/api", apiRouter);

// Dashboard routes (with auth)
app.use("/dashboard/*", requireAuth());
app.route("/dashboard", authRouter);
app.route("/dashboard", dashboardRouter);

// Redirect root to dashboard
app.get("/", (c) => c.redirect("/dashboard"));

export { app };

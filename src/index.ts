import { Hono } from "hono";

const app = new Hono();

// Owner gate middleware
const ownerGate = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const ownerKey = c.req.header("X-Owner-Key");

  if (ownerKey !== "1604" && !authHeader?.includes("1604")) {
    return c.json({ error: "Unauthorized: owner_key 1604 required" }, 401);
  }

  await next();
};

// Session store (in-memory for now; use Redis for production)
const sessions = new Map();

// Health check
app.get("/health", (c) => c.json({ status: "ok", type: "playwright-service" }));

// POST /session — create a new browser session
app.post("/session", ownerGate, async (c) => {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext();
    const page = await context.newPage();

    const sessionId = Math.random().toString(36).substring(7);
    sessions.set(sessionId, { browser, context, page });

    return c.json({ sessionId, status: "created" });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to create session", details: error.message }, 500);
  }
});

// POST /navigate — navigate to URL
app.post("/navigate", ownerGate, async (c) => {
  try {
    const { sessionId, url } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    await session.page.goto(url);
    return c.json({ status: "navigated", url });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to navigate", details: error.message }, 500);
  }
});

// POST /screenshot — take screenshot
app.post("/screenshot", ownerGate, async (c) => {
  try {
    const { sessionId } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    const buffer = await session.page.screenshot({ type: "png" });
    const base64 = buffer.toString("base64");
    return c.json({ status: "screenshot", data: base64 });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to take screenshot", details: error.message }, 500);
  }
});

// POST /screenshot-4k — take 4K screenshot
app.post("/screenshot-4k", ownerGate, async (c) => {
  try {
    const { sessionId } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    await session.page.setViewportSize({ width: 3840, height: 2160 });
    const buffer = await session.page.screenshot({ type: "png" });
    const base64 = buffer.toString("base64");
    return c.json({ status: "screenshot-4k", data: base64 });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to take 4K screenshot", details: error.message }, 500);
  }
});

// POST /fill — fill form field
app.post("/fill", ownerGate, async (c) => {
  try {
    const { sessionId, selector, value } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    await session.page.fill(selector, value);
    return c.json({ status: "filled", selector, value });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to fill", details: error.message }, 500);
  }
});

// POST /click — click element
app.post("/click", ownerGate, async (c) => {
  try {
    const { sessionId, selector } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    await session.page.click(selector);
    return c.json({ status: "clicked", selector });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to click", details: error.message }, 500);
  }
});

// POST /submit — submit form
app.post("/submit", ownerGate, async (c) => {
  try {
    const { sessionId, selector } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    await session.page.click(selector);
    await session.page.waitForNavigation({ timeout: 5000 }).catch(() => {});
    return c.json({ status: "submitted", selector });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to submit", details: error.message }, 500);
  }
});

// POST /scrape — scrape page content
app.post("/scrape", ownerGate, async (c) => {
  try {
    const { sessionId, selector } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    const content = await session.page.locator(selector).textContent();
    return c.json({ status: "scraped", selector, content });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to scrape", details: error.message }, 500);
  }
});

// POST /screencast — start screencast (video recording)
app.post("/screencast", ownerGate, async (c) => {
  try {
    const { sessionId } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    // Screencast would require video codec setup; placeholder for now
    return c.json({ status: "screencast-started", sessionId });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to start screencast", details: error.message }, 500);
  }
});

// DELETE /session — close session
app.delete("/session", ownerGate, async (c) => {
  try {
    const { sessionId } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    await session.browser.close();
    sessions.delete(sessionId);
    return c.json({ status: "closed", sessionId });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to close session", details: error.message }, 500);
  }
});

// Start server
const port = Number(process.env.PORT) || 3000;
Bun.serve({
  hostname: "::",
  port,
  fetch: app.fetch,
});

console.log(`[PLAYWRIGHT-SERVICE] Listening on port ${port}`);

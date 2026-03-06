import { Hono } from "hono";
import { logger } from "../../logger.js";
import type { IngressMessage } from "../../types.js";
import type { MercuryCoreRuntime } from "../runtime.js";

export function createChatRoute(core: MercuryCoreRuntime): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.text !== "string" || !body.text.trim()) {
      return c.json({ error: "Missing or empty 'text' field" }, 400);
    }

    const callerId =
      typeof body.callerId === "string" && body.callerId.trim()
        ? body.callerId.trim()
        : "api:anonymous";

    const groupId =
      typeof body.groupId === "string" && body.groupId.trim()
        ? body.groupId.trim()
        : `api:${callerId}`;

    const authorName =
      typeof body.authorName === "string" ? body.authorName.trim() : undefined;

    const ingress: IngressMessage = {
      platform: "api",
      groupId,
      callerId,
      authorName,
      text: body.text.trim(),
      isDM: true,
      isReplyToBot: true,
      attachments: [],
    };

    logger.info("API chat inbound", {
      callerId,
      groupId,
      preview: ingress.text.slice(0, 80),
    });

    const result = await core.handleRawInput(ingress, "cli");

    if (result.type === "ignore") {
      return c.json({ reply: "", files: [] });
    }

    if (result.type === "denied") {
      return c.json({ error: result.reason }, 403);
    }

    const reply = result.result?.reply ?? "";
    const files = result.result?.files ?? [];

    logger.info("API chat outbound", {
      groupId,
      preview: reply.slice(0, 80),
      fileCount: files.length,
    });

    return c.json({ reply, files });
  });

  return app;
}

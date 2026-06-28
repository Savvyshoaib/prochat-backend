import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import pdfParse from "pdf-parse";
import { db } from "@/db";
import { bots } from "@/db/schema/bots";
import { authenticate } from "@/middleware/authenticate";
import { ok, fail } from "@/utils/response";
import { crawlWebsite, parseDepthSetting } from "./crawler";

const SUPPORTED_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/csv": "csv",
};

const SUPPORTED_EXTENSIONS = [".pdf", ".txt", ".md", ".csv", ".text"];

async function extractText(buffer: Buffer, filename: string, mimetype: string): Promise<string> {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();

  if (mimetype === "application/pdf" || ext === ".pdf") {
    const result = await pdfParse(buffer);
    return result.text.trim();
  }

  if (
    SUPPORTED_TYPES[mimetype] ||
    [".txt", ".md", ".csv", ".text"].includes(ext)
  ) {
    return buffer.toString("utf-8").trim();
  }

  throw new Error(`Unsupported file type: ${filename}. Supported: PDF, TXT, MD, CSV`);
}

export async function knowledgeRoutes(app: FastifyInstance) {
  // POST /api/bots/:botId/knowledge/upload
  // Parses PDF/TXT/CSV and appends extracted text to bot's knowledgeText
  app.post(
    "/api/bots/:botId/knowledge/upload",
    { preHandler: authenticate },
    async (request, reply) => {
      const { botId } = request.params as { botId: string };

      // Verify ownership
      const [bot] = await db
        .select()
        .from(bots)
        .where(eq(bots.id, botId))
        .limit(1);

      if (!bot) return reply.status(404).send(fail("Bot not found"));
      if (bot.userId !== request.user.id) return reply.status(403).send(fail("Forbidden"));

      // Read uploaded file
      const file = await request.file({
        limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
      });

      if (!file) return reply.status(400).send(fail("No file uploaded"));

      const buffer = await file.toBuffer();
      const filename = file.filename;
      const mimetype = file.mimetype;
      const sizeKB = (buffer.length / 1024).toFixed(1);

      let extractedText: string;
      try {
        extractedText = await extractText(buffer, filename, mimetype);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to parse file";
        return reply.status(400).send(fail(msg));
      }

      if (!extractedText) {
        return reply.status(400).send(fail("File appears to be empty or could not be parsed"));
      }

      // Append to existing knowledge (with file header for context)
      const separator = `\n\n--- Source: ${filename} ---\n`;
      const newKnowledgeText = bot.knowledgeText
        ? `${bot.knowledgeText}${separator}${extractedText}`
        : `${separator.trimStart()}${extractedText}`;

      // Add to knowledgeFiles list
      const existingFiles = Array.isArray(bot.knowledgeFiles) ? bot.knowledgeFiles : [];
      const updatedFiles = [
        ...existingFiles.filter((f) => f.name !== filename), // replace if same name
        { name: filename, size: `${sizeKB} KB` },
      ];

      await db
        .update(bots)
        .set({
          knowledgeText: newKnowledgeText,
          knowledgeFiles: updatedFiles,
          updatedAt: new Date(),
        })
        .where(eq(bots.id, botId));

      return reply.send(
        ok({
          filename,
          size: `${sizeKB} KB`,
          extractedChars: extractedText.length,
          totalKnowledgeChars: newKnowledgeText.length,
          message: `${filename} parsed and added to knowledge base`,
        })
      );
    }
  );

  // POST /api/bots/:botId/knowledge/crawl — SSE streaming crawl
  app.post(
    "/api/bots/:botId/knowledge/crawl",
    { preHandler: authenticate },
    async (request, reply) => {
      const { botId } = request.params as { botId: string };

      const bodySchema = z.object({
        url: z.string().url("Please enter a valid URL (include https://)"),
        depth: z.string().default("3 levels (recommended)"),
      });

      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send(fail(parsed.error.errors[0]?.message ?? "Invalid request"));
      }

      const { url, depth } = parsed.data;

      const [bot] = await db.select().from(bots).where(eq(bots.id, botId)).limit(1);
      if (!bot) return reply.status(404).send(fail("Bot not found"));
      if (bot.userId !== request.user.id) return reply.status(403).send(fail("Forbidden"));

      const { maxDepth, maxPages } = parseDepthSetting(depth);

      // Setup SSE for real-time progress
      const res = reply.raw;
      const origin = request.headers.origin ?? "*";

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
      });
      reply.hijack();

      const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

      send({ status: "starting", message: `Starting crawl of ${url}` });

      try {
        const result = await crawlWebsite(url, {
          maxDepth,
          maxPages,
          onPage: (pageUrl, _pageText, count) => {
            send({ status: "crawling", url: pageUrl, pagesCount: count });
          },
        });

        if (!result.text) {
          send({ status: "error", error: "No content found — make sure the URL is publicly accessible" });
          res.end();
          return;
        }

        // Append crawled content to knowledge base
        const header = `--- Website: ${url} (${result.pagesCount} pages crawled) ---\n`;
        const newKnowledgeText = bot.knowledgeText
          ? `${bot.knowledgeText}\n\n${header}${result.text}`
          : `${header}${result.text}`;

        // Add to knowledgeFiles list — store type + url so we can delete correctly
        const existingFiles = Array.isArray(bot.knowledgeFiles) ? bot.knowledgeFiles : [];
        const domain = new URL(url).hostname;
        const updatedFiles = [
          ...existingFiles.filter((f) => (f as { url?: string }).url !== url && f.name !== domain),
          {
            name: domain,
            size: `${result.pagesCount} pages · ${(result.text.length / 1024).toFixed(0)} KB`,
            type: "website" as const,
            url,
          },
        ];

        await db.update(bots).set({
          knowledgeText: newKnowledgeText,
          knowledgeFiles: updatedFiles,
          websiteUrl: url,
          updatedAt: new Date(),
        }).where(eq(bots.id, botId));

        send({
          status: "done",
          pagesCount: result.pagesCount,
          extractedChars: result.text.length,
          errors: result.errors.length,
          message: `Successfully crawled ${result.pagesCount} pages`,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Crawl failed";
        send({ status: "error", error: msg });
      } finally {
        res.end();
      }
    }
  );

  // DELETE /api/bots/:botId/knowledge/file?name=xxx
  // Removes a file or website from the knowledge base (knowledgeText + knowledgeFiles)
  app.delete(
    "/api/bots/:botId/knowledge/file",
    { preHandler: authenticate },
    async (request, reply) => {
      const { botId } = request.params as { botId: string };
      // `name` = filename or domain; `url` = full website url (for websites)
      const { name, url } = request.query as { name?: string; url?: string };

      if (!name && !url) {
        return reply.status(400).send(fail("Provide name or url query param"));
      }

      const [bot] = await db.select().from(bots).where(eq(bots.id, botId)).limit(1);
      if (!bot) return reply.status(404).send(fail("Bot not found"));
      if (bot.userId !== request.user.id) return reply.status(403).send(fail("Forbidden"));

      type KF = { name: string; size: string; type?: string; url?: string };
      const existingFiles = (Array.isArray(bot.knowledgeFiles) ? bot.knowledgeFiles : []) as KF[];

      // Find the entry to delete
      const entry = url
        ? existingFiles.find((f) => f.url === url)
        : existingFiles.find((f) => f.name === name);

      if (!entry) {
        return reply.status(404).send(fail("Knowledge source not found"));
      }

      let text = bot.knowledgeText ?? "";

      if (entry.type === "website" && entry.url) {
        // Website section header format: "--- Website: <url> (<n> pages crawled) ---"
        const headerPrefix = `--- Website: ${entry.url}`;
        const idx = text.indexOf(headerPrefix);
        if (idx !== -1) {
          // Find next section (any "---" header) after this one
          const nextIdx = text.indexOf("\n--- ", idx + headerPrefix.length);
          text = nextIdx !== -1
            ? text.slice(0, idx) + text.slice(nextIdx + 1)
            : text.slice(0, idx);
        }
      } else {
        // File section header format: "--- Source: <filename> ---"
        const headerPrefix = `--- Source: ${entry.name} ---`;
        const idx = text.indexOf(headerPrefix);
        if (idx !== -1) {
          const nextIdx = text.indexOf("\n--- ", idx + headerPrefix.length);
          text = nextIdx !== -1
            ? text.slice(0, idx) + text.slice(nextIdx + 1)
            : text.slice(0, idx);
        }
      }

      text = text.trim();

      const updatedFiles = existingFiles.filter((f) =>
        url ? f.url !== url : f.name !== name
      );

      await db.update(bots).set({
        knowledgeText: text,
        knowledgeFiles: updatedFiles,
        updatedAt: new Date(),
      }).where(eq(bots.id, botId));

      return reply.send(ok({ message: `${entry.name} removed from knowledge base` }));
    }
  );
}

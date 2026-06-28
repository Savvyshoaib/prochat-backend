import * as cheerio from "cheerio";

export interface CrawlOptions {
  maxDepth: number;
  maxPages: number;
  onPage?: (url: string, text: string, pagesCount: number) => void;
}

export interface CrawlResult {
  text: string;
  pagesCount: number;
  urls: string[];
  errors: string[];
}

const DEPTH_MAP: Record<string, { maxDepth: number; maxPages: number }> = {
  "1 level (homepage only)": { maxDepth: 0, maxPages: 1 },
  "2 levels": { maxDepth: 1, maxPages: 25 },
  "3 levels (recommended)": { maxDepth: 2, maxPages: 60 },
  "Entire site": { maxDepth: 3, maxPages: 120 },
};

export function parseDepthSetting(depth: string): { maxDepth: number; maxPages: number } {
  return DEPTH_MAP[depth] ?? { maxDepth: 2, maxPages: 60 };
}

// Tags whose content we fully discard
/** Remove unusual/invisible Unicode characters that pollute knowledge text */
function cleanText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")      // Windows CRLF
    .replace(/\r/g, "\n")        // Old Mac CR
    .replace(/\u2028/g, "\n")    // Unicode Line Separator
    .replace(/\u2029/g, "\n\n")  // Unicode Paragraph Separator
    .replace(/\u00a0/g, " ")     // Non-breaking space → regular space
    .replace(/\u200b/g, "")      // Zero-width space
    .replace(/\u200c/g, "")      // Zero-width non-joiner
    .replace(/\u200d/g, "")      // Zero-width joiner
    .replace(/\ufeff/g, "")      // BOM / zero-width no-break space
    .replace(/\u0000/g, "")      // Null character
    .replace(/[ \t]+/g, " ")     // Multiple spaces/tabs → single space
    .replace(/\n{3,}/g, "\n\n")  // Max 2 consecutive newlines
    .trim();
}

const SKIP_TAGS = [
  "script", "style", "noscript", "iframe", "svg",
  "nav", "footer", "header", "aside",
  "form", "button", "select", "option",
  "[aria-hidden='true']", ".cookie-banner", ".ads", "#cookie",
];

function extractText(html: string): string {
  const $ = cheerio.load(html);

  // Remove noise elements
  $(SKIP_TAGS.join(", ")).remove();

  // Prefer main content area if available
  const mainEl =
    $("main").first() ||
    $("article").first() ||
    $('[role="main"]').first() ||
    $(".content, .main-content, #content, #main").first();

  const root = mainEl.length ? mainEl : $("body");

  return cleanText(root.text());
}

function normalizeUrl(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    // Remove fragment + trailing slash to deduplicate
    url.hash = "";
    const raw = url.href;
    return raw.endsWith("/") ? raw.slice(0, -1) : raw;
  } catch {
    return null;
  }
}

function extractLinks($: cheerio.CheerioAPI, baseUrl: string, origin: string): string[] {
  const links: string[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("#")) return;
    const abs = normalizeUrl(href, baseUrl);
    if (abs && abs.startsWith(origin)) links.push(abs);
  });
  return links;
}

export async function crawlWebsite(
  startUrl: string,
  options: CrawlOptions
): Promise<CrawlResult> {
  const { maxDepth, maxPages, onPage } = options;
  const origin = new URL(startUrl).origin;

  const visited = new Set<string>();
  const errors: string[] = [];
  let allText = "";

  // Queue: [url, depth]
  const queue: [string, number][] = [[normalizeUrl(startUrl, startUrl) ?? startUrl, 0]];

  while (queue.length > 0 && visited.size < maxPages) {
    const [url, depth] = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; HelixAI-Crawler/1.0; +https://helixai.com/bot)",
          Accept: "text/html,application/xhtml+xml",
        },
        signal: AbortSignal.timeout(12_000), // 12s per page
        redirect: "follow",
      });

      if (!res.ok) {
        errors.push(`${url}: HTTP ${res.status}`);
        continue;
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html")) continue;

      const html = await res.text();
      const $ = cheerio.load(html);
      const title = $("title").text().trim();
      const pageText = extractText(html);

      if (pageText) {
        const section = `\n\n=== ${title ? title + " — " : ""}${url} ===\n${pageText}`;
        allText += section;
        onPage?.(url, pageText, visited.size);
      }

      // Queue child links
      if (depth < maxDepth) {
        const links = extractLinks($, url, origin);
        for (const link of links) {
          if (!visited.has(link) && queue.length < maxPages * 3) {
            queue.push([link, depth + 1]);
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${url}: ${msg}`);
    }
  }

  return {
    text: cleanText(allText),
    pagesCount: visited.size,
    urls: [...visited],
    errors,
  };
}

import { Hono } from "hono";
import { parseHTML } from "linkedom";
import {
  fetchYouTubeOEmbed,
  type YouTubeOEmbed,
  youtubeWatchUrl,
} from "./youtube";

// Polyfill global document/DOMParser for defuddle/turndown in workerd (Cloudflare Workers)
// Must run before defuddle is imported, because turndown's canParseHTMLNatively runs at module load
if (typeof (globalThis as any).document === "undefined") {
  try {
    const win: any = parseHTML(
      "<!DOCTYPE html><html><head></head><body></body></html>",
    );
    const doc = win.document ?? win;
    (globalThis as any).document = doc;
    (globalThis as any).window = win;
    if (win.DOMParser) (globalThis as any).DOMParser = win.DOMParser;
    if (win.Node) (globalThis as any).Node = win.Node;
    if (win.Element) (globalThis as any).Element = win.Element;
    if (win.HTMLElement) (globalThis as any).HTMLElement = win.HTMLElement;
    if (win.NodeFilter) (globalThis as any).NodeFilter = win.NodeFilter;
    if (win.Text) (globalThis as any).Text = win.Text;
    // Ensure document.implementation exists for turndown fallback
    if (!doc.implementation) {
      // linkedom's document should have implementation via defaultView, but ensure it exists
      // Create a minimal stub if missing
      (doc as any).implementation = {
        createHTMLDocument: (title: string) => {
          const w: any = parseHTML(
            `<!DOCTYPE html><html><head><title>${title}</title></head><body></body></html>`,
          );
          return w.document;
        },
      };
    }
  } catch {}
}

type Bindings = {
  BROWSER: BrowserRun;
  // Cloudflare account ID + Browser Run API token. Together they unlock the
  // REST Quick Action path, which is currently the only way to pick a
  // non-default engine (kitesurf); the binding's quickAction() cannot.
  CF_ACCOUNT_ID?: string;
  BROWSER_API_TOKEN?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  // X-Renderer/X-Renderer-Chain are not CORS-safelisted response headers, so a
  // browser's fetch() cannot read them cross-origin unless they are exposed
  // here — which is the only way they are useful to a caller.
  "Access-Control-Expose-Headers": "X-Renderer, X-Renderer-Chain",
  "Access-Control-Max-Age": "86400",
} as const;

function withCors(
  headers: Record<string, string> = {},
): Record<string, string> {
  return { ...corsHeaders, ...headers };
}

type PageMeta = {
  title: string;
  ogTitle: string;
  ogDescription: string;
  ogSiteName: string;
  ogImage: string;
  description: string;
  /**
   * URL the origin request actually landed on after following redirects
   * (e.g. a share.google short link resolves to its destination here).
   * Falls back to the requested URL when no redirect chain was observable.
   */
  finalUrl: string;
};

const emptyMeta: PageMeta = {
  title: "",
  ogTitle: "",
  ogDescription: "",
  ogSiteName: "",
  ogImage: "",
  description: "",
  finalUrl: "",
};

// Read a meta tag's content, tolerating property/name and escaped-colon variants
function metaContent(document: any, key: string): string {
  const el =
    document.querySelector(`meta[property="${key}"]`) ??
    document.querySelector(`meta[name="${key}"]`) ??
    document.querySelector(`meta[property="${key.replace(":", "\\:")}"]`);
  return el?.getAttribute("content")?.trim() ?? "";
}

// Regex fallback used when the HTML cannot be parsed at all
function metaContentByRegex(html: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return "";
}

function extractMeta(html: string): PageMeta {
  try {
    const { document } = parseHTML(html);
    return {
      title: document.querySelector("title")?.textContent?.trim() ?? "",
      ogTitle: metaContent(document, "og:title"),
      ogDescription: metaContent(document, "og:description"),
      ogSiteName: metaContent(document, "og:site_name"),
      ogImage: metaContent(document, "og:image"),
      description: metaContent(document, "description"),
      finalUrl: "",
    };
  } catch {
    // fallback regex if parse fails
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return {
      ...emptyMeta,
      title: titleMatch?.[1]?.trim() ?? "",
      ogTitle: metaContentByRegex(html, "og:title"),
      ogDescription: metaContentByRegex(html, "og:description"),
      ogSiteName: metaContentByRegex(html, "og:site_name"),
      ogImage: metaContentByRegex(html, "og:image"),
      description: metaContentByRegex(html, "description"),
    };
  }
}

// A page whose HTML carries neither og:title nor <title> is almost always a
// client-side rendered SPA: the origin serves an empty shell and the real head
// is written by JS. Signals that another renderer is worth the round trip.
function needsRendering(meta: PageMeta): boolean {
  return !meta.ogTitle && !meta.title;
}

// Shape a video's oEmbed record like the metadata the origin HTML would have
// carried, so as=meta answers with the same keys for YouTube as for any other
// page. `title` gets the site suffix YouTube's own <title> carries; `ogTitle`
// stays the bare video title, matching its og:title. oEmbed exposes no
// description, so ogDescription/description stay empty rather than being filled
// with the channel name, which is not one.
function youtubeMeta(video: YouTubeOEmbed): PageMeta {
  return {
    ...emptyMeta,
    title: `${video.title} - YouTube`,
    ogTitle: video.title,
    ogSiteName: "YouTube",
    ogImage: video.thumbnailUrl,
  };
}

// Keep every value the origin HTML already provided; fill only the blanks from
// the rendered page.
function mergeMeta(primary: PageMeta, fallback: PageMeta): PageMeta {
  return {
    title: primary.title || fallback.title,
    ogTitle: primary.ogTitle || fallback.ogTitle,
    ogDescription: primary.ogDescription || fallback.ogDescription,
    ogSiteName: primary.ogSiteName || fallback.ogSiteName,
    ogImage: primary.ogImage || fallback.ogImage,
    description: primary.description || fallback.description,
    finalUrl: primary.finalUrl || fallback.finalUrl,
  };
}

/**
 * Run `fn` with linkedom's DOM installed as the global document/window, which
 * defuddle and turndown both reach for directly instead of taking a document
 * argument. Whatever was there before is restored on the way out, so one
 * request cannot leave its DOM behind for the next one in the same isolate.
 */
async function withDomGlobals<T>(
  html: string,
  fn: (document: any) => Promise<T>,
): Promise<T | null> {
  const win: any = parseHTML(html);
  const document: any = win.document;
  const g: any = globalThis;
  const prevDocument = g.document;
  const prevWindow = g.window;
  const prevDOMParser = g.DOMParser;
  const prevNode = g.Node;
  const prevElement = g.Element;
  const prevHTMLElement = g.HTMLElement;
  const prevNodeFilter = g.NodeFilter;
  const prevText = g.Text;
  try {
    g.document = document;
    g.window = win;
    if (win.DOMParser) g.DOMParser = win.DOMParser;
    if (win.Node) g.Node = win.Node;
    if (win.Element) g.Element = win.Element;
    if (win.HTMLElement) g.HTMLElement = win.HTMLElement;
    if (win.NodeFilter) g.NodeFilter = win.NodeFilter;
    if (win.Text) g.Text = win.Text;
    if (!document.implementation) {
      (document as any).implementation = {
        createHTMLDocument: (title: string) => {
          const w: any = parseHTML(
            `<!DOCTYPE html><html><head><title>${title}</title></head><body></body></html>`,
          );
          return w.document;
        },
      };
    }

    return await fn(document);
  } catch (e) {
    console.error("withDomGlobals error:", e);
    return null;
  } finally {
    g.document = prevDocument;
    g.window = prevWindow;
    g.DOMParser = prevDOMParser;
    g.Node = prevNode;
    g.Element = prevElement;
    g.HTMLElement = prevHTMLElement;
    g.NodeFilter = prevNodeFilter;
    g.Text = prevText;
  }
}

async function tryDefuddle(html: string, url: string): Promise<string | null> {
  return withDomGlobals(html, async (document) => {
    // Dynamic import after polyfill so turndown's canParse check sees globals
    const { Defuddle: DefuddleFn } = await import("defuddle/node");
    const result = await DefuddleFn(document, url, { markdown: true });
    if (!result || !result.content) return null;
    const md = (result.content as string).trim();
    if (!md) return null;
    if (typeof result.wordCount === "number" && result.wordCount < 10) {
      if (md.length < 50) return null;
    }
    if (md.length < 20) return null;
    return md;
  });
}

/**
 * defuddle is a metadata extractor as much as a content extractor: it reads
 * JSON-LD and schema.org alongside the usual tags, so it can name a page whose
 * HTML carries neither og:title nor <title>. Far cheaper than a browser round
 * trip, so the fetch renderer tries it before handing over to the next one.
 */
async function defuddleMeta(
  html: string,
  url: string,
): Promise<PageMeta | null> {
  return withDomGlobals(html, async (document) => {
    // No markdown option: only the metadata fields are wanted here, and the
    // turndown pass is the expensive half.
    const { Defuddle: DefuddleFn } = await import("defuddle/node");
    const result = await DefuddleFn(document, url);
    if (!result) return null;
    const text = (value: unknown): string =>
      typeof value === "string" ? value.trim() : "";
    const meta: PageMeta = {
      ...emptyMeta,
      title: text(result.title),
      description: text(result.description),
      ogImage: text(result.image),
      ogSiteName: text(result.site),
    };
    // defuddle answers with its own placeholders on a page it cannot read;
    // nothing usable means nothing to merge.
    if (!meta.title && !meta.description && !meta.ogImage && !meta.ogSiteName) {
      return null;
    }
    return meta;
  });
}

// Titles change rarely, and browser renders are slow enough that a cold one can
// outlast a caller's timeout. Caching them keeps a user's retry cheap.
const BROWSER_META_CACHE_TTL_SECONDS = 600;

/**
 * The pipelines a caller picks between with `?renderer=` / `?r=`. Each one is
 * self-contained — it takes the target URL and produces the final answer for
 * the requested `as` — so a chain is just "try these in order, first one that
 * answers wins".
 *
 *   fetch    — a plain HTTP GET against the origin, extracted locally
 *              (extractMeta/defuddle for as=meta, defuddle for as=md)
 *   chromium — Browser Run's full engine, through the BROWSER binding
 *   kitesurf — Browser Run's lightweight agent-first engine, through the REST API
 */
type Renderer = "fetch" | "chromium" | "kitesurf";
type BrowserEngine = Exclude<Renderer, "fetch">;

const RENDERERS = ["fetch", "chromium", "kitesurf"] as const;

// Reproduces the behaviour the proxy had before the chain existed, for every
// `as`: ask the origin, and only reach for a browser when that cannot answer.
const DEFAULT_CHAIN: Renderer[] = ["fetch", "chromium"];

/**
 * How one renderer's attempt ended.
 *
 *   ok     — produced the answer; the chain stops here
 *   empty  — ran fine but produced nothing usable (as=meta on a page with no
 *            title anywhere). The chain continues, and the result is still kept
 *            as a last resort so as=meta keeps answering 200 with empty fields
 *            rather than failing outright
 *   failed — errored, or produced no result at all
 */
type AttemptStatus = "ok" | "empty" | "failed";
type Attempt = { renderer: string; status: AttemptStatus };

function rendererHeaders(
  attempts: Attempt[],
  used?: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (attempts.length > 0) {
    headers["X-Renderer-Chain"] = attempts
      .map((attempt) => `${attempt.renderer}=${attempt.status}`)
      .join(",");
  }
  if (used) headers["X-Renderer"] = used;
  return headers;
}

// CORS headers plus the record of which renderer answered. Used at every return
// point downstream of the chain; the validation errors above it keep withCors.
function withRenderer(
  attempts: Attempt[],
  used: string | undefined,
  headers: Record<string, string> = {},
): Record<string, string> {
  return withCors({ ...rendererHeaders(attempts, used), ...headers });
}

type ChainParse =
  | { ok: true; chain: Renderer[] }
  | { ok: false; message: string };

/**
 * Read the renderer chain off the query string. `renderer` and its short alias
 * `r` are both accepted, repeated and/or comma-separated: `?r=kitesurf&r=chromium`,
 * `?r=kitesurf,chromium` and `?r=kitesurf,chromium&r=fetch` all describe the
 * same chain.
 *
 * Order is the whole point, and URLSearchParams.getAll preserves query-string
 * order per the URL spec — which is why the raw URL is read directly here
 * rather than through a framework helper whose ordering is its own business.
 */
function parseChain(params: URLSearchParams): ChainParse {
  // browser= was this parameter's first shape and only ever took one value.
  // Point callers at their replacement rather than letting a stale query
  // silently render with the default chain.
  if (params.has("browser")) {
    return {
      ok: false,
      message:
        "browser parameter has been removed. use r=chromium or r=kitesurf (repeatable or comma-separated)",
    };
  }

  const long = params.getAll("renderer");
  const short = params.getAll("r");
  if (long.length > 0 && short.length > 0) {
    return { ok: false, message: "specify either renderer or r, not both" };
  }
  const raw = long.length > 0 ? long : short;
  if (raw.length === 0) return { ok: true, chain: [...DEFAULT_CHAIN] };

  const chain: Renderer[] = [];
  for (const value of raw.flatMap((entry) => entry.split(","))) {
    const name = value.trim();
    if (!name) return { ok: false, message: "empty renderer value in r" };
    if (!(RENDERERS as readonly string[]).includes(name)) {
      return {
        ok: false,
        message: `invalid renderer value: ${name}. allowed: ${RENDERERS.join(", ")}`,
      };
    }
    if (chain.includes(name as Renderer)) {
      return { ok: false, message: `duplicate renderer in r: ${name}` };
    }
    chain.push(name as Renderer);
  }
  return { ok: true, chain };
}

/**
 * Run a Quick Action against the Browser Run REST API with `engine` selected
 * via `?browser=`. Returns null when credentials are missing or the call
 * throws.
 */
async function restQuickAction(
  env: Bindings,
  action: "content" | "markdown",
  engine: BrowserEngine,
  body: Record<string, unknown>,
  cacheTTL?: number,
): Promise<Response | null> {
  if (!env?.CF_ACCOUNT_ID || !env?.BROWSER_API_TOKEN) return null;
  const endpoint = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/${action}`,
  );
  endpoint.searchParams.set("browser", engine);
  if (cacheTTL != null) endpoint.searchParams.set("cacheTTL", String(cacheTTL));
  try {
    return await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.BROWSER_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error("restQuickAction error:", e);
    return null;
  }
}

/**
 * Dispatch a Quick Action to one engine and hand back its raw Response.
 * kitesurf speaks only REST — the binding's quickAction() rejects an engine key
 * with `400 Unrecognized key` — while chromium goes through the binding.
 * Neither falls back to the other: the caller's renderer chain decides what
 * happens after a failure, which is what keeps X-Renderer honest.
 */
async function quickActionResult(
  env: Bindings,
  action: "content" | "markdown",
  engine: BrowserEngine,
  body: Record<string, unknown>,
  cacheTTL?: number,
): Promise<Response | null> {
  if (engine === "kitesurf") {
    return restQuickAction(env, action, engine, body, cacheTTL);
  }
  if (!env?.BROWSER) return null;
  const opts = { ...body };
  if (cacheTTL != null) (opts as any).cacheTTL = cacheTTL;
  try {
    // The quickAction overloads are keyed by exact action literal; the union
    // here only ever carries content/markdown, whose option shapes are shared.
    return await env.BROWSER.quickAction(action as "content", opts as any);
  } catch (e) {
    console.error("quickActionResult error:", e);
    return null;
  }
}

/**
 * Re-fetch the page through Browser Rendering and extract its metadata from the
 * rendered DOM. Used by as=meta when the origin HTML has no title at all, which
 * is the case for client-side rendered SPAs.
 *
 * Images, media, fonts and stylesheets are blocked: nothing is painted here, and
 * skipping them makes `networkidle0` settle noticeably sooner.
 */
async function browserMeta(
  env: Bindings,
  targetUrl: string,
  engine: BrowserEngine,
): Promise<PageMeta | null> {
  try {
    const res = await quickActionResult(
      env,
      "content",
      engine,
      {
        url: targetUrl,
        gotoOptions: { waitUntil: "load" },
        rejectResourceTypes: ["image", "media", "font", "stylesheet"],
        bestAttempt: true,
      },
      BROWSER_META_CACHE_TTL_SECONDS,
    );

    if (!res || !res.ok) return null;
    const data = (await res.json()) as {
      success: boolean;
      result?: string;
      meta?: { status?: number; title?: string };
    };
    if (!data.success || typeof data.result !== "string") return null;

    const meta = extractMeta(data.result);
    // Browser Rendering reports document.title separately, which survives even
    // when the SPA sets it without ever writing a <title> element we can parse.
    const documentTitle = data.meta?.title?.trim() ?? "";
    return { ...meta, title: meta.title || documentTitle };
  } catch (e) {
    console.error("browserMeta error:", e);
    return null;
  }
}

async function browserHtml(
  env: Bindings,
  targetUrl: string,
  engine: BrowserEngine,
): Promise<string | null> {
  try {
    const res = await quickActionResult(
      env,
      "content",
      engine,
      {
        url: targetUrl,
        gotoOptions: { waitUntil: "load" },
        rejectResourceTypes: ["image", "media", "font", "stylesheet"],
        bestAttempt: true,
      },
      BROWSER_META_CACHE_TTL_SECONDS,
    );
    if (!res || !res.ok) return null;
    const data = (await res.json()) as {
      success: boolean;
      result?: string;
    };
    if (!data.success || typeof data.result !== "string") return null;
    const html = data.result.trim();
    if (!html) return null;
    return html;
  } catch (e) {
    console.error("browserHtml error:", e);
    return null;
  }
}

async function browserMarkdown(
  env: Bindings,
  targetUrl: string,
  engine: BrowserEngine,
): Promise<string | null> {
  try {
    const res = await quickActionResult(env, "markdown", engine, {
      url: targetUrl,
      gotoOptions: { waitUntil: "networkidle0" },
    });

    // quickAction returns Response with JSON { success, result }
    if (!res || !res.ok) {
      // try to parse error body for debugging but treat as failure
      return null;
    }
    const ct = res.headers.get("Content-Type") || "";
    if (ct.includes("application/json")) {
      const data = (await res.json()) as {
        success: boolean;
        result?: string;
        errors?: unknown;
      };
      if (
        data.success &&
        typeof data.result === "string" &&
        data.result.trim().length > 0
      ) {
        return data.result;
      }
      return null;
    } else {
      const text = await res.text();
      // if not JSON, maybe directly markdown
      if (text && text.trim().length > 0) {
        // try parse as JSON fallback
        try {
          const json = JSON.parse(text) as {
            success: boolean;
            result?: string;
          };
          if (json.success && json.result) return json.result;
        } catch {
          return text;
        }
      }
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * What the origin's own answer turned out to be. Read once per request and
 * memoised: a chain can name `fetch` only once, but the relayed body is needed
 * again after the chain runs out.
 */
type OriginResult =
  | { kind: "ok"; res: Response; html: string }
  | { kind: "status"; res: Response; body: string }
  | { kind: "error"; message: string };

async function fetchOrigin(targetUrl: string): Promise<OriginResult> {
  let res: Response;
  try {
    res = await fetch(targetUrl, {
      method: "GET",
      headers: {
        "User-Agent": "fetch-proxy/1.0 (+https://fetch.nibk.sh)",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,ja;q=0.8",
      },
      redirect: "follow",
    });
  } catch (e) {
    return {
      kind: "error",
      message: e instanceof Error ? e.message : String(e),
    };
  }
  const body = await res.text();
  if (!res.ok) return { kind: "status", res, body };
  return { kind: "ok", res, html: body };
}

// Handle CORS preflight for all paths
app.options("/*", (c) => {
  return new Response(null, {
    status: 204,
    headers: withCors(),
  });
});

// Health check / root
app.get("/", (c) => {
  const url = new URL(c.req.url);
  // if root accessed without target, show usage
  // but if user explicitly wants to fetch root with as param? Still show help
  if (
    url.pathname === "/" &&
    !url.searchParams.has("as") &&
    url.searchParams.toString() === ""
  ) {
    return c.text(
      "fetch-proxy: use /<host>/<path>?as=html|meta|md&r=fetch,chromium,kitesurf",
      200,
      withCors({ "Content-Type": "text/plain; charset=utf-8" }),
    );
  }
  // otherwise fall through to proxy logic? For '/' we treat as missing target
  return c.text(
    "missing target host: use /<host>/<path>",
    400,
    withCors({ "Content-Type": "text/plain; charset=utf-8" }),
  );
});

app.on(["GET", "HEAD"], "/*", async (c) => {
  const rawUrl = new URL(c.req.url);
  const pathname = rawUrl.pathname;

  // pathname is like /example.com/foo
  if (!pathname || pathname === "/" || pathname === "") {
    return c.text(
      "missing target host: use /<host>/<path>",
      400,
      withCors({ "Content-Type": "text/plain; charset=utf-8" }),
    );
  }

  let hostAndPath = pathname.slice(1); // remove leading /

  if (!hostAndPath) {
    return c.text(
      "missing target host: use /<host>/<path>",
      400,
      withCors({ "Content-Type": "text/plain; charset=utf-8" }),
    );
  }

  // Support both fetch.nibo.sh/example.com and fetch.nibo.sh/https://example.com
  // Strip leading http:// or https:// if present (user may pass full URL)
  if (hostAndPath.startsWith("https://")) {
    hostAndPath = hostAndPath.slice(8);
  } else if (hostAndPath.startsWith("http://")) {
    hostAndPath = hostAndPath.slice(7);
  } else if (
    hostAndPath.startsWith("https:/") &&
    !hostAndPath.startsWith("https://")
  ) {
    hostAndPath = hostAndPath.replace(/^https:\/+/, "");
  } else if (
    hostAndPath.startsWith("http:/") &&
    !hostAndPath.startsWith("http://")
  ) {
    hostAndPath = hostAndPath.replace(/^http:\/+/, "");
  }

  if (!hostAndPath) {
    return c.text(
      "missing target host: use /<host>/<path>",
      400,
      withCors({ "Content-Type": "text/plain; charset=utf-8" }),
    );
  }

  // Basic validation: hostAndPath should not contain whitespace, should contain at least a dot or be localhost
  // If it contains '?' or '#', those are not in pathname (they are in search/hash)
  // Decode check
  if (hostAndPath.includes(" ")) {
    return c.text(
      "invalid target host",
      400,
      withCors({ "Content-Type": "text/plain; charset=utf-8" }),
    );
  }

  // as param handling
  const asValues = rawUrl.searchParams.getAll("as");
  if (asValues.length > 1) {
    return c.text(
      "as parameter cannot be specified multiple times",
      400,
      withCors({ "Content-Type": "text/plain; charset=utf-8" }),
    );
  }
  const as = asValues[0] ?? "html";
  // as=title was removed: it only ever returned `ogTitle || title` from the same
  // extraction as=meta already does, so point callers at their replacement
  // rather than letting them read it as a typo.
  if (as === "title") {
    return c.text(
      "as=title has been removed. use as=meta and read ogTitle, falling back to title",
      400,
      withCors({ "Content-Type": "text/plain; charset=utf-8" }),
    );
  }
  if (!["html", "meta", "md"].includes(as)) {
    return c.text(
      `invalid as value: ${as}. allowed: html, meta, md`,
      400,
      withCors({ "Content-Type": "text/plain; charset=utf-8" }),
    );
  }

  // renderer / r param handling: the ordered list of pipelines to try.
  const parsedChain = parseChain(rawUrl.searchParams);
  if (!parsedChain.ok) {
    return c.text(
      parsedChain.message,
      400,
      withCors({ "Content-Type": "text/plain; charset=utf-8" }),
    );
  }
  const chain = parsedChain.chain;

  // Build forward query (exclude 'as' and the renderer aliases)
  const forwardParams = new URLSearchParams();
  for (const [k, v] of rawUrl.searchParams.entries()) {
    if (k !== "as" && k !== "renderer" && k !== "r") forwardParams.append(k, v);
  }
  let targetUrl = `https://${hostAndPath}`;
  const qs = forwardParams.toString();
  if (qs) targetUrl += `?${qs}`;

  // Validate target URL
  try {
    const u = new URL(targetUrl);
    if (!u.hostname.includes(".") && u.hostname !== "localhost") {
      // allow but still check hostname exists
      // we will allow if it looks like hostname, but if no dot, it's likely invalid
      // For now, don't block strictly - some internal hosts may not have dot
    }
  } catch {
    return c.text(
      "invalid target URL",
      400,
      withCors({ "Content-Type": "text/plain; charset=utf-8" }),
    );
  }

  const attempts: Attempt[] = [];

  // YouTube never serves a watch page to a Worker — it answers with a CAPTCHA
  // interstitial (429) or a shell titled just "YouTube" — so the video title has
  // to come from oEmbed instead. This runs before the chain because the 429 is
  // relayed to the caller below, well before as=meta gets a look in.
  // A video oEmbed cannot answer for (private, removed) falls through.
  if (as === "meta") {
    const watchUrl = youtubeWatchUrl(targetUrl);
    if (watchUrl) {
      const video = await fetchYouTubeOEmbed(watchUrl);
      if (video) {
        attempts.push({ renderer: "oembed", status: "ok" });
        // The oEmbed path never follows a redirect, so the requested URL is final
        return new Response(
          JSON.stringify({ ...youtubeMeta(video), finalUrl: targetUrl }),
          {
            headers: withRenderer(attempts, "oembed", {
              "Content-Type": "application/json; charset=utf-8",
            }),
          },
        );
      }
    }
  }

  const env = c.env as Bindings;

  // The origin is fetched at most once, and only if the chain names `fetch`.
  // Held in an object rather than a bare `let` so its type survives being
  // written from inside loadOrigin and read again after the loop.
  const originState: { result: OriginResult | null } = { result: null };
  const loadOrigin = async (): Promise<OriginResult> => {
    const loaded = originState.result ?? (await fetchOrigin(targetUrl));
    originState.result = loaded;
    return loaded;
  };
  // The origin fetch follows redirects, so response.url is where the chain
  // actually landed; mocked/empty URLs fall back to the requested one.
  const finalUrl = (): string => {
    const result = originState.result;
    return (result && result.kind !== "error" && result.res.url) || targetUrl;
  };

  // Best metadata any renderer has produced. as=meta answers with this even
  // when nothing usable was found, so a page with no metadata still gets the
  // JSON shape callers expect rather than an error they have to special-case.
  let bestMeta: PageMeta | null = null;

  const relayOrigin = (
    result: { res: Response; body: string },
    used?: string,
  ): Response =>
    new Response(result.body, {
      status: result.res.status,
      headers: withRenderer(attempts, used, {
        "Content-Type":
          result.res.headers.get("Content-Type") || "text/plain; charset=utf-8",
      }),
    });

  const metaResponse = (meta: PageMeta, used?: string): Response =>
    new Response(JSON.stringify({ ...meta, finalUrl: finalUrl() }), {
      headers: withRenderer(attempts, used, {
        "Content-Type": "application/json; charset=utf-8",
      }),
    });

  for (const renderer of chain) {
    if (renderer === "fetch") {
      const result = await loadOrigin();

      if (result.kind === "error") {
        attempts.push({ renderer, status: "failed" });
        continue;
      }

      if (result.kind === "status") {
        // 403/429 is the bot-blocking signature a real browser can get past, so
        // the chain carries on. Any other status is the origin's actual answer
        // and is relayed as is — re-rendering a 404 buys nothing and would hide
        // it from the caller.
        if (result.res.status !== 403 && result.res.status !== 429) {
          attempts.push({ renderer, status: "ok" });
          return relayOrigin(result, renderer);
        }
        attempts.push({ renderer, status: "failed" });
        continue;
      }

      if (as === "html") {
        attempts.push({ renderer, status: "ok" });
        const contentType = result.res.headers.get("Content-Type") || "";
        return new Response(result.html, {
          headers: withRenderer(attempts, renderer, {
            "Content-Type": contentType.includes("text/html")
              ? contentType
              : "text/html; charset=utf-8",
          }),
        });
      }

      if (as === "meta") {
        let meta = extractMeta(result.html);
        // No title anywhere in the served HTML. defuddle sees JSON-LD and
        // schema.org, so give it a turn before paying for a browser.
        if (needsRendering(meta)) {
          const fromDefuddle = await defuddleMeta(result.html, targetUrl);
          if (fromDefuddle) meta = mergeMeta(meta, fromDefuddle);
        }
        bestMeta = bestMeta ? mergeMeta(bestMeta, meta) : meta;
        if (!needsRendering(bestMeta)) {
          attempts.push({ renderer, status: "ok" });
          return metaResponse(bestMeta, renderer);
        }
        attempts.push({ renderer, status: "empty" });
        continue;
      }

      // as === "md"
      const markdown = await tryDefuddle(result.html, targetUrl);
      if (markdown && markdown.trim().length >= 20) {
        attempts.push({ renderer, status: "ok" });
        return new Response(markdown, {
          headers: withRenderer(attempts, renderer, {
            "Content-Type": "text/markdown; charset=utf-8",
          }),
        });
      }
      attempts.push({ renderer, status: "failed" });
      continue;
    }

    const engine = renderer as BrowserEngine;

    if (as === "html") {
      const html = await browserHtml(env, targetUrl, engine);
      if (html) {
        attempts.push({ renderer, status: "ok" });
        return new Response(html, {
          headers: withRenderer(attempts, renderer, {
            "Content-Type": "text/html; charset=utf-8",
          }),
        });
      }
      attempts.push({ renderer, status: "failed" });
      continue;
    }

    if (as === "meta") {
      const rendered = await browserMeta(env, targetUrl, engine);
      if (!rendered) {
        attempts.push({ renderer, status: "failed" });
        continue;
      }
      // Whatever the origin already provided wins; the render only fills blanks.
      bestMeta = bestMeta ? mergeMeta(bestMeta, rendered) : rendered;
      if (!needsRendering(bestMeta)) {
        attempts.push({ renderer, status: "ok" });
        return metaResponse(bestMeta, renderer);
      }
      attempts.push({ renderer, status: "empty" });
      continue;
    }

    // as === "md"
    const brMarkdown = await browserMarkdown(env, targetUrl, engine);
    if (brMarkdown && brMarkdown.trim().length > 0) {
      attempts.push({ renderer, status: "ok" });
      return new Response(brMarkdown, {
        headers: withRenderer(attempts, renderer, {
          "Content-Type": "text/markdown; charset=utf-8",
        }),
      });
    }
    attempts.push({ renderer, status: "failed" });
  }

  // Nothing in the chain answered.

  // as=meta keeps its contract: a page with no metadata gets empty fields, not
  // an error. The renderer credited is the one whose (empty) result is served.
  if (as === "meta" && bestMeta) {
    const used = attempts.find((attempt) => attempt.status === "empty");
    return metaResponse(bestMeta, used?.renderer);
  }

  const originResult = originState.result;

  // The origin answered 403/429 and no renderer got past it: relay what it said.
  if (originResult?.kind === "status") {
    return relayOrigin(originResult);
  }

  if (originResult?.kind === "error") {
    return c.text(
      `failed to fetch target: ${originResult.message}`,
      502,
      withRenderer(attempts, undefined, {
        "Content-Type": "text/plain; charset=utf-8",
      }),
    );
  }

  const tried = chain.join(", ");
  return c.text(
    as === "md"
      ? `failed to convert to markdown: all renderers failed (${tried})`
      : `all renderers failed (${tried})`,
    502,
    withRenderer(attempts, undefined, {
      "Content-Type": "text/plain; charset=utf-8",
    }),
  );
});

// Fallback for other methods - proxy similarly but only GET is expected
app.all("/*", async (c) => {
  if (c.req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: withCors() });
  }
  // For non-GET, we still handle as GET proxy? Or return 405
  // To keep CORS compatibility, proxy GET logic but with original method?
  // For simplicity, only allow GET/HEAD/OPTIONS
  return c.text(
    `method ${c.req.method} not allowed`,
    405,
    withCors({ "Content-Type": "text/plain; charset=utf-8" }),
  );
});

export default app;

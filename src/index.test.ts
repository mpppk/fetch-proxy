import { describe, expect, it, vi } from "vitest";
import app from "./index";

describe("fetch-proxy", () => {
  it("GET / returns help text", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("fetch-proxy");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("OPTIONS returns 204 with CORS", async () => {
    const res = await app.request("/example.com/", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("GET /?as=invalid returns 400", async () => {
    const res = await app.request("/example.com/?as=invalid");
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("invalid as value");
  });

  it("GET /invalid host returns 400", async () => {
    const res = await app.request("/invalid host");
    expect(res.status).toBe(400);
  });

  it("POST returns 405", async () => {
    const res = await app.request("/example.com/", { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("GET /example.com/?as=title has been removed (400)", async () => {
    const res = await app.request("/example.com/?as=title");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("as=title has been removed");
  });

  it("GET /example.com/?as=meta extracts og:title and title", async () => {
    const html = `<!DOCTYPE html><html><head><meta property="og:title" content="OG Title"><meta property="og:description" content="OG Desc"><title>Fallback</title></head><body>hello</body></html>`;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.request("/example.com/?as=meta");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const meta = (await res.json()) as {
      title: string;
      ogTitle: string;
      ogDescription: string;
    };
    expect(meta.ogTitle).toBe("OG Title");
    expect(meta.title).toBe("Fallback");
    expect(meta.ogDescription).toBe("OG Desc");
    vi.unstubAllGlobals();
  });

  it("GET /example.com/?as=meta falls back to the requested URL for finalUrl when the response has none (mocked Response)", async () => {
    const html = `<html><head><title>A</title></head><body></body></html>`;
    // new Response() carries an empty .url, like hand-built responses in tests
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/example.com/page?as=meta");
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { finalUrl: string };
    expect(meta.finalUrl).toBe("https://example.com/page");
    vi.unstubAllGlobals();
  });

  it("GET /share.google/abc?as=meta reports the redirect destination as finalUrl", async () => {
    const html = `<html><head><title>Destination</title></head><body></body></html>`;
    // A real redirected fetch exposes the landing URL on response.url
    const redirected = {
      ok: true,
      status: 200,
      url: "https://maps.example.com/place/123",
      headers: new Headers({ "Content-Type": "text/html; charset=utf-8" }),
      text: () => Promise.resolve(html),
    } as unknown as Response;
    const fetchMock = vi.fn().mockResolvedValue(redirected);
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/share.google/abc?as=meta");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://share.google/abc",
      expect.anything(),
    );
    const meta = (await res.json()) as { finalUrl: string; title: string };
    expect(meta.finalUrl).toBe("https://maps.example.com/place/123");
    expect(meta.title).toBe("Destination");
    vi.unstubAllGlobals();
  });

  it("GET /example.com/?as=html proxies html with CORS", async () => {
    const html =
      "<!DOCTYPE html><html><head><title>Hi</title></head><body>hello world</body></html>";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.request("/example.com/?as=html");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(html);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    vi.unstubAllGlobals();
  });

  it("GET /example.com/?as=md returns markdown via defuddle", async () => {
    const html = `<!DOCTYPE html><html><head><title>Test Article</title></head><body><article><h1>Hello World</h1><p>This is a long enough article content to pass defuddle wordCount checks. It has more than ten words and sufficient length to be considered valid markdown output for testing purposes.</p><p>Second paragraph with even more content to ensure markdown is longer than 50 characters.</p></article></body></html>`;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.request("/example.com/?as=md");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    const body = await res.text();
    expect(body.length).toBeGreaterThan(20);
    vi.unstubAllGlobals();
  });

  it("strips https:// prefix", async () => {
    const html = "<html><head><title>A</title></head><body></body></html>";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.request("/https://example.com/foo?as=html");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/foo",
      expect.anything(),
    );
    vi.unstubAllGlobals();
  });

  it("GET /youtu.be/<id>?as=meta reads the video title from oEmbed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "Never Gonna Give You Up",
          author_name: "Rick Astley",
          thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/youtu.be/dQw4w9WgXcQ?si=tracking&as=meta");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      title: "Never Gonna Give You Up - YouTube",
      ogTitle: "Never Gonna Give You Up",
      ogDescription: "",
      ogSiteName: "YouTube",
      ogImage: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      description: "",
      finalUrl: "https://youtu.be/dQw4w9WgXcQ?si=tracking",
    });

    // oEmbed short-circuits the renderer chain entirely, and says so.
    expect(res.headers.get("X-Renderer")).toBe("oembed");
    expect(res.headers.get("X-Renderer-Chain")).toBe("oembed=ok");

    // The watch page itself is never requested: YouTube answers Workers with a
    // CAPTCHA interstitial, which is what made the title "YouTube" before.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/oembed?");
    vi.unstubAllGlobals();
  });

  it("GET /www.youtube.com/watch?as=meta falls back to the origin when oEmbed fails", async () => {
    const html = `<!DOCTYPE html><html><head><title>YouTube</title></head><body></body></html>`;
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        url.includes("/oembed?")
          ? new Response("Bad Request", { status: 400 })
          : new Response(html, {
              status: 200,
              headers: { "Content-Type": "text/html; charset=utf-8" },
            }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request(
      "/www.youtube.com/watch?v=dQw4w9WgXcQ&as=meta",
    );
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { title: string };
    expect(meta.title).toBe("YouTube");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("GET /youtu.be/<id>?as=html still proxies the origin", async () => {
    const html =
      "<html><head><title>YouTube</title></head><body></body></html>";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/youtu.be/dQw4w9WgXcQ?as=html");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://youtu.be/dQw4w9WgXcQ",
      expect.anything(),
    );
    vi.unstubAllGlobals();
  });

  it("GET /www.youtube.com/@channel?as=meta uses the origin, not oEmbed", async () => {
    const html = `<!DOCTYPE html><html><head><meta property="og:title" content="Rick Astley"></head><body></body></html>`;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/www.youtube.com/@RickAstleyYT?as=meta");
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { ogTitle: string };
    expect(meta.ogTitle).toBe("Rick Astley");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.youtube.com/@RickAstleyYT",
      expect.anything(),
    );
    vi.unstubAllGlobals();
  });

  it("forwards query params except as", async () => {
    const html = "<html><head><title>A</title></head><body></body></html>";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.request(
      "/example.com/search?q=hello&lang=ja&as=html",
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/search?q=hello&lang=ja",
      expect.anything(),
    );
    vi.unstubAllGlobals();
  });

  // --- renderer / r ---

  it("GET /example.com/?r=webkit returns 400", async () => {
    const res = await app.request("/example.com/?as=html&r=webkit");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(
      "invalid renderer value: webkit. allowed: fetch, chromium, kitesurf",
    );
  });

  it("rejects a renderer repeated within the chain", async () => {
    const res = await app.request(
      "/example.com/?as=html&r=chromium&r=chromium",
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("duplicate renderer in r: chromium");
  });

  it("rejects an empty renderer value", async () => {
    for (const query of ["r=", "r=fetch,,chromium"]) {
      const res = await app.request(`/example.com/?as=html&${query}`);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("empty renderer value in r");
    }
  });

  it("rejects renderer and r specified together", async () => {
    const res = await app.request(
      "/example.com/?as=html&renderer=fetch&r=chromium",
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(
      "specify either renderer or r, not both",
    );
  });

  it("reports the removed browser parameter instead of ignoring it", async () => {
    const res = await app.request("/example.com/?as=html&browser=kitesurf");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("browser parameter has been removed");
  });

  it("does not forward the renderer parameters to the target URL", async () => {
    const html = "<html><head><title>A</title></head><body></body></html>";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await app.request("/example.com/page?as=html&r=fetch");
    await app.request("/example.com/page?as=html&renderer=fetch");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe("https://example.com/page");
    }
    vi.unstubAllGlobals();
  });

  it("reports the renderer that answered and exposes the header to CORS callers", async () => {
    const html =
      "<html><head><title>Hi</title></head><body>hello</body></html>";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.request("/example.com/?as=html");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Renderer")).toBe("fetch");
    expect(res.headers.get("X-Renderer-Chain")).toBe("fetch=ok");
    // Without this a browser's fetch() cannot read the two headers above.
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain(
      "X-Renderer",
    );
    vi.unstubAllGlobals();
  });

  it("tries renderers in the order given, repeated or comma-separated", async () => {
    const rendered =
      "<html><head><title>Rendered</title></head><body>browser</body></html>";
    const origin =
      "<html><head><title>Origin</title></head><body>origin</body></html>";
    const makeMock = () =>
      vi.fn().mockImplementation((input: unknown) =>
        Promise.resolve(
          String(input).includes("api.cloudflare.com")
            ? new Response(
                JSON.stringify({ success: true, result: rendered }),
                {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                },
              )
            : new Response(origin, {
                status: 200,
                headers: { "Content-Type": "text/html; charset=utf-8" },
              }),
        ),
      );
    const env = { CF_ACCOUNT_ID: "acct123", BROWSER_API_TOKEN: "tok123" };

    // Both spellings describe the same chain, and both put kitesurf first.
    for (const query of ["r=kitesurf&r=fetch", "r=kitesurf,fetch"]) {
      const fetchMock = makeMock();
      vi.stubGlobal("fetch", fetchMock);
      const res = await app.request(
        `/example.com/p?as=html&${query}`,
        undefined,
        env,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Renderer")).toBe("kitesurf");
      expect(res.headers.get("X-Renderer-Chain")).toBe("kitesurf=ok");
      expect(await res.text()).toBe(rendered);
      vi.unstubAllGlobals();
    }

    // Reversing the chain reverses which renderer answers.
    const fetchMock = makeMock();
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.request(
      "/example.com/p?as=html&r=fetch,kitesurf",
      undefined,
      env,
    );
    expect(res.headers.get("X-Renderer")).toBe("fetch");
    expect(res.headers.get("X-Renderer-Chain")).toBe("fetch=ok");
    expect(await res.text()).toBe(origin);
    vi.unstubAllGlobals();
  });

  it("falls back down the chain and records every attempt", async () => {
    const origin =
      "<html><head><title>Origin</title></head><body>hi</body></html>";
    const fetchMock = vi.fn().mockImplementation((input: unknown) =>
      Promise.resolve(
        String(input).includes("api.cloudflare.com")
          ? new Response("boom", { status: 500 })
          : new Response(origin, {
              status: 200,
              headers: { "Content-Type": "text/html; charset=utf-8" },
            }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const env = { CF_ACCOUNT_ID: "acct123", BROWSER_API_TOKEN: "tok123" };
    // kitesurf's REST call errors, chromium has no BROWSER binding in tests,
    // so the mixed comma/repeat chain walks all the way down to fetch.
    const res = await app.request(
      "/example.com/p?as=html&r=kitesurf,chromium&r=fetch",
      undefined,
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(origin);
    expect(res.headers.get("X-Renderer")).toBe("fetch");
    expect(res.headers.get("X-Renderer-Chain")).toBe(
      "kitesurf=failed,chromium=failed,fetch=ok",
    );
    vi.unstubAllGlobals();
  });

  it("does not silently fall back to another engine, and skips the origin when the chain omits fetch", async () => {
    for (const renderer of ["kitesurf", "chromium"]) {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response("<html><head><title>Origin</title></head></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      // No CF_ACCOUNT_ID/BROWSER_API_TOKEN and no BROWSER binding: the engine
      // has no way to run, and nothing rescues it behind the caller's back.
      const res = await app.request(`/example.com/p?as=html&r=${renderer}`);
      expect(res.status).toBe(502);
      expect(await res.text()).toContain(`all renderers failed (${renderer})`);
      expect(res.headers.get("X-Renderer-Chain")).toBe(`${renderer}=failed`);
      expect(res.headers.get("X-Renderer")).toBeNull();
      // The chain never named fetch, so the origin was never touched.
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });

  it("relays a non-403/429 origin status without trying a browser", async () => {
    const fetchMock = vi.fn().mockImplementation((input: unknown) => {
      if (String(input).includes("api.cloudflare.com")) {
        throw new Error("the browser must not be reached for a 404");
      }
      return Promise.resolve(
        new Response("nope", {
          status: 404,
          headers: { "Content-Type": "text/plain" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const env = { CF_ACCOUNT_ID: "acct123", BROWSER_API_TOKEN: "tok123" };
    const res = await app.request(
      "/example.com/missing?as=meta&r=fetch,kitesurf",
      undefined,
      env,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("X-Renderer")).toBe("fetch");
    expect(res.headers.get("X-Renderer-Chain")).toBe("fetch=ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("r=fetch,kitesurf renders SPA meta through the Browser Run REST API", async () => {
    const shell = `<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>`;
    const fetchMock = vi.fn().mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.includes("api.cloudflare.com")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              success: true,
              result: "<html><head><title>Rendered</title></head></html>",
              meta: { status: 200, title: "Rendered" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(shell, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const env = { CF_ACCOUNT_ID: "acct123", BROWSER_API_TOKEN: "tok123" };
    const res = await app.request(
      "/example.com/app?as=meta&r=fetch,kitesurf",
      undefined,
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      title: "Rendered",
      ogTitle: "",
      ogDescription: "",
      ogSiteName: "",
      ogImage: "",
      description: "",
      finalUrl: "https://example.com/app",
    });
    // The shell parsed cleanly but named nothing, so fetch is "empty" rather
    // than "failed" and kitesurf gets the credit.
    expect(res.headers.get("X-Renderer")).toBe("kitesurf");
    expect(res.headers.get("X-Renderer-Chain")).toBe("fetch=empty,kitesurf=ok");

    // Kitesurf is only reachable via the REST Quick Action endpoints, so the
    // call must carry the engine in the query string and the token in the
    // Authorization header.
    const restCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("api.cloudflare.com"),
    );
    expect(restCall).toBeDefined();
    const restUrl = new URL(String(restCall?.[0]));
    expect(restUrl.pathname).toBe(
      "/client/v4/accounts/acct123/browser-rendering/content",
    );
    expect(restUrl.searchParams.get("browser")).toBe("kitesurf");
    expect(restUrl.searchParams.get("cacheTTL")).toBe("600");
    const init = restCall?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok123",
    );
    expect(JSON.parse(String(init.body)).url).toBe("https://example.com/app");
    vi.unstubAllGlobals();
  });

  it("r=fetch,kitesurf converts markdown through the REST API on a 403 origin", async () => {
    const markdown =
      "# Rendered Article\n\nThis markdown came from the kitesurf quick action and is long enough.";
    const fetchMock = vi.fn().mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.includes("api.cloudflare.com")) {
        return Promise.resolve(
          new Response(JSON.stringify({ success: true, result: markdown }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response("blocked", { status: 403, headers: {} }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const env = { CF_ACCOUNT_ID: "acct123", BROWSER_API_TOKEN: "tok123" };
    const res = await app.request(
      "/medium.com/post?as=md&r=fetch,kitesurf",
      undefined,
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    expect(await res.text()).toBe(markdown);
    expect(res.headers.get("X-Renderer")).toBe("kitesurf");
    expect(res.headers.get("X-Renderer-Chain")).toBe(
      "fetch=failed,kitesurf=ok",
    );

    const restUrl = new URL(
      String(
        fetchMock.mock.calls.find(([input]) =>
          String(input).includes("api.cloudflare.com"),
        )?.[0],
      ),
    );
    expect(restUrl.pathname.endsWith("/browser-rendering/markdown")).toBe(true);
    expect(restUrl.searchParams.get("browser")).toBe("kitesurf");
    vi.unstubAllGlobals();
  });

  it("relays a 403 origin when no renderer gets past it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("blocked", {
        status: 403,
        headers: { "Content-Type": "text/plain" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.request("/medium.com/post?as=md");
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("blocked");
    expect(res.headers.get("X-Renderer-Chain")).toBe(
      "fetch=failed,chromium=failed",
    );
    vi.unstubAllGlobals();
  });

  it("as=meta reads metadata defuddle finds in JSON-LD, without a browser", async () => {
    // No og:*, no <title> — only schema.org. extractMeta comes back blank, so
    // the fetch renderer hands the same HTML to defuddle before giving up.
    const html = `<!DOCTYPE html><html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"Schema Only Headline","description":"A description from JSON-LD.","publisher":{"@type":"Organization","name":"Example News"}}</script></head><body><article><h1>Schema Only Headline</h1><p>Body text long enough to be considered real content by any extractor worth its salt, with plenty of words in it.</p></article></body></html>`;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/example.com/article?as=meta");
    expect(res.status).toBe(200);
    const meta = (await res.json()) as {
      title: string;
      description: string;
      ogSiteName: string;
    };
    expect(meta.title).toBe("Schema Only Headline");
    expect(meta.description).toBe("A description from JSON-LD.");
    expect(meta.ogSiteName).toBe("Example News");
    expect(res.headers.get("X-Renderer")).toBe("fetch");
    expect(res.headers.get("X-Renderer-Chain")).toBe("fetch=ok");
    // Only the origin was fetched; no browser round trip was needed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("as=meta still answers 200 with empty fields when nothing finds metadata", async () => {
    const shell = `<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>`;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(shell, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/example.com/app?as=meta");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      title: "",
      ogTitle: "",
      ogDescription: "",
      ogSiteName: "",
      ogImage: "",
      description: "",
      finalUrl: "https://example.com/app",
    });
    // fetch produced a well-formed but empty answer, which is what gets served
    // once chromium (no binding in tests) fails outright.
    expect(res.headers.get("X-Renderer")).toBe("fetch");
    expect(res.headers.get("X-Renderer-Chain")).toBe(
      "fetch=empty,chromium=failed",
    );
    vi.unstubAllGlobals();
  });

  it("as=md returns 502 naming the chain when every renderer fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<html><head></head><body></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.request("/example.com/empty?as=md");
    expect(res.status).toBe(502);
    expect(await res.text()).toContain(
      "failed to convert to markdown: all renderers failed (fetch, chromium)",
    );
    expect(res.headers.get("X-Renderer-Chain")).toBe(
      "fetch=failed,chromium=failed",
    );
    vi.unstubAllGlobals();
  });
});

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

  it("GET /example.com/?browser=invalid returns 400", async () => {
    const res = await app.request("/example.com/?as=html&browser=webkit");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(
      "invalid browser value: webkit. allowed: chromium, kitesurf",
    );
  });

  it("browser parameter cannot be specified multiple times", async () => {
    const res = await app.request(
      "/example.com/?as=html&browser=kitesurf&browser=chromium",
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(
      "browser parameter cannot be specified multiple times",
    );
  });

  it("does not forward the browser parameter to the target URL", async () => {
    const html = "<html><head><title>A</title></head><body></body></html>";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.request("/example.com/page?as=html&browser=kitesurf");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/page",
      expect.anything(),
    );
    vi.unstubAllGlobals();
  });

  it("browser=kitesurf renders SPA meta through the Browser Run REST API", async () => {
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
      "/example.com/app?as=meta&browser=kitesurf",
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

  it("browser=kitesurf falls back to the origin answer when REST credentials are missing", async () => {
    const shell = `<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>`;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(shell, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await app.request("/example.com/app?as=meta&browser=kitesurf");
    expect(res.status).toBe(200);
    // No credentials configured: only the origin was fetched, no REST attempt.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("falling back to chromium"),
    );
    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("browser=kitesurf converts markdown through the REST API on a 403 origin", async () => {
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
      "/medium.com/post?as=md&browser=kitesurf",
      undefined,
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    expect(await res.text()).toBe(markdown);

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
});

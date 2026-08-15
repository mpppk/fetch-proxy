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
});

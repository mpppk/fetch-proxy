import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchYouTubeOEmbed, youtubeWatchUrl } from "./youtube";

const VIDEO_ID = "dQw4w9WgXcQ";
const WATCH_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

describe("youtubeWatchUrl", () => {
  it.each([
    ["watch page", `https://www.youtube.com/watch?v=${VIDEO_ID}`],
    ["bare host", `https://youtube.com/watch?v=${VIDEO_ID}`],
    ["mobile host", `https://m.youtube.com/watch?v=${VIDEO_ID}`],
    ["music host", `https://music.youtube.com/watch?v=${VIDEO_ID}`],
    ["nocookie host", `https://www.youtube-nocookie.com/embed/${VIDEO_ID}`],
    ["short link", `https://youtu.be/${VIDEO_ID}`],
    ["shorts", `https://www.youtube.com/shorts/${VIDEO_ID}`],
    ["live", `https://www.youtube.com/live/${VIDEO_ID}`],
    ["embed", `https://www.youtube.com/embed/${VIDEO_ID}`],
    ["legacy /v/", `https://www.youtube.com/v/${VIDEO_ID}`],
    ["uppercase host", `https://WWW.YouTube.com/watch?v=${VIDEO_ID}`],
    ["trailing slash", `https://www.youtube.com/watch/?v=${VIDEO_ID}`],
  ])("canonicalises %s", (_label, url) => {
    expect(youtubeWatchUrl(url)).toBe(WATCH_URL);
  });

  it("drops share tracking params such as ?si=", () => {
    expect(
      youtubeWatchUrl(`https://youtu.be/${VIDEO_ID}?si=AbC-123&t=42`),
    ).toBe(WATCH_URL);
  });

  it("keeps the video id when extra path segments follow it", () => {
    expect(youtubeWatchUrl(`https://youtu.be/${VIDEO_ID}/extra`)).toBe(
      WATCH_URL,
    );
  });

  it.each([
    ["a channel page", "https://www.youtube.com/@RickAstleyYT"],
    ["a playlist", "https://www.youtube.com/playlist?list=PL123"],
    ["a watch page without v", "https://www.youtube.com/watch"],
    ["a watch page with an empty v", "https://www.youtube.com/watch?v="],
    ["the short host root", "https://youtu.be/"],
    [
      "an id with illegal characters",
      "https://www.youtube.com/watch?v=abc%20def",
    ],
    ["a lookalike host", "https://notyoutube.com/watch?v=dQw4w9WgXcQ"],
    ["another site", "https://example.com/watch?v=dQw4w9WgXcQ"],
    ["a non-URL", "not a url"],
  ])("returns null for %s", (_label, url) => {
    expect(youtubeWatchUrl(url)).toBeNull();
  });
});

describe("fetchYouTubeOEmbed", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(response: Response) {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("requests the oEmbed endpoint with the watch url encoded", async () => {
    const fetchMock = stubFetch(jsonResponse({ title: "A video" }));

    await fetchYouTubeOEmbed(WATCH_URL);

    expect(fetchMock).toHaveBeenCalledWith(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(WATCH_URL)}`,
      expect.anything(),
    );
  });

  it("returns the title, channel and thumbnail", async () => {
    stubFetch(
      jsonResponse({
        title: "  Never Gonna Give You Up  ",
        author_name: "Rick Astley",
        thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        provider_name: "YouTube",
      }),
    );

    expect(await fetchYouTubeOEmbed(WATCH_URL)).toEqual({
      title: "Never Gonna Give You Up",
      authorName: "Rick Astley",
      thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    });
  });

  it("leaves missing optional fields empty", async () => {
    stubFetch(jsonResponse({ title: "A video" }));

    expect(await fetchYouTubeOEmbed(WATCH_URL)).toEqual({
      title: "A video",
      authorName: "",
      thumbnailUrl: "",
    });
  });

  it.each([
    ["a private video (401)", () => jsonResponse({}, 401)],
    ["a removed video (404)", () => new Response("Not Found", { status: 404 })],
    ["an unknown id (400)", () => new Response("Bad Request", { status: 400 })],
    ["a titleless record", () => jsonResponse({ author_name: "Someone" })],
    ["a blank title", () => jsonResponse({ title: "   " })],
    ["a non-object body", () => jsonResponse("nope")],
    ["a malformed body", () => new Response("<html>", { status: 200 })],
  ])("returns null for %s", async (_label, makeResponse) => {
    stubFetch(makeResponse());
    expect(await fetchYouTubeOEmbed(WATCH_URL)).toBeNull();
  });

  it("returns null when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    expect(await fetchYouTubeOEmbed(WATCH_URL)).toBeNull();
  });
});

/**
 * YouTube video titles via the public oEmbed endpoint.
 *
 * YouTube does not serve watch pages to datacenter clients: requests from a
 * Worker come back either as a reCAPTCHA interstitial (HTTP 429) or as a
 * JS-only shell whose `<title>` is the bare word "YouTube" and which carries no
 * `og:title`. Neither the origin HTML nor a Browser Rendering pass (same IP
 * range, same interstitial) can recover the video title from that.
 *
 * `https://www.youtube.com/oembed` is a documented, key-less endpoint that
 * answers those same requests with the video title, channel and thumbnail, so
 * `as=meta` reads YouTube video metadata from there instead.
 */

/** Video metadata from oEmbed. Fields absent from the response are "". */
export type YouTubeOEmbed = {
  title: string;
  authorName: string;
  thumbnailUrl: string;
};

/**
 * Characters a video ID is made of. Length is deliberately not checked: IDs are
 * 11 characters today, and a wrong guess costs nothing — oEmbed answers 400 for
 * an ID it does not recognise and the caller falls back to the origin HTML.
 */
const VIDEO_ID = /^[\w-]+$/;

/** youtube.com and its subdomains (www, m, music), plus the nocookie variant. */
const YOUTUBE_HOST = /^(?:[\w-]+\.)*youtube(?:-nocookie)?\.com$/;

/** Path forms that carry the video ID as a segment rather than the `v` query. */
const ID_PATH = /^\/(?:shorts|live|embed|v)\/([^/]+)/;

const SHORT_HOST = "youtu.be";

/**
 * Canonical watch URL for a YouTube video URL, or null when the URL does not
 * point at a single video.
 *
 * Every known link shape is folded onto `https://www.youtube.com/watch?v=<id>`:
 * `youtu.be/<id>` (what the mobile share sheet produces), `/shorts/<id>`,
 * `/live/<id>`, `/embed/<id>`, `/v/<id>` and the `m.`/`music.` subdomains.
 * Canonicalising also drops share tracking parameters such as `?si=`.
 *
 * Non-video pages — channels, playlists, search — return null, so they keep
 * going through the normal origin fetch.
 */
export function youtubeWatchUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, "") || "/";

  let id: string | null = null;
  if (host === SHORT_HOST || host.endsWith(`.${SHORT_HOST}`)) {
    id = path.slice(1).split("/")[0] || null;
  } else if (YOUTUBE_HOST.test(host)) {
    id =
      path === "/watch"
        ? url.searchParams.get("v")
        : (path.match(ID_PATH)?.[1] ?? null);
  }

  if (!id || !VIDEO_ID.test(id)) return null;
  return `https://www.youtube.com/watch?v=${id}`;
}

/**
 * oEmbed is a single small JSON request, so it gets a much tighter budget than
 * the page fetches around it: when it is slow it is unreachable, and the origin
 * fallback still has to run afterwards.
 */
const OEMBED_TIMEOUT_MS = 5000;

/**
 * Fetch a video's oEmbed record.
 *
 * Returns null for anything the caller cannot use — a private (401), removed
 * (404) or malformed (400) video, a network failure, or a record without a
 * title — so `as=meta` falls back to reading the origin HTML.
 */
export async function fetchYouTubeOEmbed(
  watchUrl: string,
): Promise<YouTubeOEmbed | null> {
  const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl)}`;

  try {
    const res = await fetch(endpoint, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const raw: unknown = await res.json();
    if (!raw || typeof raw !== "object") return null;
    const data = raw as Record<string, unknown>;

    const asString = (value: unknown): string =>
      typeof value === "string" ? value.trim() : "";

    const title = asString(data.title);
    if (!title) return null;

    return {
      title,
      authorName: asString(data.author_name),
      thumbnailUrl: asString(data.thumbnail_url),
    };
  } catch (e) {
    console.error("fetchYouTubeOEmbed error:", e);
    return null;
  }
}

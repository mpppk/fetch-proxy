import { Hono } from 'hono'
import { parseHTML } from 'linkedom'

// Polyfill global document/DOMParser for defuddle/turndown in workerd (Cloudflare Workers)
// Must run before defuddle is imported, because turndown's canParseHTMLNatively runs at module load
if (typeof (globalThis as any).document === 'undefined') {
  try {
    const win: any = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
    const doc = win.document ?? win
    ;(globalThis as any).document = doc
    ;(globalThis as any).window = win
    if (win.DOMParser) (globalThis as any).DOMParser = win.DOMParser
    if (win.Node) (globalThis as any).Node = win.Node
    if (win.Element) (globalThis as any).Element = win.Element
    if (win.HTMLElement) (globalThis as any).HTMLElement = win.HTMLElement
    if (win.NodeFilter) (globalThis as any).NodeFilter = win.NodeFilter
    if (win.Text) (globalThis as any).Text = win.Text
    // Ensure document.implementation exists for turndown fallback
    if (!doc.implementation) {
      // linkedom's document should have implementation via defaultView, but ensure it exists
      // Create a minimal stub if missing
      ;(doc as any).implementation = {
        createHTMLDocument: (title: string) => {
          const w: any = parseHTML(`<!DOCTYPE html><html><head><title>${title}</title></head><body></body></html>`)
          return w.document
        },
      }
    }
  } catch {}
}

type Bindings = {
  BROWSER: BrowserRun
}

const app = new Hono<{ Bindings: Bindings }>()

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
} as const

function withCors(headers: Record<string, string> = {}): Record<string, string> {
  return { ...corsHeaders, ...headers }
}

type PageMeta = {
  title: string
  ogTitle: string
  ogDescription: string
  ogSiteName: string
  ogImage: string
  description: string
}

const emptyMeta: PageMeta = {
  title: '',
  ogTitle: '',
  ogDescription: '',
  ogSiteName: '',
  ogImage: '',
  description: '',
}

// Read a meta tag's content, tolerating property/name and escaped-colon variants
function metaContent(document: any, key: string): string {
  const el =
    document.querySelector(`meta[property="${key}"]`) ??
    document.querySelector(`meta[name="${key}"]`) ??
    document.querySelector(`meta[property="${key.replace(':', '\\:')}"]`)
  return el?.getAttribute('content')?.trim() ?? ''
}

// Regex fallback used when the HTML cannot be parsed at all
function metaContentByRegex(html: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`, 'i'),
  ]
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match?.[1]?.trim()) return match[1].trim()
  }
  return ''
}

function extractMeta(html: string): PageMeta {
  try {
    const { document } = parseHTML(html)
    return {
      title: document.querySelector('title')?.textContent?.trim() ?? '',
      ogTitle: metaContent(document, 'og:title'),
      ogDescription: metaContent(document, 'og:description'),
      ogSiteName: metaContent(document, 'og:site_name'),
      ogImage: metaContent(document, 'og:image'),
      description: metaContent(document, 'description'),
    }
  } catch {
    // fallback regex if parse fails
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i)
    return {
      ...emptyMeta,
      title: titleMatch?.[1]?.trim() ?? '',
      ogTitle: metaContentByRegex(html, 'og:title'),
      ogDescription: metaContentByRegex(html, 'og:description'),
      ogSiteName: metaContentByRegex(html, 'og:site_name'),
      ogImage: metaContentByRegex(html, 'og:image'),
      description: metaContentByRegex(html, 'description'),
    }
  }
}

function extractTitle(meta: PageMeta): string {
  return meta.ogTitle || meta.title || ''
}

// A page whose HTML carries neither og:title nor <title> is almost always a
// client-side rendered SPA: the origin serves an empty shell and the real head
// is written by JS. Signals that Browser Rendering is worth the round trip.
function needsRendering(meta: PageMeta): boolean {
  return !meta.ogTitle && !meta.title
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
  }
}

async function tryDefuddle(html: string, url: string): Promise<string | null> {
  const win: any = parseHTML(html)
  const document: any = win.document
  const g: any = globalThis
  const prevDocument = g.document
  const prevWindow = g.window
  const prevDOMParser = g.DOMParser
  const prevNode = g.Node
  const prevElement = g.Element
  const prevHTMLElement = g.HTMLElement
  const prevNodeFilter = g.NodeFilter
  const prevText = g.Text
  try {
    g.document = document
    g.window = win
    if (win.DOMParser) g.DOMParser = win.DOMParser
    if (win.Node) g.Node = win.Node
    if (win.Element) g.Element = win.Element
    if (win.HTMLElement) g.HTMLElement = win.HTMLElement
    if (win.NodeFilter) g.NodeFilter = win.NodeFilter
    if (win.Text) g.Text = win.Text
    if (!document.implementation) {
      ;(document as any).implementation = {
        createHTMLDocument: (title: string) => {
          const w: any = parseHTML(`<!DOCTYPE html><html><head><title>${title}</title></head><body></body></html>`)
          return w.document
        },
      }
    }

    // Dynamic import after polyfill so turndown's canParse check sees globals
    const { Defuddle: DefuddleFn } = await import('defuddle/node')
    const result = await DefuddleFn(document, url, { markdown: true })
    if (!result || !result.content) return null
    const md = (result.content as string).trim()
    if (!md) return null
    if (typeof result.wordCount === 'number' && result.wordCount < 10) {
      if (md.length < 50) return null
    }
    if (md.length < 20) return null
    return md
  } catch (e) {
    console.error('tryDefuddle error:', e)
    return null
  } finally {
    g.document = prevDocument
    g.window = prevWindow
    g.DOMParser = prevDOMParser
    g.Node = prevNode
    g.Element = prevElement
    g.HTMLElement = prevHTMLElement
    g.NodeFilter = prevNodeFilter
    g.Text = prevText
  }
}

// Titles change rarely, and browser renders are slow enough that a cold one can
// outlast a caller's timeout. Caching them keeps a user's retry cheap.
const BROWSER_META_CACHE_TTL_SECONDS = 600

/**
 * Re-fetch the page through Browser Rendering and extract its metadata from the
 * rendered DOM. Used by as=title / as=meta when the origin HTML has no title at
 * all, which is the case for client-side rendered SPAs.
 *
 * Images, media, fonts and stylesheets are blocked: nothing is painted here, and
 * skipping them makes `networkidle0` settle noticeably sooner.
 */
async function browserMeta(env: Bindings, targetUrl: string): Promise<PageMeta | null> {
  if (!env.BROWSER) return null
  try {
    const res = await env.BROWSER.quickAction('content', {
      url: targetUrl,
      gotoOptions: { waitUntil: 'load' },
      rejectResourceTypes: ['image', 'media', 'font', 'stylesheet'],
      bestAttempt: true,
      cacheTTL: BROWSER_META_CACHE_TTL_SECONDS,
    } as any)

    if (!res.ok) return null
    const data = (await res.json()) as {
      success: boolean
      result?: string
      meta?: { status?: number; title?: string }
    }
    if (!data.success || typeof data.result !== 'string') return null

    const meta = extractMeta(data.result)
    // Browser Rendering reports document.title separately, which survives even
    // when the SPA sets it without ever writing a <title> element we can parse.
    const documentTitle = data.meta?.title?.trim() ?? ''
    return { ...meta, title: meta.title || documentTitle }
  } catch (e) {
    console.error('browserMeta error:', e)
    return null
  }
}

async function browserMarkdown(env: Bindings, targetUrl: string): Promise<string | null> {
  if (!env.BROWSER) return null
  try {
    const res = await env.BROWSER.quickAction('markdown', {
      url: targetUrl,
      gotoOptions: { waitUntil: 'networkidle0' },
    } as any)

    // quickAction returns Response with JSON { success, result }
    if (!res.ok) {
      // try to parse error body for debugging but treat as failure
      return null
    }
    const ct = res.headers.get('Content-Type') || ''
    if (ct.includes('application/json')) {
      const data = (await res.json()) as { success: boolean; result?: string; errors?: unknown }
      if (data.success && typeof data.result === 'string' && data.result.trim().length > 0) {
        return data.result
      }
      return null
    } else {
      const text = await res.text()
      // if not JSON, maybe directly markdown
      if (text && text.trim().length > 0) {
        // try parse as JSON fallback
        try {
          const json = JSON.parse(text) as { success: boolean; result?: string }
          if (json.success && json.result) return json.result
        } catch {
          return text
        }
      }
      return null
    }
  } catch {
    return null
  }
}

// Handle CORS preflight for all paths
app.options('/*', (c) => {
  return new Response(null, {
    status: 204,
    headers: withCors(),
  })
})

// Health check / root
app.get('/', (c) => {
  const url = new URL(c.req.url)
  // if root accessed without target, show usage
  // but if user explicitly wants to fetch root with as param? Still show help
  if (url.pathname === '/' && !url.searchParams.has('as') && url.searchParams.toString() === '') {
    return c.text('fetch-proxy: use /<host>/<path>?as=html|title|meta|md', 200, withCors({ 'Content-Type': 'text/plain; charset=utf-8' }))
  }
  // otherwise fall through to proxy logic? For '/' we treat as missing target
  return c.text('missing target host: use /<host>/<path>', 400, withCors({ 'Content-Type': 'text/plain; charset=utf-8' }))
})

app.on(['GET', 'HEAD'], '/*', async (c) => {
  const rawUrl = new URL(c.req.url)
  const pathname = rawUrl.pathname

  // pathname is like /example.com/foo
  if (!pathname || pathname === '/' || pathname === '') {
    return c.text('missing target host: use /<host>/<path>', 400, withCors({ 'Content-Type': 'text/plain; charset=utf-8' }))
  }

  let hostAndPath = pathname.slice(1) // remove leading /

  if (!hostAndPath) {
    return c.text('missing target host: use /<host>/<path>', 400, withCors({ 'Content-Type': 'text/plain; charset=utf-8' }))
  }

  // Support both fetch.nibo.sh/example.com and fetch.nibo.sh/https://example.com
  // Strip leading http:// or https:// if present (user may pass full URL)
  if (hostAndPath.startsWith('https://')) {
    hostAndPath = hostAndPath.slice(8)
  } else if (hostAndPath.startsWith('http://')) {
    hostAndPath = hostAndPath.slice(7)
  } else if (hostAndPath.startsWith('https:/') && !hostAndPath.startsWith('https://')) {
    hostAndPath = hostAndPath.replace(/^https:\/+/, '')
  } else if (hostAndPath.startsWith('http:/') && !hostAndPath.startsWith('http://')) {
    hostAndPath = hostAndPath.replace(/^http:\/+/, '')
  }

  if (!hostAndPath) {
    return c.text('missing target host: use /<host>/<path>', 400, withCors({ 'Content-Type': 'text/plain; charset=utf-8' }))
  }

  // Basic validation: hostAndPath should not contain whitespace, should contain at least a dot or be localhost
  // If it contains '?' or '#', those are not in pathname (they are in search/hash)
  // Decode check
  if (hostAndPath.includes(' ')) {
    return c.text('invalid target host', 400, withCors({ 'Content-Type': 'text/plain; charset=utf-8' }))
  }

  // as param handling
  const asValues = rawUrl.searchParams.getAll('as')
  if (asValues.length > 1) {
    return c.text('as parameter cannot be specified multiple times', 400, withCors({ 'Content-Type': 'text/plain; charset=utf-8' }))
  }
  let as = asValues[0] ?? 'html'
  if (!['html', 'title', 'meta', 'md'].includes(as)) {
    return c.text(`invalid as value: ${as}. allowed: html, title, meta, md`, 400, withCors({ 'Content-Type': 'text/plain; charset=utf-8' }))
  }

  // Build forward query (exclude 'as')
  const forwardParams = new URLSearchParams()
  for (const [k, v] of rawUrl.searchParams.entries()) {
    if (k !== 'as') forwardParams.append(k, v)
  }
  let targetUrl = `https://${hostAndPath}`
  const qs = forwardParams.toString()
  if (qs) targetUrl += `?${qs}`

  // Validate target URL
  try {
    const u = new URL(targetUrl)
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') {
      // allow but still check hostname exists
      // we will allow if it looks like hostname, but if no dot, it's likely invalid
      // For now, don't block strictly - some internal hosts may not have dot
    }
  } catch {
    return c.text('invalid target URL', 400, withCors({ 'Content-Type': 'text/plain; charset=utf-8' }))
  }

  // Fetch target
  let originRes: Response
  try {
    originRes = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'fetch-proxy/1.0 (+https://fetch.nibk.sh)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ja;q=0.8',
      },
      redirect: 'follow',
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return c.text(`failed to fetch target: ${msg}`, 502, withCors({ 'Content-Type': 'text/plain; charset=utf-8' }))
  }

  // If origin returns error status, proxy it with CORS (for html mode we proxy as is, for others we still proxy error)
  if (!originRes.ok) {
    const body = await originRes.text()
    const contentType = originRes.headers.get('Content-Type') || 'text/plain; charset=utf-8'
    return new Response(body, {
      status: originRes.status,
      headers: withCors({ 'Content-Type': contentType }),
    })
  }

  const contentType = originRes.headers.get('Content-Type') || ''

  // as=html : return HTML as is
  if (as === 'html') {
    const body = await originRes.text()
    const ct = contentType.includes('text/html') ? contentType : 'text/html; charset=utf-8'
    return new Response(body, {
      headers: withCors({ 'Content-Type': ct }),
    })
  }

  // as=title / as=meta : extract <title> and OGP metadata, falling back to
  // Browser Rendering when the origin HTML has no title (client-side rendered
  // SPAs serve an empty shell, so string parsing alone yields nothing).
  if (as === 'title' || as === 'meta') {
    const html = await originRes.text()
    let meta = extractMeta(html)

    if (needsRendering(meta)) {
      const rendered = await browserMeta(c.env, targetUrl)
      if (rendered) meta = mergeMeta(meta, rendered)
    }

    if (as === 'title') {
      return new Response(extractTitle(meta), {
        headers: withCors({ 'Content-Type': 'text/plain; charset=utf-8' }),
      })
    }

    return new Response(JSON.stringify(meta), {
      headers: withCors({ 'Content-Type': 'application/json; charset=utf-8' }),
    })
  }

  // as=md : markdown conversion
  if (as === 'md') {
    const html = await originRes.text()

    // First try defuddle
    let markdown = await tryDefuddle(html, targetUrl)

    const isDefuddleSuccess = markdown !== null && markdown.trim().length >= 20

    if (!isDefuddleSuccess) {
      // fallback to Browser Rendering
      const brMarkdown = await browserMarkdown(c.env, targetUrl)
      if (brMarkdown && brMarkdown.trim().length > 0) {
        markdown = brMarkdown
      } else if (!markdown) {
        // if both fail, return error or empty? Return 502 or 500 with message
        // Prefer to return defuddle error if we have nothing
        // For debugging, return 502
        // But spec says switch to Browser Run if defuddle fails, so if Browser also fails, return 502
        if (!brMarkdown) {
          // if defuddle returned null and browser failed, try returning whatever we have or error
          // As last resort, return empty markdown with 200? Better to return 500
          return c.text('failed to convert to markdown: both defuddle and Browser Rendering failed', 502, withCors({ 'Content-Type': 'text/plain; charset=utf-8' }))
        }
      }
    }

    return new Response(markdown ?? '', {
      headers: withCors({ 'Content-Type': 'text/markdown; charset=utf-8' }),
    })
  }

  // fallback (should not reach)
  return c.text('unsupported as value', 400, withCors({ 'Content-Type': 'text/plain; charset=utf-8' }))
})

// Fallback for other methods - proxy similarly but only GET is expected
app.all('/*', async (c) => {
  if (c.req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: withCors() })
  }
  // For non-GET, we still handle as GET proxy? Or return 405
  // To keep CORS compatibility, proxy GET logic but with original method?
  // For simplicity, only allow GET/HEAD/OPTIONS
  return c.text(`method ${c.req.method} not allowed`, 405, withCors({ 'Content-Type': 'text/plain; charset=utf-8' }))
})

export default app

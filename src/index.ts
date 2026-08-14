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

function extractTitle(html: string): string {
  try {
    const { document } = parseHTML(html)
    // og:title - check property and name variants
    const ogMeta =
      document.querySelector('meta[property="og:title"]') ??
      document.querySelector('meta[name="og:title"]') ??
      document.querySelector('meta[property="og\\:title"]')
    const ogContent = ogMeta?.getAttribute('content')?.trim()
    if (ogContent && ogContent.length > 0) {
      return ogContent
    }
    const titleEl = document.querySelector('title')
    const titleText = titleEl?.textContent?.trim()
    if (titleText && titleText.length > 0) {
      return titleText
    }
    return ''
  } catch {
    // fallback regex if parse fails
    const ogMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
    if (ogMatch?.[1]?.trim()) return ogMatch[1].trim()
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i)
    if (titleMatch?.[1]?.trim()) return titleMatch[1].trim()
    return ''
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
    return c.text('fetch-proxy: use /<host>/<path>?as=html|title|md', 200, withCors({ 'Content-Type': 'text/plain; charset=utf-8' }))
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
  if (!['html', 'title', 'md'].includes(as)) {
    return c.text(`invalid as value: ${as}. allowed: html, title, md`, 400, withCors({ 'Content-Type': 'text/plain; charset=utf-8' }))
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

  // as=title : extract title
  if (as === 'title') {
    const html = await originRes.text()
    const title = extractTitle(html)
    return new Response(title, {
      headers: withCors({ 'Content-Type': 'text/plain; charset=utf-8' }),
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

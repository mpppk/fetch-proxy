# fetch-proxy

CORS 付きの汎用 fetch プロキシ (Cloudflare Workers + Hono)。任意の `https://` URL を `https://fetch.nibo.sh/<host>/<path>` 経由で取得し、`html` / `meta` / `markdown` 形式で返却します。

* **Production:** `https://fetch.nibo.sh` (`wrangler.jsonc:11` routes)
* **Workers.dev:** `https://fetch-proxy.<account>.workers.dev` (`workers_dev: true`)

## 特徴

* **CORS 対応** — `Access-Control-Allow-Origin: *`, `GET/HEAD/OPTIONS` を許可
* **`as=html`** — オリジン HTML をそのままプロキシ（`Content-Type` 維持、無い場合は `text/html; charset=utf-8`）
* **`as=meta`** — `<title>` と OGP メタ情報 (`og:title` / `og:description` / `og:site_name` / `og:image` / `description`) を JSON で返却
* **SPA フォールバック** — `as=meta` でオリジン HTML に `og:title` も `<title>` も無い場合、`quickAction('content')` (Browser Rendering) でレンダリング後の DOM から再抽出
* **YouTube 対応** — `as=meta` で動画 URL (`youtu.be/<id>` / `watch?v=` / `shorts` / `live` / `embed`) は oEmbed から動画タイトルとサムネイルを取得（YouTube は Worker からのアクセスに CAPTCHA 画面を返し、HTML からはタイトルが取れないため）
* **`as=md`** — `defuddle` (`defuddle/node`) で本文抽出 → Markdown 変換、失敗時は `BROWSER` binding の `quickAction('markdown')` (Browser Rendering) にフォールバック (`src/index.ts:133`)
* **クエリ転送** — `as` 以外の全クエリを `https://<host>/<path>?<forwarded>` に転送
* **`https://` プレフィックス許容** — `/https://example.com/foo` や `/http://example.com/foo` も自動剥離
* **オリジンエラー中継** — オリジンが 4xx/5xx ならステータスと body を CORS 付与でそのまま中継

## クイックスタート

```sh
# 取得
curl https://fetch.nibo.sh/example.com/

# メタ情報を JSON で取得
curl https://fetch.nibo.sh/example.com/?as=meta

# Markdown 変換
curl https://fetch.nibo.sh/example.com/articles/123?as=md

# クエリ付き + https:// プレフィックス形式
curl "https://fetch.nibo.sh/https://example.com/search?q=hello&lang=ja&as=md"
```

ブラウザからは通常の `fetch` で利用できます（CORS 不要）:

```js
// meta (JSON)
const meta = await fetch("https://fetch.nibo.sh/example.com/?as=meta").then(r => r.json());

// markdown
const md = await fetch("https://fetch.nibo.sh/example.com/blog/post?as=md").then(r => r.text());

// html
const html = await fetch("https://fetch.nibo.sh/example.com/?as=html").then(r => r.text());
```

## API

### ベース URL

```
https://fetch.nibo.sh
```

### エンドポイント

| Method | Path | 説明 |
|--------|------|------|
| `GET` | `/` | `as` なしなら利用方法を返す `200 text/plain: "fetch-proxy: use /<host>/<path>?as=html\|meta\|md"`。それ以外は `400` |
| `GET` | `/{proxyPath}` | プロキシ本体。`proxyPath` は `example.com/foo` 形式（`https://` 付きも可）。`src/index.ts:192` で `pathname.slice(1)` を `hostAndPath` として処理 |
| `HEAD` | `/{proxyPath}` | `GET` と同ルーティング（ヘッダのみ） |
| `OPTIONS` | `/*` | CORS preflight → `204` + CORS ヘッダ |

### パスパラメータ

* **`proxyPath`** (path, required) — `host + "/" + path`。例: `example.com`, `example.com/foo/bar`, `https://example.com/foo`。空白を含むと `400 invalid target host`。

### クエリパラメータ

| 名前 | 必須 | 型 | デフォルト | 説明 |
|------|------|----|-----------|------|
| `as` | no | `html \| meta \| md` | `html` | レスポンス形式。複数回指定すると `400 as parameter cannot be specified multiple times` |
| `*` (その他) | no | string | - | `as` 以外は全て転送先 URL に付与。例: `/example.com/search?q=hello&as=md` → `https://example.com/search?q=hello` |

### レスポンス

| `as` | `Content-Type` | Body 例 |
|------|----------------|---------|
| `html` | `text/html; charset=utf-8` (オリジンの `Content-Type` が `text/html` を含む場合はそれを維持) | `<!DOCTYPE html>...` |
| `meta` | `application/json; charset=utf-8` | `{"title":"Example Domain","ogTitle":"","ogDescription":"","ogSiteName":"","ogImage":"","description":""}`（取得できないキーは `""`） |
| `md` | `text/markdown; charset=utf-8` | `# Example Domain\n\nThis domain is for...` |

全成功レスポンスに CORS ヘッダ付与:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, HEAD, OPTIONS
Access-Control-Allow-Headers: *
Access-Control-Max-Age: 86400
```

### エラー

| Status | Body (`text/plain`) | 条件 |
|--------|---------------------|------|
| `400` | `missing target host: use /<host>/<path>` | パスが `/` |
| `400` | `invalid target host` | 空白含む |
| `400` | `invalid target URL` | URL パース失敗 |
| `400` | `as parameter cannot be specified multiple times` | `as` 重複 (`getAll` >1) |
| `400` | `invalid as value: foo. allowed: html, meta, md` | 不正な `as` |
| `400` | `as=title has been removed. use as=meta and read ogTitle, falling back to title` | 廃止された `as=title` |
| `502` | `failed to fetch target: ...` | `fetch(targetUrl)` 例外 |
| `502` | `failed to convert to markdown: both defuddle and Browser Rendering failed` | `as=md` で両フォールバック失敗 |
| `4xx/5xx` | オリジンの body をそのまま | オリジンが非 2xx（CORS 付与で中継） |
| `405` | `method xxx not allowed` | `GET/HEAD/OPTIONS` 以外  |

### 使用例

```sh
# 1. HTML プロキシ (default)
curl -i https://fetch.nibo.sh/example.com/

# 2. メタ情報 (title + OGP) を JSON で取得
curl https://fetch.nibo.sh/example.com/?as=meta
# => {"title":"Example Domain","ogTitle":"","ogDescription":"","ogSiteName":"","ogImage":"","description":""}

# 3. CSR の SPA でも Browser Rendering フォールバックでタイトルが取れる
curl https://fetch.nibo.sh/z.ai/blog/glm-5.3?as=meta
# => {"title":"GLM-5.3: Frontier Coding with Emergent Cyber Capabilities",...}

# 4. YouTube は oEmbed 経由で動画タイトルが取れる
curl "https://fetch.nibo.sh/youtu.be/jNQXAC9IVRw?as=meta"
# => {"title":"Me at the zoo - YouTube","ogTitle":"Me at the zoo","ogDescription":"","ogSiteName":"YouTube","ogImage":"https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg","description":""}

# 5. Markdown (defuddle → Browser fallback)
curl https://fetch.nibo.sh/example.com/articles/123?as=md
# => # Article Title
#    Article body...

# 6. クエリ転送
curl "https://fetch.nibo.sh/example.com/search?q=cloudflare&lang=ja&as=html"
# => https://example.com/search?q=cloudflare&lang=ja を取得

# 7. https:// プレフィックス付き入力
curl https://fetch.nibo.sh/https://example.com/foo?as=meta

# 8. CORS確認
curl -i -X OPTIONS https://fetch.nibo.sh/example.com/ -H "Origin: https://example.com"
# => 204 + CORS headers

# 9. ブラウザ JS
const md = await fetch("https://fetch.nibo.sh/example.com/blog?as=md").then(r => {
  if (!r.ok) throw new Error(r.status);
  return r.text();
});
```

## OpenAPI

OpenAPI 3.1 スキーマを同梱しています:

* `openapi.yaml` — YAML 原本
* `openapi.json` — JSON (`npx js-yaml openapi.yaml > openapi.json`)

Redocly で検証済み: `npx @redocly/cli lint openapi.yaml` → `Woohoo! Your API description is valid`

Swagger UI / Scalar / Stoplight などでそのまま読み込めます。

## 開発

```sh
npm install
npm run dev        # wrangler dev (ローカル)
npm run deploy     # wrangler deploy --minify → fetch.nibo.sh (手動デプロイ。通常は CD 任せ)
npm run cf-typegen # wrangler types --env-interface CloudflareBindings → worker-configuration.d.ts
```

### デプロイ (CD)

`main` への push で **Cloudflare Workers Builds** がビルドとデプロイを行う。設定はリポジトリではなくダッシュボード側 (**Workers & Pages → fetch-proxy → Settings → Build**) にあるため、変更時はそちらを見る。

| 設定 | 値 | 理由 |
|------|-----|------|
| Branch control (production branch) | `main` | |
| Deploy command | `bun run deploy` | 既定の `npx wrangler deploy` だと `--minify` が付かない |
| Worker 名 | `fetch-proxy` | `wrangler.jsonc` の `name` と一致していないとビルドが失敗する |

注意点:

* リポジトリを接続しただけでは現在の HEAD は遡ってデプロイされない。**push イベントか、ダッシュボードからの手動ビルドが要る**
* 「Builds for non-production branches」を有効にすると、`main` 以外への push でも `wrangler versions upload` (プレビュー版) が走る
* GitHub Actions (`.github/workflows/ci.yml`) は **CI のみでデプロイはしない**。デプロイ元を二重にしないため、`main` への push でも Actions からは何もデプロイされない
* デプロイ後の健全性は毎時の `Smoke Test` ワークフローが見る。手元で確認したい場合は `bun run smoke [BASE_URL]`

### 型

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>()
```

`CloudflareBindings` は `wrangler types` で生成 (`worker-configuration.d.ts:1`)。`BROWSER` binding を使用。

### 設定 (`wrangler.jsonc`)

```jsonc
{
  "name": "fetch-proxy",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-11",
  "compatibility_flags": ["nodejs_compat"],
  "browser": { "binding": "BROWSER" },
  "workers_dev": true,
  "routes": [{ "pattern": "fetch.nibo.sh/*", "zone_name": "nibo.sh" }],
  "observability": {
    "enabled": true,
    "logs": { "enabled": true, "head_sampling_rate": 1 },
    "traces": { "enabled": true, "head_sampling_rate": 1 }
  }
}
```

### 監視 (Workers Logs / Workers Traces)

`observability` で Workers Logs と Workers Traces を有効にしている。ダッシュボードの **Workers & Pages → fetch-proxy → Observability** から、invocation ログ・`console.*` の出力・例外と、リクエストごとのスパン (origin への `fetch`、Browser Rendering 呼び出しなど) を確認できる。

* `head_sampling_rate` は両方とも `1` (100%)。個人利用の低トラフィックなので全件取れる。転送量が増えたら下げる
* ログの保持は 7 日。それ以上残したい場合は OpenTelemetry export か Logpush を足す
* Traces は `observability.enabled` では有効にならず、`observability.traces.enabled` を明示する必要がある (2026-08 時点)
* `observability` は**スクリプト単位の設定**で、`wrangler deploy`（= `main` の本番ビルド）でしか反映されない。ブランチのプレビュー (`wrangler versions upload`) では適用されないので、PR のプレビュー URL を叩いてもログは出ない
* 反映後の確認は API でもできる:
  ```sh
  curl -s "https://api.cloudflare.com/client/v4/accounts/<account_id>/workers/scripts/fetch-proxy/settings" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq .result.observability
  ```

## 実装メモ

* **Polyfill:** `workerd` では `document`/`DOMParser` が無いため、`linkedom` の `parseHTML` でグローバルを polyfill してから `defuddle/node` を動的 import (`src/index.ts:6`, `src/index.ts:77`)
* **meta 抽出:** `extractMeta()` が `<title>` と各 OGP を一括抽出。各キーは `meta[property=...]` → `meta[name=...]` → エスケープ付き `property` の順で探索し、HTML パース失敗時は regex フォールバック
* **SPA フォールバック:** オリジン HTML はレンダリング前の状態なので、CSR の SPA（例: `z.ai/blog/*`）は `<div id="root"></div>` だけを返しタイトルが取れない。`needsRendering()`（`og:title` も `<title>` も空）が真なら `browserMeta()` が `quickAction('content')` でレンダリング後の HTML を取得し、同じ `extractMeta()` を適用する。`<title>` 要素が無いまま `document.title` だけ設定する SPA のために、Browser Rendering の `meta.title` も併用。取得済みの値は `mergeMeta()` でオリジン HTML 側を優先し、空欄のみ埋める
* **SPA フォールバックのコスト:** ヘッド情報しか要らないため `waitUntil: 'load'` + 画像/メディア/フォント/CSS を `rejectResourceTypes` でブロックして待ち時間を削減。それでもコールドで数秒かかるので `cacheTTL: 600` を指定し、リトライを安く済ませる。`og:title` か `<title>` がある通常のページではブラウザを一切起動しない
* **YouTube (oEmbed):** YouTube は Worker（データセンター IP）からの watch ページ取得に reCAPTCHA 画面 (429) か「YouTube」とだけ書かれた JS シェルを返すため、オリジン HTML からも Browser Rendering からも動画タイトルが取れない。`as=meta` では origin fetch の前に `youtubeWatchUrl()` が動画 URL を `https://www.youtube.com/watch?v=<id>` に正規化し（`youtu.be` / `shorts` / `live` / `embed` / `/v/` / `m.` / `music.` / `?si=` 除去に対応）、キー不要の `https://www.youtube.com/oembed` から取得する (`src/youtube.ts`)。オリジンの 429 はこの分岐より手前で中継されてしまうので、順序が重要。非公開・削除済み動画やチャンネル/プレイリスト URL では従来どおりオリジン HTML にフォールバックする
* **md 変換:** `Defuddle(document, url, {markdown:true})` の `wordCount <10 && md.length <50` または `md.length <20` は失敗扱い → Browser Rendering へ (`src/index.ts:113`, `src/index.ts:315`)
* **Browser Rendering:** `env.BROWSER.quickAction('markdown', {url, gotoOptions:{waitUntil:'networkidle0'}})` (`src/index.ts:136`)、JSON `{success, result}` をパース

## ライセンス

MIT

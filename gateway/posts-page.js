// Posts over HTTP: the index's API, a page per post, a name's list of posts and its Atom feed.
//
// Served in two places:
//   - POSTS_HOST (posts.wei.domains): the API under /api, recent posts at /, and any name, subnames
//     at any depth included, at /<name>.wei/ — a subname has no host of its own unless its parent
//     has a wildcard certificate, so this is every post's canonical address.
//   - a name's own host (alice.wei.limo), at / and /posts/…, while the name has no website set.
//     A website, once set, takes the whole host.
//
// Bodies are rendered by markdown.js, which escapes everything. Pages run no scripts at all (the
// CSP says so), and follow the reader's light/dark preference with CSS alone.

import { renderMarkdown, excerpt, imageUrl } from './markdown.js'
import { MAX_POST_BYTES, POST_PATH, parsePost, postHash, postPath } from './posts-format.js'
import { renderCard } from './share-card.js'
import { XPOST_STYLE, embedXPosts } from './x-embed.js'

export const POSTS_HOST = 'posts.wei.domains'
const DAPP = 'https://wei.domains'
const SPEC = 'https://github.com/src-company/wei-names/blob/main/posts/SPEC.md'
const MAX_BODY = MAX_POST_BYTES + 1024
// A draft previewed with every picture inline, before the editor moves them into image posts
// (posts/SPEC.md, "Images in other posts"), can be larger than one post.
const MAX_PREVIEW_BODY = 4 * 1024 * 1024
const SYNC_WAIT_MS = 8_000

export const POST_CSP = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))
const iso = (t) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
const short = (hex) => `${hex.slice(0, 10)}…${hex.slice(-6)}`
// A post's date as people read it: "October 25, 2026". UTC, like the block time it comes from.
const humanDate = (t) => new Date(t * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })

// The dapp's look (dapp/theme.css): Helvetica, black on white, a quiet uppercase header.
const STYLE = `
:root{--bg:#fff;--fg:#000;--muted:#666;--dim:#999;--line:#ddd;--surface:#f9f9f9;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#e8e8e0;--muted:#888;--dim:#666;--line:#333;--surface:#111}}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg);max-width:640px;margin:0 auto;padding:60px 20px 80px;line-height:1.6;overflow-wrap:break-word}
a{color:inherit}
header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:40px}
header h1{font-size:14px;font-weight:400;letter-spacing:.1em;text-transform:uppercase}
header h1 a{text-decoration:none}
header nav{font-size:12px;color:var(--muted)}
.byline{font-size:13px;color:var(--muted);margin-bottom:8px}
.byline a{text-decoration:none}
.byline a:hover{text-decoration:underline}
h2.title{font-size:28px;font-weight:700;line-height:1.25;margin-bottom:6px;letter-spacing:-.01em}
.meta{font-size:12px;color:var(--muted);margin-bottom:32px}
.pending{display:inline-block;margin-left:8px;padding:0 6px;border:1px dashed var(--dim);font-size:11px}
.body{font-size:16px}
.body>*{margin-bottom:1em}
.body h2,.body h3,.body h4{line-height:1.3;margin-top:1.6em}
.body h2{font-size:21px}.body h3{font-size:18px}.body h4{font-size:16px}
.body ul,.body ol{padding-left:1.4em}
.body blockquote{border-left:2px solid var(--fg);padding-left:14px;color:var(--muted)}
.body code{font-family:ui-monospace,Menlo,monospace;font-size:.9em;background:var(--surface);padding:1px 4px}
.body pre{background:var(--surface);border:1px solid var(--line);padding:12px;overflow-x:auto}
.body pre code{background:none;padding:0}
.body img{max-width:100%;height:auto}
/* Captioned images only: an embedded X post is a figure too, with its own styles (x-embed.js). */
.body figure.pic{margin:1.4em 0}
.body figure.pic img{display:block;width:100%}
.body figure.pic figcaption{margin-top:6px;font-size:13px;line-height:1.4;color:var(--muted)}
.body hr{border:0;border-top:1px solid var(--line)}
.body math{font-size:1.05em}
.panel{margin-top:48px;border-top:1px solid var(--line);padding-top:16px;font-size:12px;color:var(--muted)}
.panel div{display:flex;gap:12px;padding:2px 0}
.panel span{min-width:96px;color:var(--dim)}
.panel a{font-family:ui-monospace,Menlo,monospace}
.cover{margin:0 0 28px}
.cover img{display:block;width:100%;height:auto;aspect-ratio:5/2;object-fit:cover;background:var(--surface)}
.list{list-style:none}
.list a.thumb{display:block;margin-bottom:10px}
.list a.thumb img{display:block;width:100%;aspect-ratio:5/2;object-fit:cover;background:var(--surface)}
.list li{padding:14px 0;border-bottom:1px solid var(--line)}
.list li:first-child{border-top:1px solid var(--line)}
.list a.t{font-size:17px;font-weight:700;text-decoration:none}
.list a.t:hover{text-decoration:underline}
.list .d{font-size:12px;color:var(--muted)}
.list p{font-size:14px;color:var(--muted);margin-top:2px}
.note{margin-top:40px;font-size:11px;color:var(--dim)}
.empty{font-size:14px;color:var(--muted)}
${XPOST_STYLE}`

function layout({ title, head = '', body, nav = '' }) {
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${escapeHtml(title)}</title><link rel="icon" href="${DAPP}/favicon.ico">${head}<style>${STYLE}</style>` +
    `<header><h1><a href="${DAPP}">wei name service</a></h1><nav>${nav}</nav></header>${body}` +
    `<p class="note">Posts on .wei names live in Ethereum blobs, vouched for by the name's owner. <a href="${SPEC}">How it works</a></p></html>`
}

function metaTags({ title, description, url, type = 'website', image = null, imageWidth, imageHeight, imageAlt }) {
  const tag = (attr, key, value) => `<meta ${attr}="${key}" content="${escapeHtml(value)}">`
  return `<link rel="canonical" href="${escapeHtml(url)}">` + tag('name', 'description', description) +
    tag('property', 'og:type', type) + tag('property', 'og:site_name', 'wei name service') +
    tag('property', 'og:title', title) + tag('property', 'og:description', description) + tag('property', 'og:url', url) +
    (image ? tag('property', 'og:image', image) + tag('name', 'twitter:image', image) : '') +
    (imageWidth ? tag('property', 'og:image:type', 'image/png') + tag('property', 'og:image:width', imageWidth) + tag('property', 'og:image:height', imageHeight) : '') +
    (imageAlt ? tag('property', 'og:image:alt', imageAlt) + tag('name', 'twitter:image:alt', imageAlt) : '') +
    tag('name', 'twitter:card', image ? 'summary_large_image' : 'summary') + tag('name', 'twitter:title', title) + tag('name', 'twitter:description', description)
}

// A post's cover (posts/SPEC.md, "Cover image"): an image alone on the body's first line, followed by
// a blank line or nothing. It needs no field of its own, so a reader that doesn't know covers still
// shows it, as the post's first image. Returns { cover: { url, alt } | null, body: the rest }.
const COVER_LINE = /^[ \t]*!\[([^\]\n]{0,300})\]\([ \t]*([^\s()<>]{1,200000})[ \t]*\)[ \t]*(?:\n[ \t]*\n|\n?$)/
export function splitCover(body) {
  const m = COVER_LINE.exec(String(body || '').replace(/^\s*\n/, ''))
  const url = m && imageUrl(m[2])
  if (!url) return { cover: null, body }
  return { cover: { url, alt: m[1].trim() }, body: String(body).replace(/^\s*\n/, '').slice(m[0].length) }
}
// A cover stored inside the post, decoded for /posts/<id>/cover (link previews, list thumbnails).
// Raster types only: an SVG document served at its own URL is a page, not a picture.
const COVER_DATA = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/
function coverBytes(url) {
  const m = COVER_DATA.exec(url)
  if (!m) return null
  try {
    return { type: m[1], bytes: Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)) }
  } catch {
    return null
  }
}
// Where a list or a link preview finds a post's cover: an https cover is its own URL, one inside the
// post is served from /posts/<id>/cover, and an ipfs:// one goes through the path gateway.
function coverSrc(post, base) {
  const { cover } = splitCover(post.body)
  if (!cover) return null
  if (cover.url.startsWith('data:')) return coverBytes(cover.url) ? `${base}/posts/${post.hash.slice(2, 14)}/cover` : null
  return cover.url
}

// A post's body as its page shows it: the Markdown without the cover, with X post links as cards.
const postBodyHtml = (body) => embedXPosts(renderMarkdown(splitCover(body).body))

// --- link-preview cards (share-card.js) -------------------------------------------------------------
// Every page gets a 1200x630 PNG: a post's title with its name's generated mark, a name with its post
// count, the posts host's own. The URL carries a hash of what the card shows (?v=), so a changed card
// is a new URL to previews, and drawn cards are kept by that hash.
const CARD_VERSION = 1 // bump with any change to how cards look
function cardVersion(card) { // FNV-1a: a cache key, not a security boundary
  let h = 0x811c9dc5
  for (const byte of new TextEncoder().encode(JSON.stringify([CARD_VERSION, card]))) h = Math.imul(h ^ byte, 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}
const cardCache = new Map()
const CARD_CACHE_MAX = 200
async function cardResponse(card) {
  const key = cardVersion(card)
  let png = cardCache.get(key)
  if (!png) {
    png = await renderCard(card)
    cardCache.set(key, png)
    if (cardCache.size > CARD_CACHE_MAX) cardCache.delete(cardCache.keys().next().value)
  }
  return new Response(png, {
    headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff', ...CORS },
  })
}
const cardMeta = (card, url, alt) => ({ image: `${url}?v=${cardVersion(card)}`, imageWidth: 1200, imageHeight: 630, imageAlt: alt })
const hostOf = (canonical) => canonical.replace(/^https:\/\//, '').replace(/\/$/, '')
const postCard = (name, seed, post, base) => ({ kind: 'post', name, title: post.title, date: humanDate(post.time), seed, mark: true, host: hostOf(base) })
const nameCard = (name, seed, posts, base) => ({ kind: 'name', name, bio: `${posts.length} post${posts.length === 1 ? '' : 's'}, stored in Ethereum blobs`, seed, mark: true, host: hostOf(base) })
const siteCard = (postsHost) => ({ kind: 'site', title: 'posts', lead: 'blogs on .wei names and subnames, stored in Ethereum blobs', footer: postsHost })

// Where a name's posts live, as `base` + postPath(): its own host on a name host, else POSTS_HOST.
export const canonicalBase = (name, postsHost = POSTS_HOST) => `https://${postsHost}/${encodeURIComponent(name)}`

function dateLine(post) {
  return `<time datetime="${new Date(post.time * 1000).toISOString().slice(0, 10)}">${humanDate(post.time)}</time>` +
    (post.onchain ? '' : '<span class="pending" title="Authorized by the owner, waiting for its blob">pending</span>')
}

function renderPost({ name, base, canonical, post, seed = null, bodyHtml }) {
  const rows = post.onchain
    ? [
        ['Status', `In a blob since block <a href="https://etherscan.io/block/${post.onchain.block}">${post.onchain.block}</a>`],
        ['Blob', `<a href="https://blobscan.com/blob/${post.onchain.blob}">${short(post.onchain.blob)}</a>`],
        ['Transaction', `<a href="https://etherscan.io/tx/${post.onchain.tx}">${short(post.onchain.tx)}</a>`],
      ]
    : [['Status', 'Authorized by the owner, waiting for its blob']]
  rows.push(['Post hash', `<a href="https://${POSTS_HOST}/api/posts/${post.hash}">${short(post.hash)}</a>`])
  const { cover, body: text } = splitCover(post.body)
  const body =
    (cover ? `<figure class="cover"><img src="${escapeHtml(cover.url)}" alt="${escapeHtml(cover.alt)}" referrerpolicy="no-referrer"></figure>` : '') +
    `<div class="byline"><a href="${escapeHtml(base || '/')}">${escapeHtml(name)}</a></div>` +
    `<h2 class="title">${escapeHtml(post.title)}</h2><div class="meta">${dateLine(post)}</div>` +
    `<article class="body">${bodyHtml ?? renderMarkdown(text)}</article>` +
    `<div class="panel">${rows.map(([k, v]) => `<div><span>${k}</span>${v}</div>`).join('')}</div>`
  return layout({
    title: `${post.title} · ${name}`,
    nav: `<a href="${escapeHtml((base || '') + '/feed.xml')}">feed</a>`,
    head: `<link rel="alternate" type="application/atom+xml" title="${escapeHtml(name)}" href="${escapeHtml((base || '') + '/feed.xml')}">` +
      metaTags({
        title: `${post.title} · ${name}`, description: excerpt(text) || `A post by ${name}.`, url: canonical, type: 'article',
        // A cover is the post's preview image, as an article's banner is; without one, its card.
        // Previews fetch from the canonical host, so both are addressed there.
        ...previewImage(post, canonical.replace(/\/posts\/[^/]*$/, ''), name, seed),
      }),
    body,
  })
}

function previewImage(post, home, name, seed) {
  const cover = coverSrc(post, home)
  if (cover) return { image: cover, imageAlt: splitCover(post.body).cover.alt || post.title }
  return cardMeta(postCard(name, seed, post, home), `${home}/posts/${post.hash.slice(2, 14)}/card.png`, `${post.title}, a post by ${name}`)
}

function listItems(posts, link, baseOf) {
  return '<ul class="list">' + posts.map((p) => {
    const ex = excerpt(splitCover(p.body).body, 160)
    const thumb = coverSrc(p, baseOf(p))
    return '<li>' + (thumb ? `<a class="thumb" href="${escapeHtml(link(p))}" tabindex="-1"><img src="${escapeHtml(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer"></a>` : '') +
      `<a class="t" href="${escapeHtml(link(p))}">${escapeHtml(p.title)}</a>` +
      `<div class="d">${p.name ? escapeHtml(p.name) + ' · ' : ''}${dateLine(p)}</div>${ex ? `<p>${escapeHtml(ex)}</p>` : ''}</li>`
  }).join('') + '</ul>'
}

function renderName({ name, base, canonical, posts, seed = null }) {
  const manage = `${DAPP}/#${encodeURIComponent(name.replace(/\.wei$/, ''))}`
  return layout({
    title: name,
    nav: `<a href="${escapeHtml(base + '/feed.xml')}">feed</a> · <a href="${escapeHtml(manage)}">${escapeHtml(name)} on wei.domains</a>`,
    head: `<link rel="alternate" type="application/atom+xml" title="${escapeHtml(name)}" href="${escapeHtml(base + '/feed.xml')}">` +
      metaTags({
        title: name, description: `Posts by ${name}.`, url: canonical,
        ...cardMeta(nameCard(name, seed, posts, canonical), `${canonical.replace(/\/$/, '')}/card.png`, `Posts by ${name}`),
      }),
    body: `<h2 class="title">${escapeHtml(name)}</h2><div class="meta">${posts.length} post${posts.length === 1 ? '' : 's'}</div>` +
      listItems(posts, (p) => base + postPath(p.hash, p.title), () => base),
  })
}

function renderRecent({ posts, postsHost }) {
  return layout({
    title: 'posts · wei name service',
    head: metaTags({
      title: 'posts on .wei names', description: 'Blogs on .wei names and subnames, stored in Ethereum blobs.', url: `https://${postsHost}/`,
      ...cardMeta(siteCard(postsHost), `https://${postsHost}/card.png`, 'Posts on .wei names'),
    }),
    body: '<h2 class="title">posts</h2><div class="meta">blogs on .wei names and subnames, stored in Ethereum blobs. ' +
      `Write yours from your name's Posts button on <a href="${DAPP}">wei.domains</a>.</div>` +
      (posts.length
        ? listItems(posts, (p) => canonicalBase(p.name, postsHost) + postPath(p.hash, p.title), (p) => canonicalBase(p.name, postsHost))
        : '<p class="empty">No posts yet.</p>'),
  })
}

function renderFeed({ name, base, posts }) {
  const updated = posts.length ? Math.max(...posts.map((p) => p.time)) : 0
  const entries = posts.map((p) => {
    const link = base + postPath(p.hash, p.title)
    return `<entry><title>${xml(p.title)}</title><link href="${xml(link)}"/><id>urn:wei-post:${p.hash}</id>` +
      `<updated>${iso(p.time)}</updated><content type="html">${xml(renderMarkdown(p.body || ''))}</content></entry>`
  }).join('')
  return '<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom">' +
    `<title>${xml(name)}</title><link href="${xml(base + '/')}"/><link rel="self" href="${xml(base + '/feed.xml')}"/>` +
    `<id>${xml(base + '/')}</id><updated>${iso(updated)}</updated><author><name>${xml(name)}</name></author>${entries}</feed>`
}

// --- responses ----------------------------------------------------------------------------------

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS', 'access-control-max-age': '86400' }

function json(status, value, cache = 'no-store') {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache, 'x-content-type-options': 'nosniff', ...CORS },
  })
}

// A picture address names a host, but the picture is the n-th one in the post whose hash it gives, so
// any gateway holding that post can serve it (posts/SPEC.md, "Images in other posts"). Every page
// points such addresses at this gateway's own /img, so a post's pictures don't depend on the host
// that wrote them still being there.
const IMG_ADDRESS = /(src="|content=")https:\/\/[a-z0-9.-]{1,253}(?::\d{1,5})?\/img\/(0x[0-9a-f]{64})\/(\d{1,3})"/g
export const ownImages = (page) => page.replace(IMG_ADDRESS, (_, attr, hash, n) => `${attr}https://${POSTS_HOST}/img/${hash}/${n}"`)

function html(status, body, cache = 'public, max-age=60') {
  return new Response(ownImages(body), {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': cache, 'content-security-policy': POST_CSP,
      'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin',
    },
  })
}

const notFound = (text = 'Not Found\n') => new Response(text, {
  status: 404,
  headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
})

async function readBody(request, max = MAX_BODY) {
  const declared = Number(request.headers.get('content-length') || 0)
  if (declared > max) return null
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array(0)
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > max) { reader.cancel().catch(() => {}); return null }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.length }
  return out
}

// A draft for the preview: a post's shape at any size (parsePost also caps it at one post).
function parseDraft(bytes) {
  try {
    const doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!doc || doc.v !== 1 || typeof doc.title !== 'string' || typeof doc.body !== 'string') return null
    return { title: doc.title.trim() || 'Untitled', body: doc.body }
  } catch {
    return null
  }
}

function findPost(posts, id) {
  return posts.find((p) => p.hash.slice(2, 14) === id)
}

// A name's site: `/`, `/posts/<id>-<slug>` and `/feed.xml`. `base` is '' on the name's own host and
// `https://<POSTS_HOST>/<name>` on the posts host. Returns null when the name has no posts there, so
// the caller answers as it would have without them.
export async function serveNamePosts(index, { name, token, path, base, canonicalHost = POSTS_HOST }) {
  if (!index.knows(token)) return null
  index.maybeSync()
  const posts = await index.postsFor(token)
  if (!posts.length) return null
  const canonical = canonicalBase(name, canonicalHost)
  if (path === '/' || path === '') return html(200, renderName({ name, base, canonical: canonical + '/', posts, seed: token }))
  if (path === '/card.png') return cardResponse(nameCard(name, token, posts, canonical))
  const pc = /^\/posts\/([0-9a-f]{12})\/card\.png$/.exec(path)
  if (pc) {
    const found = findPost(posts, pc[1])
    return found ? cardResponse(postCard(name, token, found, canonical)) : notFound()
  }
  if (path === '/feed.xml') {
    return new Response(renderFeed({ name, base: base || canonical, posts }), {
      headers: { 'content-type': 'application/atom+xml; charset=utf-8', 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff', ...CORS },
    })
  }
  const c = /^\/posts\/([0-9a-f]{12})\/cover$/.exec(path)
  if (c) {
    const found = findPost(posts, c[1])
    const cover = found && splitCover(found.body).cover
    const img = cover && coverBytes(cover.url)
    if (!img) return notFound()
    // A post's bytes never change under its hash; only whether it shows does.
    return new Response(img.bytes, {
      headers: { 'content-type': img.type, 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", ...CORS },
    })
  }
  const m = POST_PATH.exec(path)
  const post = m && findPost(posts, m[1])
  if (!post) return notFound()
  const bodyHtml = await postBodyHtml(post.body)
  return html(200, renderPost({ name, base, canonical: canonical + postPath(post.hash, post.title), post, seed: token, bodyHtml }))
}

// The posts host: the API, recent posts, and every name by path.
export async function servePostsHost(index, request, url, { client, tokenOf, postsHost = POSTS_HOST }) {
  const path = url.pathname
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (path.startsWith('/api/')) return serveApi(index, request, path, url, { client })
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
  if (path === '/') {
    index.maybeSync()
    return html(200, renderRecent({ posts: await index.recent(30), postsHost }))
  }
  if (path === '/card.png') return cardResponse(siteCard(postsHost))
  // A picture stored in a post, by the post's hash: what a post shows when its pictures are kept in
  // other posts' blobs. Content-addressed, so it never changes.
  const img = /^\/img\/(0x[0-9a-f]{64})\/(\d{1,3})$/.exec(path)
  if (img) {
    await index.load()
    index.maybeSync()
    const found = index.imageOf(img[1], Number(img[2]))
    if (!found) return notFound()
    return new Response(found.bytes, {
      headers: {
        'content-type': found.type, 'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", ...CORS,
      },
    })
  }
  // /<name>.wei[/rest]: the name as its owner wrote it, percent-encoded where it isn't ASCII.
  const m = /^\/([^/]{1,1024}\.wei)(\/.*)?$/i.exec(path)
  if (!m) return notFound()
  let name
  try {
    name = decodeURIComponent(m[1]).toLowerCase()
  } catch {
    return notFound()
  }
  if (!m[2]) return Response.redirect(`https://${postsHost}/${encodeURIComponent(name)}/`, 301)
  const token = tokenOf(name)
  if (!token) return notFound()
  return (await serveNamePosts(index, { name, token, path: m[2], base: canonicalBase(name, postsHost), canonicalHost: postsHost })) ||
    notFound(`No posts for ${name}.\n`)
}

async function serveApi(index, request, path, url, { client }) {
  const post = request.method === 'POST'
  if (post && path === '/api/posts') {
    const bytes = await readBody(request)
    if (!bytes) return json(413, { error: 'A post is at most 126,968 bytes.' })
    await index.load()
    const out = index.upload(bytes, client)
    return json(out.status, out.error ? { error: out.error } : { hash: out.hash })
  }
  if (post && path === '/api/posts/preview') {
    // A draft rendered as its post page will be (pending, dated now), so the author sees exactly
    // what readers will before paying for anything. `?name=` puts the name in the byline.
    const bytes = await readBody(request, MAX_PREVIEW_BODY)
    const doc = bytes && parseDraft(bytes)
    if (!doc) return json(400, { error: 'Not a post.' })
    const { cover, body } = splitCover(doc.body)
    const name = /^[^/?#]{1,1024}\.wei$/i.test(url.searchParams.get('name') || '') ? url.searchParams.get('name').toLowerCase() : 'yourname.wei'
    const hash = postHash(bytes)
    const draft = { hash, ...doc, time: Math.floor(Date.now() / 1000), onchain: null }
    const base = canonicalBase(name)
    return json(200, {
      title: doc.title, cover: cover && cover.url, html: renderMarkdown(body),
      page: ownImages(renderPost({ name, base, canonical: base + postPath(hash, doc.title), post: draft, bodyHtml: await postBodyHtml(doc.body) })),
    })
  }
  if (post && path === '/api/sync') {
    const run = index.maybeSync(true)
    await Promise.race([run, new Promise((r) => setTimeout(r, SYNC_WAIT_MS))])
    return json(200, { block: Number(index.cursor) })
  }
  if (post) return json(405, { error: 'Method Not Allowed' })

  index.maybeSync()
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 200)
  if (path === '/api/posts/recent') {
    const posts = await index.recent(limit)
    return json(200, { posts: posts.map(({ body, ...p }) => ({ ...p, excerpt: excerpt(body, 200), url: canonicalBase(p.name) + postPath(p.hash, p.title) })) }, 'public, max-age=30')
  }
  if (path === '/api/posts') {
    // Every post a blob carries, in the order the index found them, for mirrors: pass `next` back.
    const after = Math.max(Number(url.searchParams.get('after')) || 0, 0)
    const page = index.archive.slice(after, after + limit).map((e, i) => ({ seq: after + i + 1, hash: e.hash, blob: e.blob }))
    return json(200, { posts: page, next: after + page.length })
  }
  let m = /^\/api\/posts\/(0x[0-9a-f]{64})(\/raw)?$/.exec(path)
  if (m) {
    if (m[2]) {
      const held = index.bytes.get(m[1])
      if (!held) return json(404, { error: 'Not held here.' })
      return new Response(held.bytes, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', ...CORS } })
    }
    const info = index.postInfo(m[1])
    return info ? json(200, info, 'public, max-age=30') : json(404, { error: 'Unknown post.' })
  }
  m = /^\/api\/names\/(0x[0-9a-f]{1,64})\/posts$/.exec(path)
  if (m) {
    const token = '0x' + m[1].slice(2).padStart(64, '0')
    const posts = await index.postsFor(token)
    return json(200, { posts: posts.map(({ body, ...p }) => ({ ...p, excerpt: excerpt(body, 200) })) })
  }
  m = /^\/api\/authors\/(0x[0-9a-fA-F]{40})\/paid$/.exec(path)
  if (m) return json(200, { paid: index.paidBy(m[1].toLowerCase()) })
  return json(404, { error: 'Not Found' })
}

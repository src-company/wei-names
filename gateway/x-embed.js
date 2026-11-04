// X posts embedded in a post (posts/SPEC.md, "Embedded X posts"): a link to an X post alone on its own
// line is drawn as a card, the way X's own articles show one. Post pages run no scripts, so X's widget
// is out; instead the gateway reads the post from the public syndication endpoint X's embeds use (as
// react-tweet does) and writes the card itself. Everything from X is escaped, images are only taken
// from X's image host, and when X doesn't answer the line stays a plain link card. Nothing about the
// embed is stored in the post: the post keeps the link, so it reads the same anywhere else.

const SYNDICATION = 'https://cdn.syndication.twimg.com/tweet-result'
const TIMEOUT_MS = 4_000
const HIT_TTL_MS = 86_400_000
const MISS_TTL_MS = 900_000
const MAX_CACHE = 2_000
export const MAX_EMBEDS = 8 // per post; more stay links

const cache = new Map() // id -> { at, tweet | null }
let fetchImpl = (...args) => fetch(...args)
export function setEmbedFetch(f) { // tests
  fetchImpl = f
  cache.clear()
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const unescapeEntities = (s) => String(s ?? '').replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]))
const IMAGE = /^https:\/\/pbs\.twimg\.com\/[A-Za-z0-9_./?=&%-]{1,400}$/
const httpsLink = (v) => {
  try {
    const u = new URL(String(v))
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch {
    return null
  }
}

// An X post link: x.com, twitter.com (and their www. and mobile. hosts), /<handle>/status/<id>.
const STATUS = /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,20})(?:[/?#][^\s"<>]*)?$/
export function xStatus(url) {
  const m = STATUS.exec(String(url || ''))
  return m ? { handle: m[1], id: m[2], url: `https://x.com/${m[1]}/status/${m[2]}` } : null
}

// The syndication endpoint's token, as X's embed script computes it.
const tokenFor = (id) => ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')

export async function fetchXPost(id) {
  const hit = cache.get(id)
  if (hit && Date.now() - hit.at < (hit.tweet ? HIT_TTL_MS : MISS_TTL_MS)) return hit.tweet
  let tweet = null
  try {
    const res = await fetchImpl(`${SYNDICATION}?id=${id}&lang=en&token=${tokenFor(id)}`, {
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; wei.domains posts)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.ok) {
      const body = await res.json()
      if (body && body.__typename !== 'TweetTombstone' && body.id_str === id && body.user?.screen_name) tweet = body
    } else {
      res.body?.cancel().catch(() => {})
    }
  } catch {}
  cache.set(id, { at: Date.now(), tweet })
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value)
  return tweet
}

// The post's text as X shows it: from the start of its display range (past any leading reply
// handles), t.co links expanded to where they go, @mentions linked, line breaks kept. A t.co link that
// isn't one of the post's links is its media's, shown as images instead, so it's dropped; the end of
// the range isn't used, so a range that disagrees with the text can't leave half a link behind.
function textHtml(t) {
  let text = Array.from(unescapeEntities(t.text))
  if (Array.isArray(t.display_text_range) && Number.isInteger(t.display_text_range[0])) text = text.slice(t.display_text_range[0])
  const urls = new Map((t.entities?.urls || []).map((u) => [u.url, u]))
  return text.join('').trim().split(/(https:\/\/t\.co\/[A-Za-z0-9]{1,20})/).map((part, i) => {
    if (i % 2 === 0) {
      return escapeHtml(part)
        .replace(/(^|[^\w])@([A-Za-z0-9_]{1,15})\b/g, '$1<a href="https://x.com/$2" rel="nofollow noopener">@$2</a>')
        .replace(/\n/g, '<br>')
    }
    const u = urls.get(part)
    const href = u && httpsLink(u.expanded_url)
    return href ? `<a href="${escapeHtml(href)}" rel="nofollow noopener">${escapeHtml(u.display_url || href)}</a>` : ''
  }).join('')
}

const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K` : String(n))
const X_LOGO = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>'
const BADGE = '<svg class="xpost-badge" viewBox="0 0 22 22" width="16" height="16" aria-label="verified"><path fill="#1d9bf0" d="M20.4 11c0-1.3-.8-2.4-1.9-2.9.4-1.2.2-2.6-.7-3.5s-2.3-1.1-3.5-.7C13.8 2.8 12.6 2 11.3 2s-2.5.8-3 1.9c-1.2-.4-2.6-.2-3.5.7s-1.1 2.3-.7 3.5C3 8.6 2.2 9.7 2.2 11s.8 2.4 1.9 2.9c-.4 1.2-.2 2.6.7 3.5s2.3 1.1 3.5.7c.5 1.1 1.7 1.9 3 1.9s2.5-.8 3-1.9c1.2.4 2.6.2 3.5-.7s1.1-2.3.7-3.5c1.1-.5 1.9-1.6 1.9-2.9z"/><path fill="#fff" d="M9.6 15.2 6.5 12l1.2-1.2 1.9 1.9 4.7-4.8 1.2 1.2z"/></svg>'

export function xPostCard(link, t) {
  if (!t) {
    return `<a class="xpost xpost-link" href="${escapeHtml(link.url)}" rel="nofollow noopener">${X_LOGO}<span>View this post by @${escapeHtml(link.handle)} on X</span></a>`
  }
  const user = t.user
  const avatar = IMAGE.test(user.profile_image_url_https || '') ? user.profile_image_url_https.replace('_normal.', '_bigger.') : null
  const date = Number.isFinite(Date.parse(t.created_at))
    ? new Date(t.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
    : ''
  const url = `https://x.com/${encodeURIComponent(user.screen_name)}/status/${t.id_str}`
  const media = (t.mediaDetails || []).filter((m) => IMAGE.test(m.media_url_https || '')).slice(0, 4)
  const mediaHtml = media.length
    ? `<a class="xpost-media n${media.length}" href="${escapeHtml(url)}" rel="nofollow noopener">` + media.map((m) =>
        `<span class="xpost-shot${m.type === 'photo' ? '' : ' play'}"><img src="${escapeHtml(m.media_url_https)}" alt="${escapeHtml(m.ext_alt_text || '')}" loading="lazy" referrerpolicy="no-referrer"></span>`).join('') + '</a>'
    : ''
  const counts = [t.conversation_count ? `${compact(t.conversation_count)} replies` : '', t.favorite_count ? `${compact(t.favorite_count)} likes` : ''].filter(Boolean).join(' · ')
  return '<figure class="xpost">' +
    `<a class="xpost-head" href="${escapeHtml(url)}" rel="nofollow noopener">` +
    (avatar ? `<img class="xpost-av" src="${escapeHtml(avatar)}" alt="" width="40" height="40" referrerpolicy="no-referrer">` : '') +
    `<span class="xpost-who"><span class="xpost-name">${escapeHtml(user.name || user.screen_name)}${user.is_blue_verified || user.verified ? BADGE : ''}</span>` +
    `<span class="xpost-handle">@${escapeHtml(user.screen_name)}${date ? ` · ${escapeHtml(date)}` : ''}</span></span>` +
    `<span class="xpost-logo">${X_LOGO}</span></a>` +
    `<div class="xpost-text">${textHtml(t)}</div>` + mediaHtml +
    `<a class="xpost-foot" href="${escapeHtml(url)}" rel="nofollow noopener">${counts ? `<span>${counts}</span>` : ''}<span>View on X</span></a>` +
    '</figure>'
}

// In rendered post HTML (markdown.js output), each paragraph that is nothing but an X post link
// becomes its card. The match is on markup the renderer itself wrote, so nothing else can pass for it.
const LINK_PARAGRAPH = /<p><a href="(https:\/\/[^"]{1,300})" rel="nofollow ugc noopener">[^<]{1,300}<\/a><\/p>/g
export async function embedXPosts(html) {
  const found = []
  for (const m of html.matchAll(LINK_PARAGRAPH)) {
    const link = xStatus(unescapeEntities(m[1]))
    if (link && !found.some((f) => f.id === link.id)) found.push(link)
    if (found.length >= MAX_EMBEDS) break
  }
  if (!found.length) return html
  const tweets = new Map(await Promise.all(found.map(async (l) => [l.id, await fetchXPost(l.id)])))
  return html.replace(LINK_PARAGRAPH, (whole, href) => {
    const link = xStatus(unescapeEntities(href))
    return link && tweets.has(link.id) ? xPostCard(link, tweets.get(link.id)) : whole
  })
}

export const XPOST_STYLE = `
.xpost{margin:1.4em 0;border:1px solid var(--line);border-radius:14px;padding:14px 16px;font-size:15px;line-height:1.45}
.xpost a{text-decoration:none}
.xpost-head{display:flex;align-items:center;gap:10px;color:inherit}
.xpost-av{width:40px;height:40px;border-radius:50%;flex:none;background:var(--surface)}
.xpost-who{display:flex;flex-direction:column;min-width:0;flex:1}
.xpost-name{font-weight:700;display:flex;align-items:center;gap:3px;overflow-wrap:anywhere}
.xpost-badge{flex:none}
.xpost-handle{color:var(--muted);font-size:14px;overflow-wrap:anywhere}
.xpost-logo{color:var(--fg);flex:none}
.xpost-text{margin-top:10px;overflow-wrap:anywhere}
.xpost-text a{color:#1d9bf0}
.xpost-media{display:grid;gap:2px;margin-top:12px;border-radius:12px;overflow:hidden;border:1px solid var(--line)}
.xpost-media.n2,.xpost-media.n3,.xpost-media.n4{grid-template-columns:1fr 1fr}
.xpost-media.n3 .xpost-shot:first-child{grid-row:span 2}
.xpost-shot{position:relative;display:block;background:var(--surface)}
.xpost-shot img{display:block;width:100%;height:100%;max-height:520px;object-fit:cover}
.xpost-media.n2 img,.xpost-media.n3 img,.xpost-media.n4 img{aspect-ratio:1/1}
.xpost-shot.play::after{content:"";position:absolute;left:50%;top:50%;width:0;height:0;margin:-14px 0 0 -9px;border-style:solid;border-width:14px 0 14px 22px;border-color:transparent transparent transparent #fff;filter:drop-shadow(0 0 6px rgba(0,0,0,.6))}
.xpost-foot{display:flex;justify-content:space-between;gap:12px;margin-top:12px;padding-top:10px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
.xpost-foot:hover span:last-child{text-decoration:underline}
.xpost-link{display:flex;align-items:center;gap:10px;color:inherit}
.xpost-link:hover span{text-decoration:underline}
`

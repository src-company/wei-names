// Node entrypoint for the wei.limo wildcard gateway (Railway / Render / any Node).
//
// Adapts Node's http req/res to the Web Fetch `Request`/`Response` the core
// handler speaks. GET/HEAD everywhere; the posts host also takes small POST
// bodies (a post's bytes), read here up to MAX_BODY_BYTES.
//
// Deploy: `node server.js` behind a `*.wei.limo` DNS record pointing here.
// Config via env: PORT, ZONE, RPC_URLS, WNS_CONTRACT, GATEWAY_MODE,
// IPFS_SUBDOMAIN_GATEWAY, WEB3_GATEWAY, WEB3_CHAIN_ID, RESERVED_LABELS,
// TRUSTED_PROXY_CIDRS (only networks of proxies that sanitize/append XFF).

import { createServer } from 'node:http'
import { Readable, pipeline } from 'node:stream'
import { handleRequest, postsIndexFor } from './handler.js'
import { createClientIdentity } from './client-ip.js'

const PORT = Number(process.env.PORT) || 8080
// A post is at most 126,968 bytes (posts-format.js), but a draft's preview, with every picture
// inline before they move into image posts, can be a few MB (posts-page.js). Bigger is refused unread.
const MAX_BODY_BYTES = 4 * 1024 * 1024
const POSTS_HOST_NAME = String(process.env.POSTS_HOST || 'posts.wei.domains').toLowerCase()
const clientIdentity = createClientIdentity(process.env)
// The post index (posts.js), or null while POSTS_CONTRACT is unset.
const posts = postsIndexFor(process.env)

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', () => resolve(null))
  })
}

function badRequest(res) {
  res.statusCode = 400
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end('Bad Request')
}

const server = createServer(async (req, res) => {
  // A forged Host or request target is the client's problem, not a gateway
  // error: answered here, before it can throw below and log a stack per request.
  // Only origin-form targets (`/path`); a proxy may list several hosts, first wins.
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'wei.limo').split(',')[0].trim()
  if (!req.url?.startsWith('/') || !/^[a-z0-9.:\[\]_-]+$/i.test(host)) return badRequest(res)
  try {
    const proto = req.headers['x-forwarded-proto'] === 'http' ? 'http' : 'https'
    // Only the posts host takes a body; a POST anywhere else is refused unread by the handler.
    let body
    if (req.method === 'POST' && posts && host.split(':')[0].toLowerCase() === POSTS_HOST_NAME) {
      body = await readBody(req)
      if (!body) {
        res.statusCode = 413
        res.setHeader('cache-control', 'no-store')
        return res.end('Payload Too Large')
      }
    }
    let request
    try {
      request = new Request(`${proto}://${host}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body,
      })
    } catch {
      return badRequest(res)
    }

    const response = await handleRequest(request, process.env, { clientIp: clientIdentity(req) })

    res.statusCode = response.status
    response.headers.forEach((value, key) => res.setHeader(key, value))

    if (response.body) {
      // pipeline, not pipe: an upstream reset mid-body must not crash the
      // process, and a client abort must cancel the upstream read.
      pipeline(Readable.fromWeb(response.body), res, () => {})
    } else {
      res.end()
    }
  } catch (e) {
    console.error('gateway error:', e)
    if (res.headersSent) { res.destroy(); return }
    res.statusCode = 500
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end('Gateway error')
  }
})

// Outlive the platform proxy's pooled upstream connections. Node's default 5s
// keep-alive closes a socket the proxy still thinks is open, and the request it
// sends down it next fails as a sporadic 502. headersTimeout must exceed it.
server.keepAliveTimeout = 65_000
server.headersTimeout = 66_000
// A request is its headers, plus at most a post's bytes.
server.requestTimeout = 70_000

// A stray rejection (an upstream stream erroring after its response was
// abandoned, say) is one request's problem; it must not take the process —
// and every other site with it — down.
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e))

server.listen(PORT, () => {
  console.log(`wei.limo gateway listening on :${PORT}`)
})

// Keep the post index current between visits, so a publisher reading bytes
// and a reader opening a page both find the latest events already applied.
if (posts) {
  // One line once the first sync is in, so a deploy (the private archive's especially, which nothing
  // can reach from outside) shows its index came up.
  posts.maybeSync().then(() => console.log(JSON.stringify({
    event: 'posts_index_ready', block: Number(posts.cursor), posts: posts.byHash.size, held: posts.bytes.size,
    disk: !!posts.dir, archive: posts.archiveUrl || null,
  })))
  setInterval(() => posts.maybeSync(), 60_000).unref()
}

// Let in-flight requests finish on a redeploy
process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
  // close() waits for keep-alive sockets; idle ones can go now.
  server.closeIdleConnections?.()
  setTimeout(() => process.exit(0), 10_000).unref()
})

// Node entrypoint for the wei.limo wildcard gateway (Railway / Render / any Node).
//
// Adapts Node's http req/res to the Web Fetch `Request`/`Response` the core
// handler speaks. Read-only GET/HEAD gateway, so no request body handling.
//
// Deploy: `node server.js` behind a `*.wei.limo` DNS record pointing here.
// Config via env: PORT, ZONE, RPC_URLS, WNS_CONTRACT, GATEWAY_MODE,
// IPFS_SUBDOMAIN_GATEWAY, WEB3_GATEWAY, WEB3_CHAIN_ID, RESERVED_LABELS,
// TRUSTED_PROXY_CIDRS (only networks of proxies that sanitize/append XFF).

import { createServer } from 'node:http'
import { Readable, pipeline } from 'node:stream'
import { handleRequest } from './handler.js'
import { createClientIdentity } from './client-ip.js'

const PORT = Number(process.env.PORT) || 8080
const clientIdentity = createClientIdentity(process.env)

function badRequest(res) {
  res.statusCode = 400
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end('Bad Request')
}

let xffSamples = 30
const server = createServer(async (req, res) => {
  if (xffSamples > 0 && req.url !== '/healthz') {
    xffSamples--
    console.log('xff-probe', JSON.stringify({ peer: req.socket?.remoteAddress, xff: req.headers['x-forwarded-for'], id: clientIdentity(req), url: req.url }))
  }
  // A forged Host or request target is the client's problem, not a gateway
  // error: answered here, before it can throw below and log a stack per request.
  // Only origin-form targets (`/path`); a proxy may list several hosts, first wins.
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'wei.limo').split(',')[0].trim()
  if (!req.url?.startsWith('/') || !/^[a-z0-9.:\[\]_-]+$/i.test(host)) return badRequest(res)
  try {
    const proto = req.headers['x-forwarded-proto'] === 'http' ? 'http' : 'https'
    let request
    try {
      request = new Request(`${proto}://${host}${req.url}`, {
        method: req.method,
        headers: req.headers,
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
// GET/HEAD only, so a whole request is just its headers.
server.requestTimeout = 70_000

// A stray rejection (an upstream stream erroring after its response was
// abandoned, say) is one request's problem; it must not take the process —
// and every other site with it — down.
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e))

server.listen(PORT, () => {
  console.log(`wei.limo gateway listening on :${PORT}`)
})

// Let in-flight requests finish on a redeploy
process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
  // close() waits for keep-alive sockets; idle ones can go now.
  server.closeIdleConnections?.()
  setTimeout(() => process.exit(0), 10_000).unref()
})

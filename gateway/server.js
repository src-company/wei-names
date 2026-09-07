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
import { Readable } from 'node:stream'
import { handleRequest } from './handler.js'
import { createClientIdentity } from './client-ip.js'

const PORT = Number(process.env.PORT) || 8080
const clientIdentity = createClientIdentity(process.env)

const server = createServer(async (req, res) => {
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'wei.limo'
    const proto = req.headers['x-forwarded-proto'] || 'https'
    const request = new Request(`${proto}://${host}${req.url}`, {
      method: req.method,
      headers: req.headers,
    })

    const response = await handleRequest(request, process.env, { clientIp: clientIdentity(req) })

    res.statusCode = response.status
    response.headers.forEach((value, key) => res.setHeader(key, value))

    if (response.body) {
      Readable.fromWeb(response.body).pipe(res)
    } else {
      res.end()
    }
  } catch (e) {
    res.statusCode = 500
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end('Gateway error: ' + (e?.message || 'unknown'))
  }
})

server.listen(PORT, () => {
  console.log(`wei.limo gateway listening on :${PORT}`)
})

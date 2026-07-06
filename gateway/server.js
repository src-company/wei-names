// Node entrypoint for the wei.is wildcard gateway (Railway / Render / any Node).
//
// Adapts Node's http req/res to the Web Fetch `Request`/`Response` the core
// handler speaks. Read-only GET/HEAD gateway, so no request body handling.
//
// Deploy: `node server.js` behind a `*.wei.is` DNS record pointing here.
// Config via env: PORT, ZONE, RPC_URLS, WNS_CONTRACT, GATEWAY_MODE,
// IPFS_SUBDOMAIN_GATEWAY, IPFS_PATH_GATEWAY, RESERVED_LABELS.

import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { handleRequest } from './handler.js'

const PORT = Number(process.env.PORT) || 8080

const server = createServer(async (req, res) => {
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'wei.is'
    const proto = req.headers['x-forwarded-proto'] || 'https'
    const request = new Request(`${proto}://${host}${req.url}`, {
      method: req.method,
      headers: req.headers,
    })

    const response = await handleRequest(request, process.env)

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
  console.log(`wei.is gateway listening on :${PORT}`)
})

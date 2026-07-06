// Cloudflare Worker entrypoint for the wei.is wildcard gateway.
//
// Deploy:  cd gateway && wrangler deploy
// Requires wei.is to be a Cloudflare zone with a `*.wei.is` worker route
// (see wrangler.toml). Env vars are set as Worker vars/secrets.

import { handleRequest } from './handler.js'

export default {
  fetch(request, env) {
    return handleRequest(request, env)
  },
}

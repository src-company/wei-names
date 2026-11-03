#!/bin/sh
# Render's start command for the publisher (render.yaml, wei-poster). The key lives on the worker's
# persistent disk and is made there on first start, so it never passes through git, the dashboard or
# a deploy log; only its address is printed. Losing the disk means a new key and a new address:
# whatever ETH the old one held stays with it, so keep its balance small.
set -eu
: "${POSTER_KEY_FILE:?set POSTER_KEY_FILE}"
if [ ! -s "$POSTER_KEY_FILE" ]; then
  echo "no publisher key at $POSTER_KEY_FILE: generating one"
  python wei_poster.py keygen "$POSTER_KEY_FILE" > /dev/null
fi
echo "publisher address: $(python wei_poster.py address)"
exec python wei_poster.py run

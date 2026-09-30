#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p certs

if ! command -v mkcert >/dev/null 2>&1; then
  echo "mkcert is not installed. Install it with: brew install mkcert"
  exit 1
fi

# Puts the mkcert CA in the macOS trust store so Efficience and the browser accept the certificate.
# This prompts for your Mac password. The certificate files are still written if that prompt cannot run.
if ! mkcert -install; then
  echo
  echo "The local CA was created, but macOS did not trust it."
  echo "Run this again in Terminal and approve the password prompt:"
  echo "  npm run setup-cert"
  echo
fi

mkcert \
  -key-file certs/localhost.icanopee.net-key.pem \
  -cert-file certs/localhost.icanopee.net.pem \
  localhost.icanopee.net

echo "Trusted certificate written to client/certs."
echo "Restart the forwarder, then use https://localhost.icanopee.net:9982"

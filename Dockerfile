# Node is pinned to an exact release so a rebuild never drifts to an old or
# unpatched one. 24.22.1 is the Oct 20 2026 security release (Brotli RCE,
# TLS hostname checks, dns.resolve). Nixpacks had this service on Node 18.20.5,
# which stopped getting fixes in April 2025.
# Railway service variables reach the app at runtime only; none are baked
# into the image (Nixpacks used to copy every one into ARG/ENV lines).
FROM node:24.22.1-slim
# nvda/relay/relay.js makes its TLS certificate with the openssl command, which
# the slim image leaves out (the Nixpacks Ubuntu image had it). Without it the
# nvda-relay service exits at start and the bridge's in-process relay stays down.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY . .
CMD ["npm", "start"]

# syntax=docker/dockerfile:1

# DNS Logistics — Pricing Configuration
#
# Two targets:
#   runner (default) — the lean production server. No devDependencies, no scripts.
#   tools            — the same code plus tsx and the seed data, for one-off jobs
#                      (seeding, verification) run as a task rather than a service.
#
#   docker build -t dns-pricing .
#   docker build -t dns-pricing-tools --target tools .

ARG NODE_VERSION=22-alpine

# ----------------------------------------------------------------- dependencies
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Full install: the build needs TypeScript and the Next plugin.
RUN npm ci

# ----------------------------------------------------------------------- build
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# No secrets at build time: SESSION_SECRET and BOOKING_API_KEY are read per request,
# not at module scope, so they are injected only at runtime.
RUN npm run build

# ----------------------------------------------------------------------- tools
# For `seed`, `verify-contracts` and similar one-off jobs. Not the service image.
FROM node:${NODE_VERSION} AS tools
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
# Seed data. Produced by scripts/extract.py from the source workbooks; either commit
# it or generate it in CI before building this target.
COPY data ./data
CMD ["npx", "tsx", "scripts/seed.ts"]

# ---------------------------------------------------------------------- runner
FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Never run the server as root.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001 -G nodejs

# `output: 'standalone'` traces exactly the files the server needs.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

# The ALB target group should point at this.
HEALTHCHECK --interval=30s --timeout=4s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

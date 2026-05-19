FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime

# Install only what we need at runtime; avoid leaving build tools in the image.
RUN apk add --no-cache wget tini \
  && addgroup -S asinu \
  && adduser -S -G asinu -h /app asinu

WORKDIR /app

# Copy production deps from the deps stage.
COPY --from=deps --chown=asinu:asinu /app/node_modules ./node_modules

# Copy application source.
COPY --chown=asinu:asinu . .

# Drop privileges — the process should never run as root.
USER asinu

ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/api/healthz >/dev/null || exit 1

# tini gives us proper PID 1 semantics (signal forwarding, zombie reaping).
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "start"]

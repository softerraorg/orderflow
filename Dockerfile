# syntax=docker/dockerfile:1.6

# ---------- Build stage ----------
FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache openssl

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

RUN npx prisma generate \
 && npm run build \
 && npm prune --omit=dev

# ---------- Runtime stage ----------
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssl

ENV NODE_ENV=production
ENV DATABASE_URL="file:/data/prod.sqlite"
ENV PORT=3000

COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/public ./public

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]

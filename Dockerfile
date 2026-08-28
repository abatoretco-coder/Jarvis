# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
WORKDIR /app
# Use Node headers bundled in the official image when native modules compile.
# This avoids a separate header download during image builds.
ENV npm_config_nodedir=/usr/local

FROM base AS deps
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM base AS prod-deps
ENV NODE_ENV=production
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM base AS runtime
ENV NODE_ENV=production
RUN apk add --no-cache ffmpeg su-exec
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./package.json
COPY scripts/evaluate-flash-info.mjs ./scripts/evaluate-flash-info.mjs
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh
EXPOSE 8090
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]

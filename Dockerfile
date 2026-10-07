# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
WORKDIR /app
# Use Node headers bundled in the official image when native modules compile.
# This avoids a separate header download during image builds.
ENV npm_config_nodedir=/usr/local

FROM base AS deps
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci && test -x node_modules/.bin/eslint && test -x node_modules/.bin/jest

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM base AS prod-deps
ENV NODE_ENV=production
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && node -e "require('fastify');require('better-sqlite3')"

FROM base AS runtime
ENV NODE_ENV=production
RUN apk upgrade --no-cache \
    && apk add --no-cache ffmpeg \
    # npm is a build tool; keeping it in the runtime unnecessarily expands the attack surface.
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && mkdir -p /app/data \
    && chown node:node /app/data
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./package.json
COPY scripts/evaluate-flash-info.mjs ./scripts/evaluate-flash-info.mjs
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod 755 /usr/local/bin/docker-entrypoint.sh
USER node
EXPOSE 8090
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]

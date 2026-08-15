# --- build stage ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- production stage ---
# Alpine keeps the image small; we only ship the compiled dist/ and
# production dependencies, not TypeScript/tsx/dev tooling, which matters
# both for image size and for keeping the 256MB runtime container lean.
FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations

# Cap the V8 heap well under the 256MB container limit, leaving room for
# Node's own overhead, the HTTP parser, and the pg connection pool's
# buffers, instead of letting V8 grow toward the container's cgroup
# limit and get OOM-killed with no warning.
ENV NODE_OPTIONS="--max-old-space-size=192"

EXPOSE 8080
CMD ["node", "dist/server.js"]

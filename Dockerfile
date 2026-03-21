FROM docker.io/oven/bun:1-alpine AS base
WORKDIR /app

# install production dependencies in a cached layer
FROM base AS install
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# final image: copy deps and source
FROM base AS release
COPY --from=install --chown=bun:bun /temp/prod/node_modules node_modules
COPY --chown=bun:bun package.json .
COPY --chown=bun:bun src/ src/

USER bun
CMD ["bun", "--smol", "run", "src/index.ts"]

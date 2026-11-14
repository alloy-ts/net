# Multi-stage image for @alloy-ts/net.
# Build stage: Node 24, npm 11.11.0, and stable Rust for the napi addon.
# Runtime: slim Node 24, packed dist, and deploy/server.mjs.
# sqlite headers are not required for this crate.

FROM node:24-bookworm AS build

RUN npm install -g npm@11.11.0

# node:24-bookworm already includes curl, ca-certificates, gcc/g++, make, and pkg-config.
RUN curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain stable --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /src

# Conservative default for colima's small VM; override with --build-arg.
ARG CARGO_BUILD_JOBS=2
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS}

COPY package.json package-lock.json ./
# setup.ts is for a git checkout, not an image build
RUN npm ci --ignore-scripts

COPY . .
RUN node --import @oxc-node/core/register build.ts --release && npx vp pack

FROM node:24-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

COPY --from=build /src/package.json ./
COPY --from=build /src/dist ./dist
COPY deploy/server.mjs ./deploy/server.mjs

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "deploy/server.mjs"]

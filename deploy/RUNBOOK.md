# Run @alloy-ts/net locally with Compose

This is a draft for a machine you control. It does not publish the image or
open the service to the internet.

The container runs `deploy/server.mjs` against the packed native addon. It
listens for `GET /health` and `GET /ping`, honours `HOST` and `PORT`, and
stops Rocket on `SIGTERM` or `SIGINT`. The demo in `examples/server.ts` has
the same hooks, and still defaults `HOST` to `127.0.0.1` for a local process.

The image is Linux (glibc). On an x86-64 host that is `linux/amd64`; on
the Mac mini in colima it is `linux/arm64` (a native VM, not an x64
emulation). There is no sqlite dependency. A release build is heavy in a
3 GB colima VM; set `CARGO_BUILD_JOBS=2` (the image default) or reuse the
CI `bindings-linux-arm64-gnu` artifact instead of compiling in the VM.

## Prerequisites

- Docker Engine with Compose v2
- From the repository root, a `.env` file (see below)
- npm 11.11.0 is used only inside the build image; you do not need it on the host

## Build

From the repository root:

```sh
cp -n .env.example .env
CARGO_BUILD_JOBS=2 docker compose -f deploy/compose.yml --env-file .env build
```

Or build the image directly:

```sh
docker build -f deploy/Dockerfile --build-arg CARGO_BUILD_JOBS=2 -t alloy-ts-net:local .
```

To skip the in-VM compile on the Mac mini, download the pipeline artifact
`bindings-linux-arm64-gnu`, copy the `*.linux-arm64-gnu.node` addon into
`dist/`, pack, and use that tree as the runtime image context instead of
`--build`.

## Run

```sh
docker compose -f deploy/compose.yml --env-file .env up --build -d
docker compose -f deploy/compose.yml --env-file .env ps
curl -sS "http://127.0.0.1:${PORT:-3000}/health"
curl -sS "http://127.0.0.1:${PORT:-3000}/ping"
```

The published port is bound to `127.0.0.1` on the host so it is not
reachable on the LAN. `HOST` inside the container must stay `0.0.0.0` so
the published port can reach the process. Change `PORT` in `.env` if 3000 is already taken; pass
`--env-file .env` from the repository root so the compose port mapping and
the container see the same value. A service `environment:` block would
override `env_file`, so `HOST` and `PORT` are not set there. Image `ENV`
defaults apply when `.env` omits them.

The service uses `restart: unless-stopped`. A crash or a `docker kill`
starts a new container; `docker compose stop` or `down` does not.

## Update

```sh
git pull
CARGO_BUILD_JOBS=2 docker compose -f deploy/compose.yml --env-file .env build
docker compose -f deploy/compose.yml --env-file .env up -d
```

Compose replaces the container with the new image. Check health before
dropping the previous image:

```sh
curl -sS "http://127.0.0.1:${PORT:-3000}/health"
docker compose -f deploy/compose.yml --env-file .env ps
docker images alloy-ts-net
```

## Logs

```sh
docker compose -f deploy/compose.yml --env-file .env logs -f --tail=200
```

Logs use the `json-file` driver, rotated at 10 MB with three files
(`max-size=10m`, `max-file=3`).

## Rollback

Keep the last known-good image before a rebuild, for example
`alloy-ts-net:prev`:

```sh
docker tag alloy-ts-net:local alloy-ts-net:prev
# ...build and start the new image, then if it is bad:
docker compose -f deploy/compose.yml --env-file .env down
docker tag alloy-ts-net:prev alloy-ts-net:local
docker compose -f deploy/compose.yml --env-file .env up -d
```

To go back to a git revision instead, check out that commit and run
`docker compose -f deploy/compose.yml --env-file .env up --build -d`.

## Stop

```sh
docker compose -f deploy/compose.yml --env-file .env stop    # leaves the container, no auto-restart
docker compose -f deploy/compose.yml --env-file .env down    # remove the container, keep the image
```

`docker compose down` does not delete `alloy-ts-net:local`. Remove it with
`docker image rm alloy-ts-net:local` when you no longer need it.

## Tailscale overlay

A separate Tailscale compose overlay can be merged with this file. It expects
the service to be named `net`, `PORT=3000` (to match `serve.json`), `GET /health`,
and `HOST` plus a clean stop on `SIGTERM`. Those hooks are already in
`examples/server.ts` and `deploy/server.mjs`.

Relative paths in the overlay (`./config`, `./secrets/ts_authkey`) resolve
against this file's directory, `deploy/`. Put or symlink the overlay's
`config/` and `secrets/` next to `deploy/compose.yml` before `up`, or copy
the overlay itself into `deploy/` and run both `-f` flags from the
repository root. Do not commit an auth key; keep it in a gitignored file
and set `TS_AUTHKEY` only as `file:/run/secrets/ts_authkey`.

For userspace Tailscale (the overlay default), set `HOST=127.0.0.1` so the
process binds loopback only. This base file defaults `HOST` to `0.0.0.0` so
published ports work without the overlay.

```sh
# Example, after the overlay files sit next to deploy/compose.yml:
HOST=127.0.0.1 PORT=3000 docker compose \
  -f deploy/compose.yml \
  -f deploy/compose.tailscale.yml \
  config
```

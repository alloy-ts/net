# Run @alloy-ts/net locally with Compose

This is a draft for a machine you control. It does not publish the image or
open the service to the internet.

The container runs `deploy/server.mjs` against the packed native addon. It
listens for `GET /health` and `GET /ping`, honours `HOST` and `PORT`, and
stops Rocket on `SIGTERM` or `SIGINT`. The demo in `examples/server.ts` has
the same hooks, and still defaults `HOST` to `127.0.0.1` for a local process.

The image is Linux x64 (glibc). There is no sqlite dependency.

## Prerequisites

- Docker Engine with Compose v2
- From the repository root, a `.env` file (see below)
- npm 11.11.0 is used only inside the build image; you do not need it on the host

## Build

From the repository root:

```sh
cp -n .env.example .env
docker compose -f deploy/compose.yml build
```

Or build the image directly:

```sh
docker build -f deploy/Dockerfile -t alloy-ts-net:local .
```

## Run

```sh
docker compose -f deploy/compose.yml up --build -d
docker compose -f deploy/compose.yml ps
curl -sS "http://127.0.0.1:${PORT:-3000}/health"
curl -sS "http://127.0.0.1:${PORT:-3000}/ping"
```

`HOST` inside the container must stay `0.0.0.0` so the published port can
reach the process. Change `PORT` in `.env` if 3000 is already taken; the
compose mapping uses the same value on the host and in the container.

The service uses `restart: unless-stopped`. A crash or a `docker kill`
starts a new container; `docker compose stop` or `down` does not.

## Update

```sh
git pull
docker compose -f deploy/compose.yml build
docker compose -f deploy/compose.yml up -d
```

Compose replaces the container with the new image. Check health before
dropping the previous image:

```sh
curl -sS "http://127.0.0.1:${PORT:-3000}/health"
docker compose -f deploy/compose.yml ps
docker images alloy-ts-net
```

## Logs

```sh
docker compose -f deploy/compose.yml logs -f --tail=200
```

Logs use the `json-file` driver, rotated at 10 MB with three files
(`max-size=10m`, `max-file=3`).

## Rollback

Keep the last known-good image before a rebuild, for example
`alloy-ts-net:prev`:

```sh
docker tag alloy-ts-net:local alloy-ts-net:prev
# ...build and start the new image, then if it is bad:
docker compose -f deploy/compose.yml down
docker tag alloy-ts-net:prev alloy-ts-net:local
docker compose -f deploy/compose.yml up -d
```

To go back to a git revision instead, check out that commit and run
`docker compose -f deploy/compose.yml up --build -d`.

## Stop

```sh
docker compose -f deploy/compose.yml stop    # leaves the container, no auto-restart
docker compose -f deploy/compose.yml down    # remove the container, keep the image
```

`docker compose down` does not delete `alloy-ts-net:local`. Remove it with
`docker image rm alloy-ts-net:local` when you no longer need it.

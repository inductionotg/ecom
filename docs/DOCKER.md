# Docker deployment guide

This guide runs the complete OrderFlow application with Docker Compose while keeping PostgreSQL on Neon.

The deployment intentionally uses:

- one shared `Dockerfile`;
- three independent runtime containers;
- three short-lived migration containers;
- RabbitMQ and Redis in Docker;
- Neon PostgreSQL outside Docker.

There is no PostgreSQL container in `compose.yaml`.

## Table of contents

- [Why one Dockerfile is enough](#why-one-dockerfile-is-enough)
- [Container architecture](#container-architecture)
- [Startup flow](#startup-flow)
- [Prerequisites](#prerequisites)
- [Environment setup](#environment-setup)
- [Build and start](#build-and-start)
- [Verify the application](#verify-the-application)
- [View logs and trace failures](#view-logs-and-trace-failures)
- [Seed the inventory](#seed-the-inventory)
- [Run migrations manually](#run-migrations-manually)
- [Stop, restart, and rebuild](#stop-restart-and-rebuild)
- [Security notes](#security-notes)
- [Health-check limitation](#health-check-limitation)
- [Troubleshooting](#troubleshooting)

## Why one Dockerfile is enough

A Dockerfile is an image recipe, not a running service. The shared root [`Dockerfile`](../Dockerfile) accepts a `SERVICE_NAME` build argument. Compose invokes the same recipe several times with a different service directory:

| Build argument | Runtime image | Migration image |
|---|---|---|
| `order-service` | `orderflow/order-service:local` | `orderflow/order-service-migrate:local` |
| `inventory-service` | `orderflow/inventory-service:local` | `orderflow/inventory-service-migrate:local` |
| `payment-service` | `orderflow/payment-service:local` | `orderflow/payment-service-migrate:local` |

Each build copies only the selected service's `package.json`, lock file, Prisma files, and source. The result is still three separate runtime images and three separate containers. They can be restarted, scaled, deployed, and logged independently even though their build instructions are shared.

The Dockerfile has two relevant final targets:

- `runtime` contains production dependencies and starts `node src/app.js` as the non-root `node` user.
- `migrate` retains the Prisma CLI and runs `prisma migrate deploy` as a one-shot job.

`dumb-init` runs as PID 1 in both targets so shutdown signals are forwarded correctly. Prisma Client is generated during the image build with a deliberately fake build-only URL; the real Neon URL is injected only when a migration or application container starts.

## Container architecture

`compose.yaml` defines a private bridge network with the logical key `orderflow`. Docker normally creates it as `<project>_orderflow`. Service-to-service addresses are Docker DNS names such as `rabbitmq` and `redis`, not `localhost`.

```mermaid
flowchart LR
    Client[API client]

    subgraph Host[Docker host]
        O[Order container<br/>port 3001]
        I[Inventory container<br/>port 3002]
        P[Payment container<br/>port 3003]
        MQ[(RabbitMQ<br/>5672 / UI 15672)]
        R[(Redis<br/>6379)]
        OM[Order migration<br/>one shot]
        IM[Inventory migration<br/>one shot]
        PM[Payment migration<br/>one shot]
        V[(RabbitMQ named volume)]
    end

    subgraph Neon[Neon PostgreSQL - external]
        Public[(public schema)]
        Inventory[(inventory_schema)]
        Payment[(payment_schema)]
    end

    Client -->|HTTP| O
    Client -->|HTTP| I
    Client -->|HTTP| P

    O <--> MQ
    I <--> MQ
    P <--> MQ
    I <--> R
    MQ --- V

    O -->|TLS| Public
    I -->|TLS| Inventory
    P -->|TLS| Payment
    OM -->|migrate deploy| Public
    IM -->|migrate deploy| Inventory
    PM -->|migrate deploy| Payment
```

The host ports are for development access and bind to `127.0.0.1` by default. Containers communicate on their internal ports:

| Component | Container address | Default host address |
|---|---|---|
| Order API | `order-service:3001` | `http://localhost:3001` |
| Inventory API | `inventory-service:3002` | `http://localhost:3002` |
| Payment API | `payment-service:3003` | `http://localhost:3003` |
| RabbitMQ AMQP | `rabbitmq:5672` | `localhost:5672` |
| RabbitMQ UI | `rabbitmq:15672` | `http://localhost:15672` |
| Redis | `redis:6379` | `localhost:6379` |

## Startup flow

Compose starts infrastructure and database migrations in parallel where possible. Migrations are deliberately serialized because all three services point at the same Neon database, even though they own different schemas. A failed migration prevents dependent application containers from starting.

After migrations, application startup is deliberately ordered as Payment → Inventory → Order:

- Payment starts first and declares the queue that receives `inventory.reserved`.
- Inventory starts next and declares the queue that receives `order.ordercreated`.
- Order starts last, after all downstream consumers are healthy, and begins publishing outbox events.

```mermaid
flowchart TD
    Start[docker compose up]

    Start --> Rabbit[RabbitMQ starts]
    Start --> Redis[Redis starts]
    Start --> OM[order-migrate]

    OM -->|exit 0| IM[inventory-migrate]
    IM -->|exit 0| PM[payment-migrate]

    Rabbit -->|healthy| P
    PM -->|exit 0| P[Payment starts]
    P -->|healthy| I[Inventory starts]
    Redis -->|healthy| I
    IM -->|exit 0| I
    I -->|healthy| O[Order starts]
    OM -->|exit 0| O
    Rabbit -->|healthy| O
    P -->|healthy| O
    O --> Ready[Application ready]

    OM -->|non-zero| Blocked[Startup blocked]
    IM -->|non-zero| Blocked
    PM -->|non-zero| Blocked
```

The migration containers exiting with code `0` is expected. They are jobs, not long-running services.

## Prerequisites

Install:

- Docker Desktop with Docker Compose v2;
- a Neon project and database;
- three usable Neon connection strings, or one connection string with a different `schema` query parameter for each service.

Confirm Docker is running:

```powershell
docker version
docker compose version
```

Run all commands below from the repository root.

## Environment setup

### 1. Create the root Compose environment

The root environment controls the Compose project name, host bind address, published ports, and local RabbitMQ credentials.

PowerShell:

```powershell
if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
```

Bash:

```bash
[ -f .env ] || cp .env.example .env
```

The defaults work for local development. If any host port is already occupied, change it in the root `.env`. Use only URI-unreserved characters (`A-Z`, `a-z`, `0-9`, `.`, `_`, `~`, and `-`) in `RABBITMQ_USER` and `RABBITMQ_PASSWORD`, because Compose uses each value both literally in RabbitMQ and inside an AMQP URL.

### 2. Create the service environments

Create the files only if they do not already exist. Do not overwrite an existing file containing working Neon credentials.

PowerShell:

```powershell
if (-not (Test-Path -LiteralPath 'order-service/.env')) { Copy-Item -LiteralPath 'order-service/.env.example' -Destination 'order-service/.env' }
if (-not (Test-Path -LiteralPath 'inventory-service/.env')) { Copy-Item -LiteralPath 'inventory-service/.env.example' -Destination 'inventory-service/.env' }
if (-not (Test-Path -LiteralPath 'payment-service/.env')) { Copy-Item -LiteralPath 'payment-service/.env.example' -Destination 'payment-service/.env' }
```

Bash:

```bash
[ -f order-service/.env ] || cp order-service/.env.example order-service/.env
[ -f inventory-service/.env ] || cp inventory-service/.env.example inventory-service/.env
[ -f payment-service/.env ] || cp payment-service/.env.example payment-service/.env
```

### 3. Set the Neon URLs

Replace `DATABASE_URL` in each service file with a Neon runtime URL. When that URL uses Neon's pooler, set `MIGRATION_DATABASE_URL` to the corresponding direct/unpooled endpoint. Keep schema ownership explicit in both URLs:

```dotenv
# order-service/.env
DATABASE_URL="postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require&schema=public"
MIGRATION_DATABASE_URL="postgresql://USER:PASSWORD@DIRECT_HOST/DATABASE?sslmode=require&schema=public"

# inventory-service/.env
DATABASE_URL="postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require&schema=inventory_schema"
MIGRATION_DATABASE_URL="postgresql://USER:PASSWORD@DIRECT_HOST/DATABASE?sslmode=require&schema=inventory_schema"

# payment-service/.env
DATABASE_URL="postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require&schema=payment_schema"
MIGRATION_DATABASE_URL="postgresql://USER:PASSWORD@DIRECT_HOST/DATABASE?sslmode=require&schema=payment_schema"
```

If the Neon URL already contains a query string, add `&schema=...` instead of a second `?`. Percent-encode reserved characters in the database username or password.

The service example files also contain localhost RabbitMQ and Redis values for non-Docker development. Compose overrides those values at runtime:

- `RABBITMQ_URL` becomes an address using `rabbitmq:5672`;
- Inventory's `REDIS_URL` becomes `redis://redis:6379`;
- the application ports and queue names are set by Compose.

Therefore, only `DATABASE_URL` and the optional `MIGRATION_DATABASE_URL` in each service file must point to Neon for this deployment. If `MIGRATION_DATABASE_URL` is unset, the migration job falls back to `DATABASE_URL`.

## Build and start

Validate the Compose file without printing its fully rendered environment:

```powershell
docker compose config --quiet
```

Build every image:

```powershell
docker compose build
```

Start the stack in the background:

```powershell
docker compose up -d
```

Or build and start in one command:

```powershell
docker compose up -d --build
```

On the first run Docker downloads the Node, RabbitMQ, and Redis base images. Compose then applies the Neon migrations and starts the services in dependency order.

Check all containers, including completed migrations:

```powershell
docker compose ps -a
```

Expected state:

- `rabbitmq` and `redis` are running and healthy;
- `payment-service`, `inventory-service`, and `order-service` are running and healthy;
- `order-migrate`, `inventory-migrate`, and `payment-migrate` show `Exited (0)`.

Do not ignore a migration container with a non-zero exit code. The application startup is intentionally blocked until the failed migration is corrected.

## Verify the application

PowerShell:

```powershell
Invoke-RestMethod http://localhost:3001/health
Invoke-RestMethod http://localhost:3002/health
Invoke-RestMethod http://localhost:3003/health
```

Cross-platform:

```bash
curl http://localhost:3001/health
curl http://localhost:3002/health
curl http://localhost:3003/health
```

Each endpoint should return `status: UP` with its service name. If you changed a host port in the root `.env`, use the changed port here.

RabbitMQ management is available at `http://localhost:15672`. Sign in with the root `.env` values for `RABBITMQ_USER` and `RABBITMQ_PASSWORD`.

After optionally seeding inventory, the full Saga can be tested with the API examples in the project [README](../README.md#api-reference). The detailed success, inventory-failure, payment-failure, and compensation flows are in [ARCHITECTURE.md](./ARCHITECTURE.md).

## View logs and trace failures

Follow all application logs:

```powershell
docker compose logs -f --tail=100 order-service inventory-service payment-service
```

Inspect infrastructure:

```powershell
docker compose logs --tail=100 rabbitmq redis
```

Inspect migration failures:

```powershell
docker compose logs order-migrate inventory-migrate payment-migrate
```

Inspect one service:

```powershell
docker compose logs -f --tail=200 inventory-service
```

Use `Ctrl+C` to stop following logs; it does not stop containers.

Saga work is asynchronous. Trace a request across services using the `correlationId` and event/order identifiers in the structured logs. Expected business failures are logged and emitted as Saga events. Unexpected consumer failures are logged and rejected to the RabbitMQ dead-letter queue, `orderflow.dlq`. Never treat a `202 Accepted` response as final order success; poll the order until it becomes `CONFIRMED` or `FAILED`.

## Seed the inventory

The seed job writes two sample products to the external Neon `inventory_schema`. Run it only when you intend to modify that database:

```powershell
docker compose --profile seed run --rm inventory-seed
```

The current seed uses Prisma `upsert` by SKU, so repeating it does not create duplicate sample products. It does not reset existing stock.

Verify the catalog:

```powershell
Invoke-RestMethod http://localhost:3002/api/products
```

The `inventory-seed` service is behind the `seed` profile, so a normal `docker compose up` does not seed or modify product data.

## Run migrations manually

Migrations run automatically during `docker compose up`. To run them explicitly and sequentially:

```powershell
docker compose run --rm order-migrate
docker compose run --rm inventory-migrate
docker compose run --rm payment-migrate
```

`prisma migrate deploy` is intended for applying checked-in migrations. Do not run `prisma migrate dev` from these production-style containers against Neon.

## Stop, restart, and rebuild

Stop the application without removing containers:

```powershell
docker compose stop
```

Restart the stack while reapplying Compose's dependency conditions:

```powershell
docker compose up -d
```

Prefer `docker compose up -d` to a bare `docker compose start`. The project contains one-shot migration jobs and ordered health dependencies; `up` evaluates that model before bringing the application back.

Stop and remove containers and the Docker network:

```powershell
docker compose down
```

The RabbitMQ named volume is preserved by `docker compose down`. Neon data is external and is never removed by Compose. Redis is currently ephemeral and may lose cache entries when its container is replaced; that is safe because Redis is used as a cache.

Rebuild after source or dependency changes:

```powershell
docker compose up -d --build
```

Rebuild only one service image:

```powershell
docker compose build order-service
docker compose up -d order-service
```

Force a clean image rebuild:

```powershell
docker compose build --no-cache
docker compose up -d
```

To remove the local RabbitMQ volume as well:

```powershell
docker compose down --volumes
```

This permanently removes locally persisted RabbitMQ queues and messages. It does not delete Neon data.

## Security notes

- Never commit `.env` or any service `.env` file. Only commit sanitized `.env.example` files.
- The root [`.dockerignore`](../.dockerignore) excludes environment files, dependencies, logs, and repository metadata from the Docker build context.
- Real Neon credentials are not baked into an image. They enter containers at runtime through Compose `env_file`.
- Runtime environment values can still be visible to users with Docker access. Use a secrets manager or orchestrator secrets for a production deployment.
- Use a least-privilege Neon database role with access only to the schemas it needs.
- Use strong RabbitMQ credentials outside local development, but restrict these Compose values to URI-unreserved characters. Do not percent-encode them: the same literal value initializes RabbitMQ and is inserted into the AMQP URL.
- Do not expose RabbitMQ, Redis, or their management ports publicly in a production deployment.
- The local image tag `:local` is for development. Production releases should use immutable version or digest tags.

## Health-check limitation

The current `/health` routes are process-only checks. They prove that Express is responding, but they do not verify:

- Neon database connectivity;
- RabbitMQ connectivity or active consumer subscriptions;
- Redis connectivity;
- outbox relay progress;
- whether the dead-letter queue contains failed events.

Compose uses these endpoints for startup ordering, so `healthy` means “the HTTP process is alive,” not “every dependency and Saga path is operational.” For production, add readiness checks that validate critical dependencies and add metrics or alerts for outbox backlog, consumer failures, reconnect loops, and dead-letter messages.

## Troubleshooting

### Compose reports a missing service `.env` file

Create all three service files from their examples, then set the Neon `DATABASE_URL` in each one. Compose requires every file referenced by `env_file`, even though it overrides RabbitMQ, Redis, and ports.

### A migration container exits with code 1

Read its logs:

```powershell
docker compose logs order-migrate inventory-migrate payment-migrate
```

Common causes are an invalid Neon URL, missing `sslmode=require`, an incorrectly encoded password, missing schema permissions, or a temporary network failure. Fix the environment and rerun:

```powershell
docker compose up -d
```

If a Neon pooled endpoint rejects migration DDL or connection behavior, set `MIGRATION_DATABASE_URL` to Neon's direct connection endpoint while leaving the pooled runtime endpoint in `DATABASE_URL`.

### A service uses `localhost` for RabbitMQ or Redis

Inside a container, `localhost` means that same container. The correct Docker addresses are `rabbitmq:5672` and `redis:6379`. Compose already overrides them. Confirm you are starting through `compose.yaml` and have not added another override file that replaces these values.

### RabbitMQ authentication fails

Ensure the username and password in the root `.env` use only URI-unreserved characters and recreate the RabbitMQ container after changing its initial credentials:

```powershell
docker compose down
docker compose up -d
```

RabbitMQ persists its initialized users in the named volume. If this is disposable local data and credentials still do not change, remove the volume with `docker compose down --volumes` and start again. That deletes local queues and pending messages.

### A host port is already in use

Change the host-side value in the root `.env`, for example:

```dotenv
ORDER_PORT=3101
INVENTORY_PORT=3102
PAYMENT_PORT=3103
RABBITMQ_AMQP_PORT=5673
RABBITMQ_MANAGEMENT_PORT=15673
REDIS_PORT=6380
```

Container ports and internal service addresses do not change. Use the new host ports in browser, curl, or PowerShell requests.

Keep `HOST_BIND_ADDRESS=127.0.0.1` for local development. Change it only when you intentionally want another machine to reach the published ports and have also secured RabbitMQ and Redis.

### A service remains unhealthy

Inspect its logs and container state:

```powershell
docker compose ps -a
docker compose logs --tail=200 payment-service inventory-service order-service
```

Also check the migration exit codes and RabbitMQ/Redis health. Remember that the application health endpoint itself does not test external dependencies.

### The Saga appears stuck

Check, in this order:

1. Order, Inventory, and Payment structured logs for the same `correlationId`.
2. RabbitMQ queues and consumer counts in the management UI.
3. `orderflow.dlq` for rejected technical failures.
4. The Order outbox for unpublished or repeatedly failed events.
5. Neon connectivity and schema-specific migration state.

Do not manually mark an order successful when downstream state is unknown. Resolve or replay the failed event according to the operational procedure so compensation remains traceable.

### Source changes do not appear

The source is copied into images; it is not bind-mounted. Rebuild the affected image:

```powershell
docker compose up -d --build order-service
```

Use the equivalent service name for Inventory or Payment.

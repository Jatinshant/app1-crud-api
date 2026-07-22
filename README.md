# Application 1 — CRUD API

A simple CRUD API built with **Node.js, Express, and Prisma ORM**, connected to a **PostgreSQL** database (hosted on AWS RDS). This application was built as part of a DevOps Engineer technical assessment — the business logic is intentionally simple, as the focus of the task is the infrastructure and deployment pipeline around it, not the application itself.

---

## Tech Stack

- **Node.js + Express** — backend framework
- **Prisma ORM** — database access (no raw SQL used for data operations)
- **PostgreSQL** — database engine, hosted on AWS RDS
- **PM2** — process manager on the deployment server
- **Jenkins** — CI/CD (Pipeline-as-Code via the `Jenkinsfile` in this repo)

This stack was chosen deliberately to match Application 2 (Multi-Auth), which also uses Node.js + Express + Prisma + PostgreSQL. Keeping both applications on the same runtime and ORM reduces operational complexity on the shared server (one Node.js version to manage, one migration pattern, similar pipeline structure across both apps) rather than for any strict technical necessity.

---

## Endpoints

| Method | Endpoint | Description |
|--------|----------|--------------|
| GET | `/health` | Checks application status and database connectivity. Returns `200` with `{"status":"healthy"}` if both are fine, or `503` with `{"status":"unhealthy"}` if the database check fails. |
| POST | `/items` | Create a new item |
| GET | `/items` | List all items |
| GET | `/items/:id` | Get a single item by ID |
| PUT | `/items/:id` | Update an item by ID |
| DELETE | `/items/:id` | Delete an item by ID |

### Example: Health check response
```json
{
  "status": "healthy",
  "checks": {
    "app": "ok",
    "db": "ok"
  }
}
```

Note: the health check uses one raw query (`SELECT 1`) purely to test database connectivity — this is not a data-access query, so it does not bypass the ORM requirement. All actual CRUD data operations go through Prisma's query builder.

---

## Setup From Scratch

These steps take a fresh clone of this repo to a running instance, whether locally or on a server.

1. Clone the repository:
   ```bash
   git clone https://github.com/Jatinshant/app1-crud-api.git
   cd app1-crud-api
   ```
2. Copy `.env.example` to `.env` and fill in real values:
   ```bash
   cp .env.example .env
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Generate the Prisma client (required after every fresh install):
   ```bash
   npx prisma generate
   ```
5. Apply database migrations:
   - First-time / local development:
     ```bash
     npx prisma migrate dev --name init
     ```
   - Production / subsequent deploys (used by the Jenkins pipeline):
     ```bash
     npx prisma migrate deploy
     ```
6. Start the app:
   ```bash
   npm run dev     # development, with auto-reload
   npm start       # production
   ```

---

## Environment Variables

See `.env.example` for the full list. At minimum:

```
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/app1_db"
PORT=3000
```

No real credentials are committed anywhere in this repository or its commit history.

---

## CI/CD Pipeline (Jenkins)

The `Jenkinsfile` in this repo defines a fully automated pipeline, triggered on push via a GitHub webhook. No manual steps are required on the server after a push.

### Stages

1. **Check Changes** — inspects the files changed in the latest commit. If the only file changed is `README.md`, the remaining stages are skipped entirely (build, test, deploy, and health check do not run, and no rollback logic fires). This avoids unnecessary redeploys for documentation-only changes.
2. **Build** — copies the repo into a new versioned release folder, installs dependencies, and generates the Prisma client.
3. **Test** — runs the test suite (`npm test`) against the newly built release.
4. **Deploy** — prunes dev dependencies, links the shared production `.env`, runs `npx prisma migrate deploy`, atomically points a `current` symlink at the new release, and reloads the app under PM2.
5. **Health Check** — polls `/health` up to 3 times (5s timeout per attempt, 3s between attempts). Any non-`200` response after all attempts is treated as a failed deploy.

### Release & rollback strategy

Each deploy is written to its own folder under `/opt/app1-deploy/releases/<build-number>/`, and a `current` symlink points to whichever release is live. This means:

- Rolling back is just re-pointing the `current` symlink to the previous release folder and reloading PM2 — no rebuild needed, so rollback is fast and doesn't depend on the failing build's state.
- Old releases stay on disk, so rollback always has a known-good target as long as at least one prior successful deploy exists.

**Why `/opt` instead of a user's home directory:** Jenkins runs as its own dedicated system user (`jenkins`), not as `ubuntu`. A user's home directory (`/home/ubuntu`) is `700` by default and isn't traversable by other users — deploying there would require loosening permissions on the entire home directory, which is unnecessary exposure. `/opt` is a standard, world-traversable location for third-party application data, so the deploy target folder can be owned and managed by the `jenkins` user in isolation.

**Rollback trigger definition:** A deploy is considered failed, and rollback is triggered, only if `/health` does not return HTTP `200` after 3 attempts (5s request timeout, 3s wait between attempts, ~24s total window). This threshold was chosen to tolerate brief PM2 reload/restart latency without either rolling back too eagerly or waiting so long that a genuinely broken deploy stays live.

### Running Jenkins as a different user than the app (PM2 cross-user access)

The app runs under PM2 as the `ubuntu` user (its original setup), while Jenkins runs as its own `jenkins` system user with its own separate PM2 daemon. Rather than running the Jenkins agent itself as `ubuntu` (which would grant Jenkins broad access to that user's entire environment), a narrowly scoped passwordless `sudo` rule was added so the `jenkins` user can invoke only the `pm2` binary, and only as `ubuntu`:

```
jenkins ALL=(ubuntu) NOPASSWD: /usr/bin/pm2
```

This keeps the pipeline able to deploy and restart the app without granting Jenkins any wider access to the `ubuntu` account.

### Secrets across stages

- **Build time:** no secrets are present. The build stage only installs dependencies and generates the Prisma client.
- **Deploy time:** the production `.env` file lives once, outside git and outside any release folder, at `/opt/app1-deploy/shared/.env`. Each release symlinks this file in (`ln -sf`) rather than copying it — so secrets are never duplicated into a release folder or committed to git history.
- **Runtime:** the app reads `.env` via `dotenv` at process start, the same way in every environment (local, server, CI).
- **What's committed:** only `.env.example` (placeholder keys, no real values) is committed to this repo. Real `DATABASE_URL` values, database passwords, and any other secrets never appear in a commit, a build log, or a Jenkinsfile.

---

## Issues Faced During Setup (and how they were resolved)

Documenting these honestly, since they reflect real debugging done during development rather than a frictionless build.

### 1. Prisma 7 breaking change — `url` no longer supported in `schema.prisma`

**Error encountered:**
```
Error: Prisma schema validation - (get-config wasm)
Error code: P1012
error: The datasource property `url` is no longer supported in schema files.
Move connection URLs for Migrate to `prisma.config.ts` and pass either `adapter`
for a direct database connection or `accelerateUrl` for Accelerate to the
`PrismaClient` constructor.
```

**Cause:** The installed Prisma version (7.x) changed how database connection URLs are configured. Previously, `datasource db { url = env("DATABASE_URL") }` inside `schema.prisma` was standard — in Prisma 7, this responsibility moved to `prisma.config.ts` for the CLI/migrations, and `PrismaClient` itself now requires an explicit **driver adapter** to connect at runtime.

**Fix applied:**
- Removed the `url = env("DATABASE_URL")` line from `schema.prisma`, leaving only:
  ```prisma
  datasource db {
    provider = "postgresql"
  }
  ```
- Confirmed `prisma.config.ts` (auto-generated by `npx prisma init`) correctly reads the connection string:
  ```typescript
  import "dotenv/config";
  import { defineConfig } from "prisma/config";
  export default defineConfig({
    schema: "prisma/schema.prisma",
    migrations: { path: "prisma/migrations" },
    datasource: { url: process.env["DATABASE_URL"] },
  });
  ```
- Installed the PostgreSQL driver adapter:
  ```bash
  npm install @prisma/adapter-pg
  ```
- Updated `src/config/prisma.js` to construct `PrismaClient` with the adapter explicitly:
  ```javascript
  const { PrismaClient } = require('@prisma/client');
  const { PrismaPg } = require('@prisma/adapter-pg');

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  module.exports = prisma;
  ```

This brought the setup in line with Prisma 7's architecture and resolved the validation error.

### 2. Database authentication failure — wrong master username

**Error encountered:**
```
Error: P1000: Authentication failed against database server, the provided
database credentials for `admin` are not valid.
```

**Cause:** The `.env` file's `DATABASE_URL` used `admin` as the database username, which did not match the actual RDS master username configured for the instance (`postgres`). Additionally, the target database (`app1_db`) had not yet been created on the RDS instance — only the default `postgres` database existed at that point.

**Fix applied:**
- Corrected the username in `DATABASE_URL` from `admin` to `postgres` (matching the actual RDS master username).
- Connected to the RDS instance manually via `psql` and created the missing database:
  ```sql
  CREATE DATABASE app1_db;
  ```
- Re-ran the migration, which then succeeded:
  ```bash
  npx prisma migrate dev --name init
  ```

**Takeaway noted for the pipeline:** database credentials and database existence should be verified as part of environment setup before any deploy — a mismatch here fails loudly and early (good), but it's worth double-checking `.env` values against the actual RDS configuration rather than assuming.

### 3. `MODULE_NOT_FOUND` — `.prisma/client/default`

**Error encountered:**
```
Error: Cannot find module '.prisma/client/default'
```

**Cause:** `@prisma/client` does not ship pre-generated — the actual client code (matching the current schema) must be generated via `npx prisma generate`. After installing `@prisma/adapter-pg` and updating `node_modules`, the generated client was out of date/missing.

**Fix applied:**
```bash
npx prisma generate
```

**Takeaway noted for the pipeline:** the Jenkins build stage must always run `npx prisma generate` immediately after `npm install`, every single deploy — not just once — otherwise a fresh install on a clean environment (like a CI runner or a redeployed container) will crash with this same error.

### 4. Jenkins build stage — `Permission denied` writing to the deploy directory

**Error encountered:**
```
+ mkdir -p /home/ubuntu/app1-deploy/releases/1
mkdir: Permission denied
```

**Cause:** Jenkins runs its build steps as the `jenkins` system user, not as `ubuntu`. `/home/ubuntu` is `700` by default (owned by, and only traversable by, `ubuntu`), so `jenkins` had no way to create anything inside it — even after the target subfolder itself was chowned, the parent directory still blocked entry.

**Fix applied:**
- Moved the deploy target out of any user's home directory entirely, to `/opt/app1-deploy`:
  ```bash
  sudo mkdir -p /opt/app1-deploy/releases
  sudo chown -R jenkins:jenkins /opt/app1-deploy
  ```
- Updated every path reference in the `Jenkinsfile` from `/home/ubuntu/app1-deploy` to `/opt/app1-deploy`.

**Takeaway noted for the pipeline:** deploy targets should live in a location the CI system's own user can own outright (`/opt`, `/srv`, etc.), rather than inside another user's home directory — this avoids having to loosen permissions on a directory that holds unrelated personal files.

### 5. Test stage failure — `jest: not found`

**Error encountered:**
```
> npm test
> jest --detectOpenHandles --forceExit
sh: 1: jest: not found
```

**Cause:** The Build stage ran `npm install --production`, which skips everything in `devDependencies` — and `jest` (the test runner) lives there. So by the time the Test stage ran, `jest` was never installed in the first place.

**Fix applied:**
- Changed the Build stage to run a full `npm install` (no `--production` flag), so dev tooling like `jest` is present for the Test stage.
- Moved dependency pruning to the Deploy stage instead, running `npm prune --production` only after tests have already passed — so the final deployed release still ends up free of dev-only packages, without breaking the Test stage.

**Takeaway noted for the pipeline:** `--production`/`--omit=dev` installs should only happen after everything that needs `devDependencies` (tests, build tooling) has already run — pruning is a post-test step, not a pre-test one.

### 6. PM2 deploy failure — `Process or Namespace app1-api not found`

**Error encountered:**
```
[PM2] Spawning PM2 daemon with pm2_home=/var/lib/jenkins/.pm2
[PM2][ERROR] Process or Namespace app1-api not found
```

**Cause:** PM2 keeps a separate daemon and process list per system user (`~/.pm2`). The app was originally started under the `ubuntu` user's PM2 daemon, but Jenkins runs pipeline steps as the `jenkins` user — so from Jenkins' perspective, a completely separate (and empty) PM2 world existed, one that had never heard of `app1-api`.

**Fix applied:**
- Added a narrowly scoped passwordless `sudo` rule allowing the `jenkins` user to run only the `pm2` binary, and only as `ubuntu`:
  ```
  jenkins ALL=(ubuntu) NOPASSWD: /usr/bin/pm2
  ```
- Updated every PM2 command in the `Jenkinsfile` to run via `sudo -H -u ubuntu pm2 ...`, so Jenkins manages the correct, existing PM2 process instead of spinning up a second, unrelated one.
- Removed the stray PM2 daemon Jenkins had created under its own user (`sudo -u jenkins pm2 kill`, then deleted `/var/lib/jenkins/.pm2`).

**Takeaway noted for the pipeline:** when CI runs as a dedicated system user, it's worth checking early whether the actual deploy target (process manager, service, etc.) is scoped to a *different* user — otherwise CI can appear to "succeed" at commands that are silently operating on the wrong, empty state.

---

## Infrastructure Architecture

Both applications run on a single AWS EC2 instance (`t3.micro`, Ubuntu), fronted by Nginx as a reverse proxy, each on its own subdomain:

- `app1.jatintech.online` → Application 1 (this repo), Node.js/Express on port `3000`, managed by PM2.
- `auth.jatintech.online` → Application 2 (Multi-Auth), Node.js/Express on port `5000`, managed by PM2.
- `jenkins.jatintech.online` → Jenkins CI/CD, running on a non-default port (`8081`), reachable only via Nginx.

Both apps connect to a single AWS RDS PostgreSQL instance, using two separate databases (one per app). Jenkins, running on the same EC2 instance, deploys both applications via two independent Pipeline-as-Code jobs (one `Jenkinsfile` per repo), triggered automatically on push via GitHub webhooks. Every component other than Nginx itself (ports 80/443) is bound to `127.0.0.1` and unreachable directly from the internet — all traffic to the apps or to Jenkins passes through Nginx first.

---

## Nginx Reverse Proxy Setup

Nginx routes incoming requests to the correct application based on the **`Host` header** of the request — each subdomain has its own `server` block (virtual host) with a matching `server_name` directive, and Nginx dispatches the request to whichever block's `server_name` matches the incoming hostname. This is what allows one server, one public IP, and one pair of ports (80/443) to serve two completely separate applications (plus Jenkins) without any port conflicts — the underlying processes themselves never need to be exposed on public ports at all.

The configs below are copied directly from `/etc/nginx/sites-available/` on the server, including the `# managed by Certbot` lines Certbot itself inserted when it provisioned each certificate (`options-ssl-nginx.conf` and `ssl-dhparams.pem` set the actual TLS protocol/cipher policy and Diffie-Hellman parameters used by all three domains).

### Virtual host configs

**`app1.jatintech.online`** — proxies to the CRUD API on `127.0.0.1:3000`:
```nginx
server {
    server_name app1.jatintech.online;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/app1.jatintech.online/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/app1.jatintech.online/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
}
server {
    if ($host = app1.jatintech.online) {
        return 301 https://$host$request_uri;
    } # managed by Certbot
    listen 80;
    server_name app1.jatintech.online;
    return 404; # managed by Certbot
}
```

**`auth.jatintech.online`** — proxies to Multi-Auth on `127.0.0.1:5000`. This block additionally forwards the `Cookie` header explicitly, since the Multi-Auth service relies on `httpOnly` cookies for session/auth tokens — without forwarding this header, the browser's cookie would never reach the upstream app, breaking authentication silently:
```nginx
server {
    server_name auth.jatintech.online;
    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Cookie $http_cookie;
    }
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/auth.jatintech.online/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/auth.jatintech.online/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
}
server {
    if ($host = auth.jatintech.online) {
        return 301 https://$host$request_uri;
    } # managed by Certbot
    listen 80;
    server_name auth.jatintech.online;
    return 404; # managed by Certbot
}
```

**`jenkins.jatintech.online`** — proxies to Jenkins on `127.0.0.1:8081`, with two non-obvious decisions:
```nginx
server {
    server_name jenkins.jatintech.online;
    #--------------------------------
    # Jenkins UI — reachable over HTTPS by anyone; Jenkins' own
    # login (a dedicated read-only account for the reviewer) is
    # the actual access control, not the network layer
    #--------------------------------
    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 90s;
    }
    #--------------------------------
    # GitHub Webhook — open, same posture as above
    # (GitHub's webhook servers need to reach this to trigger builds)
    #--------------------------------
    location /github-webhook/ {
        proxy_pass http://127.0.0.1:8081/github-webhook/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 90s;
    }
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/jenkins.jatintech.online/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/jenkins.jatintech.online/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
}
server {
    if ($host = jenkins.jatintech.online) {
        return 301 https://$host$request_uri;
    } # managed by Certbot
    listen 80;
    server_name jenkins.jatintech.online;
    return 404; # managed by Certbot
}
```

- **No IP restriction on the Jenkins UI itself.** An earlier iteration of this config locked `location /` to the maintainer's IP only — but that would have also blocked the reviewer, since Jenkins' own login page is never reached until past the network layer. The task only requires SSH to be IP-restricted, not the Jenkins UI, and the reviewer needs to log in remotely from their own network. So the IP allowlist was removed from this block. HTTPS transport plus a dedicated, scoped read-only Jenkins account is the real access control here: anyone can reach the login page, but only accounts that exist in Jenkins (the maintainer's and the reviewer's read-only account) can do anything past it.
- **`/github-webhook/` needs no separate restriction** now that the parent `location /` isn't IP-gated — it inherits the same open-to-HTTPS, auth-at-the-app-layer posture, which is also what allows GitHub's webhook servers to reach it and trigger builds on push.

### Preventing the two apps from interfering with each other

- Each app is bound to `127.0.0.1` on its own port (`3000`, `5000`) — neither is reachable directly from the internet, only through its matching Nginx `server_name` block. There's no possibility of one app's traffic being routed to the other, since routing is keyed off the `Host` header, not the port alone.
- The default Nginx site (`/etc/nginx/sites-enabled/default`) was removed, so any request with a `Host` header that doesn't match one of the three configured subdomains gets no server block to match at all, rather than silently falling through to whichever app happens to be first alphabetically.
- Each app's PM2 process, deploy directory (`/opt/app1-deploy`, equivalent for Multi-Auth), and release/rollback state are fully independent — a failed deploy or rollback of one app has no path to affect the other.

---

## Port List & Justification

| Port | Protocol | Source | Purpose |
|---|---|---|---|
| 22 (SSH) | TCP | `223.181.45.39/32` (maintainer's IP only) | Shell access for administration. Restricted to a single IP rather than `0.0.0.0/0` to eliminate the internet's default attack surface against SSH. |
| 80 (HTTP) | TCP | `0.0.0.0/0` | Nginx only — immediately redirects every request to HTTPS (443) via Certbot-managed redirect blocks for all three subdomains. Left public because it must be reachable by anyone before their browser/client has negotiated HTTPS. |
| 443 (HTTPS) | TCP | `0.0.0.0/0` | Nginx only — the single public entry point for all three subdomains (App1, Multi-Auth, Jenkins). All routing to the actual apps or to Jenkins happens internally from here via `proxy_pass` to `127.0.0.1`. |

**Ports intentionally *not* present in the Security Group, and why that's correct rather than an oversight:**
- **3000 (App1), 5000 (Multi-Auth), 8081 (Jenkins)** — none of these appear in the Security Group at all, because none of them need to. Each process is bound to `127.0.0.1` only (verified via `netstat -tlnp`), meaning they aren't listening on any interface reachable from outside the instance in the first place — opening a Security Group rule for them would do nothing except needlessly widen the documented attack surface. Nginx reaches them over the loopback interface, which never touches the Security Group.

This is the full inbound rule set — nothing else is open on this instance.

---

## Database Strategy

A single AWS RDS PostgreSQL instance (`db.t4g.micro`) hosts two separate databases — `app1_db` for Application 1, and the Multi-Auth service's database — rather than provisioning two separate RDS instances.

**Trade-offs considered:**

- **Cost:** A single instance directly halves the RDS cost compared to two separate instances, since Free Tier / low-tier RDS pricing is per-instance, not per-database. For this assessment's scope (no production traffic, 3-day timeline), this was the deciding factor.
- **Isolation:** Two databases on one instance share the same underlying compute, memory, and IO — a spike in one app's query load can theoretically affect the other's latency. This is a real trade-off, not a free one; two separate instances would fully isolate the failure/performance domain of each app.
- **Connection limits:** `db.t4g.micro` has a relatively low max-connections ceiling shared across both databases. Since each app uses Prisma/PM2 with a small number of connections per process (not a large connection pool), this wasn't a practical constraint at this scale — but it's the first thing that would need revisiting if either app saw real concurrent traffic.
- **Failover:** A single instance means a single point of failure for both apps' data layers simultaneously — if this instance goes down, both apps lose database access at once. Two instances would mean an outage affecting only one app at a time. For a production deployment with real uptime requirements, this would weigh more heavily toward separate instances (or at minimum, a Multi-AZ deployment of the shared one).

**Why the shared instance was still chosen:** given the assessment explicitly frames either approach as valid and asks for justified reasoning rather than a "correct" answer, the cost and operational-simplicity benefits (one instance to patch, monitor, and back up) outweighed the isolation/failover downsides for this scope. In a real production system with meaningful traffic or uptime SLAs, I would revisit this in favor of separate instances, at least for failover isolation.

**Security:**
- RDS "Public access" is explicitly set to **No**.
- The RDS security group allows inbound connections only from the EC2 instance's security group — not from `0.0.0.0/0`, and not from any other IP.
- Database credentials are supplied via environment variables (`DATABASE_URL` in each app's `.env`) only — never committed to either repository, and never present in Jenkins build logs.

---

## Instance Sizing Rationale

### EC2: `t3.micro`
- **Free-tier eligible**, which matters directly for a 3-day assessment task with no production traffic to justify a larger instance.
- `t3.micro` provides 2 vCPUs (burstable) and 1 GB RAM — sufficient headroom to run two lightweight Node.js/Express apps (each idling well under 100MB per the PM2 memory figures observed during testing), Nginx, and Jenkins simultaneously, since none of these are under real concurrent load in this assessment context.
- **Trade-off acknowledged:** Jenkins itself is somewhat memory-hungry (JVM-based), and running it alongside two application processes on a 1GB instance leaves relatively little headroom — this was observed directly during setup, when `/tmp` (a small RAM-backed `tmpfs` partition) briefly triggered Jenkins' built-in disk-space monitor under normal operation. In a real production setting with actual user traffic, I would either move Jenkins to a separate, dedicated instance (decoupling CI/CD load from the apps it deploys) or scale up to a `t3.small`/`t3.medium`. For this assessment's scope — no real traffic, and the goal being to demonstrate the pipeline mechanics rather than handle load — a single `t3.micro` was the more cost-appropriate choice.

### RDS: `db.t4g.micro`
- Also **free-tier eligible**, and Graviton-based (`t4g` uses ARM, generally offering better price/performance than the equivalent `t3` instance class for database workloads).
- Sufficient for two lightweight databases (`app1_db`, Multi-Auth's database) under assessment-level query volume — no indexing/performance tuning was necessary at this scale.
- **Trade-off acknowledged:** a single small instance means both apps' databases share the same connection limit and the same underlying compute/IO — covered in more detail in the Database Strategy section above.

---

## Decision Note — Logic & Reasoning Challenges

**1. Reverse Proxy Design.** Nginx routes purely on the `Host` header of each incoming request — each subdomain has its own `server` block with a matching `server_name`, so Nginx dispatches to whichever block matches. All three services (App1, Multi-Auth, Jenkins) are bound to `127.0.0.1` on their own ports and are reachable only through their respective `server_name` block, not directly. The default Nginx site was removed so unmatched `Host` headers get no response at all, rather than silently hitting an arbitrary app.

**2. Database Separation Strategy.** One RDS instance, two databases, chosen for cost and operational simplicity over full isolation — detailed trade-off reasoning (cost, isolation, connection limits, failover) is in the Database Strategy section above. Security is still fully separated at the credential and network level: distinct `DATABASE_URL`s per app, and the RDS security group allows only the EC2 instance, never the public internet.

**3. MERN Pipeline — Prisma Migration Safety.** `npx prisma migrate deploy` runs on every deploy in the Multi-Auth pipeline rather than being conditioned on a schema-diff check — this is safe because Prisma itself tracks which migrations are already applied via `_prisma_migrations`, so a deploy with no new migrations is a no-op rather than a risk; a separate git-diff check would just be redundant with what Prisma already tracks internally. The actual safety mechanism is in failure handling: the Deploy stage's shell script runs with `set -e`, so if the migration step fails, the script stops immediately — the release symlink is never re-pointed and PM2 is never reloaded, meaning the app keeps serving the previous, working release instead of starting against a schema it doesn't match. That stage failure triggers the same rollback logic used for a failed health check (find the previous release, re-point the `current` symlink, reload PM2) — not a separate mechanism. One honestly-documented limitation: the post-deploy health check for this pipeline currently hits root `/` rather than a dedicated `/health` route, so it confirms the process is up but not that it can reach its database — unlike Application 1's `/health`, which explicitly checks DB connectivity via `SELECT 1`.

**4. Rollback Trigger Logic.** A deploy is considered failed, and rollback is triggered, if `/health` does not return HTTP `200` after **3 attempts**, each with a **5-second request timeout**, with a **3-second wait** between attempts (roughly a 24-second total decision window). This threshold tolerates normal PM2 reload latency without either rolling back too eagerly on a slow-but-healthy restart, or leaving a genuinely broken deploy live for too long. These numbers were chosen deliberately, not left as arbitrary defaults, and are defined explicitly in each Jenkinsfile's Health Check stage.

**5. Secrets Across Stages.** For both apps: no secrets exist at build time (only dependency installation and code generation happen there). At deploy time, each app's production `.env` lives once, outside git and outside any release folder, and is symlinked into the newly built release rather than copied or regenerated. At runtime, the app reads `.env` via `dotenv`, identically across environments. Only `.env.example` (placeholder values) is ever committed — real credentials never appear in a commit, a Jenkins build log, or a Docker/image layer.

**6. IAM Scoping.** The reviewer's IAM policy was written permission-by-permission rather than attaching the broad managed `ReadOnlyAccess` policy:
- **EC2 Describe* actions** (`DescribeInstances`, `DescribeSecurityGroups`, `DescribeSubnets`, `DescribeVpcs`, `DescribeNetworkInterfaces`, `DescribeAddresses`) — lets the reviewer confirm the instance exists, inspect the security group's port rules, and verify the Elastic IP, without any ability to start/stop/modify the instance or its network config.
- **RDS Describe* actions** (`DescribeDBInstances`, `DescribeDBSecurityGroups`, `DescribeDBSubnetGroups`) — lets the reviewer confirm the RDS instance's configuration (e.g. that Public Access is set to No) without being able to read actual data, modify the instance, or see credentials.
- **CloudWatch Logs read actions** (`DescribeLogGroups`, `DescribeLogStreams`, `GetLogEvents`, `FilterLogEvents`) — lets the reviewer inspect application/system logs for verification purposes, with no write or delete access to log data.

No action in this policy can create, modify, or delete any resource — every permission is a `Describe`/read action. This is deliberately narrower than the broad managed `ReadOnlyAccess` policy, which would have granted read access across every AWS service in the account regardless of whether this task uses them, which is unnecessary exposure for a reviewer who only needs to verify this specific task.

---

## Notes

- Rollback was deliberately tested (not just written) for **both** pipelines: a broken deploy was pushed on purpose to confirm each pipeline correctly detects the failed health check, finds the previous release, and restores it via PM2 — rather than assuming the logic was correct from reading it alone.
- Bonus items attempted: SSL via Let's Encrypt/Certbot on all three subdomains (App1, Multi-Auth, Jenkins), with automatic HTTP→HTTPS redirect. Further Nginx hardening (HSTS, CSP, rate limiting), automated DB backups with a tested restore process, and a local-dev Docker Compose setup were not attempted within the assessment's timeframe — noted here honestly rather than presented as done.

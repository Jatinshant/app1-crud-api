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

## Notes

- Rollback was deliberately tested (not just written): a broken deploy was pushed on purpose to confirm the pipeline correctly detects the failed health check, finds the previous release, and restores it via PM2 — rather than assuming the logic was correct from reading it alone.
- This README will be extended with the remaining infrastructure documentation (architecture overview, Nginx setup, port list, database strategy, IAM scoping, and the Logic & Reasoning Challenge answers) once all infrastructure components are complete, per the overall task's deliverables.

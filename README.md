# ReviewDesk

[![CI](https://github.com/GARBATHEGREAT/reviewdesk/actions/workflows/ci.yml/badge.svg)](https://github.com/GARBATHEGREAT/reviewdesk/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-MIT-blue)

**Rate AI answers as a team, and measure whether your reviewers actually agree.**

ReviewDesk is a full-stack web application for teams that evaluate AI output (chatbot answers, generated code, summaries).
Admins create projects and load tasks. Reviewers rate each answer independently. The app tells you how consistent the
team is, using Cohen's kappa, so you can tell a good AI from a confusing rubric.

| Sign in | Projects |
|---|---|
| ![Sign in](docs/screenshots/1-sign-in.png) | ![Projects](docs/screenshots/2-projects.png) |

| Review screen | Insights |
|---|---|
| ![Review](docs/screenshots/5-review.png) | ![Insights](docs/screenshots/4-insights.png) |

## The problem it solves

When several people rate AI output, three things go wrong:

1. **Reviewers influence each other**, so the ratings are not independent.
2. **Nobody knows whether the ratings are reliable.** If two reviewers disagree half the time, the numbers mean little.
3. **Work is tracked in spreadsheets**, with no record of who changed what.

ReviewDesk fixes these with **blind review** (you see others' ratings only after submitting your own), an
**agreement score** between reviewers, and an **audit log** of every important action.

## Features

- **Accounts and roles.** Admin, reviewer and viewer. The first person to register becomes the administrator; everyone else starts as a reviewer.
- **Projects with a rubric** and a configurable number of reviews needed per task.
- **Task queue.** Reviewers are served the next task they have not rated, assigned work first. Admins can assign tasks, filter and page through them, and import up to 100 at a time.
- **Blind review** and a verdict (pass, fail, unsure) with a 1 to 5 rating and notes.
- **Insights.** Progress, average rating, verdict split, per-reviewer stats, pairwise agreement and average kappa with a plain-language reading ("acceptable agreement", "weak agreement: review the guidelines").
- **CSV export** that is safe to open in a spreadsheet (formula-injection protected).
- **Audit log** of registrations, role changes, project changes, task assignments and reviews.
- **Operations.** Health and readiness checks, Prometheus metrics, structured logs with request ids, graceful shutdown, automatic database migrations.

## Tech stack

| Layer | Technology |
|---|---|
| Front end | React 18, TypeScript, Vite, React Router |
| API | Node.js 22, Express 4, TypeScript, Zod validation |
| Database | PostgreSQL, plain SQL migrations (run automatically) |
| Auth | Short-lived JWT access tokens, rotating refresh tokens in an httpOnly cookie, bcrypt |
| Tests | Vitest, Supertest (real PostgreSQL), Testing Library; end-to-end suite in a [separate repository](https://github.com/GARBATHEGREAT/qa-automation-suite) |
| Delivery | Docker (multi-stage), docker compose, GitHub Actions, Render blueprint |
| Monitoring | pino logs, Prometheus metrics, `/health` and `/ready` |

## Architecture

```mermaid
flowchart LR
  Browser["React app<br/>(Vite build)"] -->|"/api/*  JSON + cookie"| API
  subgraph Server["One Node.js process"]
    API["Express API<br/>auth, RBAC, validation"] --> Svc["Workflow rules<br/>blind review, task status, kappa"]
    API -->|"serves"| Static["Built web app"]
  end
  Svc --> DB[("PostgreSQL<br/>users, projects, tasks,<br/>reviews, audit_log")]
  API -.->|"/metrics"| Prom["Prometheus"]
```

In production one container serves both the API and the built React app, so there is a single thing to deploy and no cross-origin setup.

## Quick start

### Option A: nothing to install except Node.js 20 or newer

```bash
npm install
npm run dev:db          # starts a real PostgreSQL for development; leave it running
```

Open a second terminal.

macOS or Linux:

```bash
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/reviewdesk
export JWT_SECRET=dev-secret-change-me-please-123
npm run seed            # demo users and a demo project
npm run dev:api         # API on http://localhost:4000
```

Windows PowerShell:

```powershell
$env:DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:54329/reviewdesk"
$env:JWT_SECRET = "dev-secret-change-me-please-123"
npm run seed
npm run dev:api
```

Third terminal: `npm run dev:web` and open http://localhost:5173.

Demo accounts (created by `npm run seed`), password `ReviewDesk2024`:

| Email | Role |
|---|---|
| admin@reviewdesk.dev | admin |
| rita@reviewdesk.dev | reviewer |
| ravi@reviewdesk.dev | reviewer |

### Option B: Docker

```bash
docker compose up --build        # app on http://localhost:4000
docker compose --profile monitoring up --build   # adds Prometheus on http://localhost:9090
```

Open http://localhost:4000 and register: the first account becomes the administrator.

## API overview

All routes are under `/api`. Errors always look like `{"error": {"code": "...", "message": "...", "details": [...]}}`.

| Method and path | Who | What |
|---|---|---|
| `POST /auth/register`, `/auth/login` | public | Create an account, sign in |
| `POST /auth/refresh`, `/auth/logout` | cookie | Rotate the session, end it |
| `GET /auth/me` | any user | Current user |
| `GET /users`, `PATCH /users/:id/role` | admin | Manage people (the last admin cannot be demoted) |
| `GET/POST /projects`, `GET/PATCH/DELETE /projects/:id` | read: any, write: admin | Projects (delete archives) |
| `GET /projects/:id/tasks` | any user | List and filter tasks (`status`, `mine`, `page`, `pageSize`) |
| `POST /projects/:id/tasks` | admin | Add 1 to 100 tasks |
| `GET /projects/:id/next-task` | any user | Next task you have not rated |
| `PATCH /tasks/:id` | admin | Assign a task |
| `POST /tasks/:id/reviews` | admin, reviewer | Submit a review |
| `GET /tasks/:id/reviews` | any user | Reviews (blind for reviewers who have not submitted) |
| `GET /projects/:id/stats` | any user | Progress and agreement |
| `GET /projects/:id/export.csv` | admin, viewer | Download every review |
| `GET /audit` | admin | Latest actions |
| `GET /health`, `/ready`, `/metrics` | public (metrics can require a token) | Operations |

## Data model

`users` ← `refresh_tokens`; `projects` → `tasks` → `reviews` (one review per reviewer per task, enforced by a unique constraint);
`audit_log` records who did what. Rules such as allowed roles, rating range 1 to 5 and verdict values are enforced by
**database constraints**, not only in code. Migrations live in [`api/migrations`](api/migrations), run in order at start-up,
and are guarded by a database lock so two instances cannot migrate at once.

## Security decisions

- Passwords are hashed with bcrypt; sign-in gives the same message and takes similar time for unknown emails and wrong passwords.
- Access tokens last 15 minutes. Refresh tokens are random, stored only as a SHA-256 hash, **rotated on every use**, and re-use of an old token revokes all of that user's sessions.
- The refresh cookie is `httpOnly`, `SameSite=Strict` and `Secure` in production.
- Role checks run on the server for every route; the UI hiding a button is never the only protection. A role sent by a client at registration is ignored.
- Inputs are validated with Zod; SQL uses parameters only; error responses never include stack traces or SQL.
- Helmet security headers, a 1 MB body limit, and rate limiting on sign-in and registration.
- Exports neutralise spreadsheet formulas (`=`, `+`, `-`, `@`).
- Logs redact authorization and cookie headers.

## Testing

```bash
npm test               # API (unit + integration) and web tests
npm run typecheck
```

- **84 automated tests.** 72 in the API: unit tests for kappa, CSV, tokens, config and validation, and integration tests that run the real Express app against a **real PostgreSQL**. 12 in the web app (API client token refresh, sign-in screen, role-based UI).
- No database to install: if `TEST_DATABASE_URL` is not set, the tests start a temporary PostgreSQL automatically. CI uses a PostgreSQL service container.
- Covered: authentication and token rotation, role rules, validation, the review workflow including two reviewers submitting at the same moment, blind review, statistics, CSV export, health and metrics, migrations (idempotent, rolled back on failure).
- A separate end-to-end suite ([qa-automation-suite](https://github.com/GARBATHEGREAT/qa-automation-suite)) drives the running app with Playwright (browser, API, accessibility, regression). It found four bugs in this project, all fixed and documented there.

## Monitoring and operations

- `GET /health`: process is up. `GET /ready`: database reachable (use this for load balancer checks).
- `GET /metrics`: Prometheus metrics, including request duration histograms by route and status. Set `METRICS_TOKEN` to require a bearer token. Example queries are in [`ops/prometheus.yml`](ops/prometheus.yml).
- Logs are JSON (pino) with a request id that is also returned in the `x-request-id` header, so one request can be traced end to end.
- The server shuts down gracefully on SIGTERM and applies pending migrations at start-up.

## Deployment

- **Docker:** the [`Dockerfile`](Dockerfile) builds the API and web app, then runs a slim production image as a non-root user with a health check.
- **Render:** [`render.yaml`](render.yaml) is a blueprint: create a new Blueprint from this repository and it provisions the container, a PostgreSQL database and generated secrets.
- **CI:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) type-checks, runs all tests against PostgreSQL, builds, then builds the Docker image and smoke-tests the running container.

With `SEED_DEMO=true` (set in the blueprint) the app creates the demo accounts and demo project at start-up, so a public demo has data to explore. Remove that variable for a private deployment, where the first person to register becomes the administrator.

Status: deployment-ready. See the repository description for the live demo link once it is published.

Environment variables are listed in [`.env.example`](.env.example). `DATABASE_URL` and `JWT_SECRET` are required, and the server refuses to start if they are missing or weak.

## Project structure

```
api/
  migrations/        SQL schema changes, applied in order
  src/
    app.ts           Express app: middleware, routes, error handling
    routes/          auth, users, projects, tasks and reviews, audit
    lib/             kappa, csv, tokens, audit helper
    db/              pool, migration runner, seed
  tests/             unit and integration tests
web/
  src/               React app (pages, API client, auth context)
  tests/             component and client tests
ops/                 Prometheus config
```

## Known limits and next steps

- One organisation per installation (no multi-tenant workspaces yet).
- Email verification and password reset are not implemented.
- Access tokens are kept in memory in the browser and the session is restored from the refresh cookie; there is no "sign out everywhere" button yet (the server supports revoking all sessions).
- Agreement is calculated on the verdict (pass, fail, unsure). Ratings could use a weighted kappa in a future version.

## License

MIT

# Plan: AI-assisted project management platform

Status: **Draft for approval.** No application code has been written yet. This document covers delivery step 1 (plan, schema, approval). Everything here is a proposal. Section 11 lists the open questions that need your answer before step 2 starts.

---

## 1. Architecture overview

```
            ┌──────────────────────────────────────────────────────────┐
 Browser ──►│  web  (Next.js App Router, Node runtime)                 │
 (session   │   ├─ UI (RSC + client islands, Tailwind)                 │
  cookie)   │   ├─ /api/*        REST route handlers (Zod in/out)      │
            │   ├─ /api/mcp      MCP server, Streamable HTTP           │
 MCP client►│   ├─ /api/events   SSE stream (LISTEN/NOTIFY fan-out)    │
 (Bearer)   │   └─ /api/github/webhook  (HMAC-verified)                │
            └───────────────┬──────────────────────────────────────────┘
 GitHub ───────────────────►│ enqueue jobs / read+write domain         │
                            ▼                                          │
            ┌──────────────────────────────┐   NOTIFY   ┌────────────┴──┐
            │  db  (Postgres 16)           │◄──────────►│ worker         │
            │   app schema (Drizzle)       │            │  pg-boss       │
            │   pgboss schema (queue)      │            │  ├ agent.run   │
            └──────────────────────────────┘            │  ├ github.sync │
                                                        │  ├ eval.compute│
                                                        │  └ job.monitor │
                                                        │      │         │
                                                        │      ▼         │
                                                        │  PII Gateway ──┼──► Claude / OpenAI /
                                                        └────────────────┘    Gemini / Ollama
```

**Main design rules**

1. **One domain layer and many entry points.** REST routes, MCP tools, the webhook handler, and job handlers are thin adapters. They all call the same service functions in `src/server/services/*`. Each service function takes an `Actor` (member, role, project, API key ID, or `system:<subsystem>`) and does three things first: authorizes with `can(actor, action, resource)`, scopes the query by `project_id`, and validates input with Zod. The server enforces permissions in one place for every surface.
2. **One permission source.** `src/server/authz/matrix.ts` defines the permission matrix as data: `Action → Role[]`. Routes, MCP tool listing, and job handlers all read from it. The permission tests are generated from the same table and then checked against a hand-written expected matrix. This stops a mistake in the table from passing its own tests.
3. **One way out to models.** Only `src/server/ai/gateway.ts` imports the provider adapters. An ESLint `no-restricted-imports` rule enforces this, and a test fails if any other module imports `src/server/ai/adapters/*` or a provider SDK.
4. **Durable jobs.** Every long-running action writes a `jobs` row, which is the record users see, and a pg-boss job, which handles delivery. Both are written in the same transaction. The UI and MCP clients only ever read `jobs`.
5. **Postgres is the only infrastructure.** Queue (pg-boss), pub/sub (LISTEN/NOTIFY), rate limiting (`auth_throttle` table), and sessions all live in Postgres. There is no Redis. This keeps Docker Compose to the 3 required services.

### Key technology choices

| Concern | Choice | Reason |
|---|---|---|
| ORM / migrations | **Drizzle** + drizzle-kit | Close to SQL, always parameterized, and supports raw SQL migrations for triggers (append-only audit) and partial indexes. |
| Queue | **pg-boss** | Required option. Gives retries with backoff, singleton keys for idempotency, and cron. |
| Validation | **Zod** | Used at every boundary: HTTP bodies, query strings, MCP tool args, webhook payloads, env, job payloads, and model output. |
| MCP | `@modelcontextprotocol/sdk`, Streamable HTTP transport | Official SDK. A server instance is built per request with role-filtered tools. |
| AI SDKs | `@anthropic-ai/sdk`, `openai` (also for any OpenAI-compatible `baseURL`, such as Ollama), `@google/genai` | Official SDKs behind one `ModelAdapter` interface. |
| GitHub | `@octokit/app`, `@octokit/rest`, `@octokit/webhooks-methods` | Covers GitHub App installation tokens and signature verification. |
| PII helpers | `libphonenumber-js` plus custom validators | Phone numbers by region. Luhn, IBAN mod-97, and SSN/NINO/SIN format rules are in-house. |
| Tests | Vitest (unit + integration against a real Postgres via Testcontainers or the Compose DB), Playwright (e2e) | As required. |
| Package manager | npm with `package-lock.json`, exact versions (`save-exact=true`) | Pinned dependencies. `npm audit --audit-level=high` runs in CI. |

### Repository layout (proposed)

```
platform/
  docker-compose.yml          web, worker, db
  Dockerfile                  multi-stage; one image, two commands
  .env.example
  drizzle/                    SQL migrations (generated + hand-written triggers)
  src/
    app/                      Next.js routes (UI + /api)
    server/
      env.ts                  Zod-validated environment
      db/                     schema.ts, client, tx helpers
      auth/                   keys, sessions, throttle, auth events
      authz/                  matrix.ts, can(), guards
      services/               projects, requirements, tasks, members, reviews, ...
      state/                  task + requirement state machines (pure)
      jobs/                   enqueue, job records, heartbeat, handlers/*
      ai/                     gateway.ts, adapters/*, pricing.ts
      pii/                    detectors/*, normalize.ts, intent.ts, scan.ts
      github/                 app client, mapping, webhook, reconcile
      mcp/                    server factory, tools/*, resources, prompts
      realtime/               LISTEN/NOTIFY bus, SSE registry
      crypto/                 aes-gcm envelope, key hashing
      audit/                  append-only writer, export
      log/                    pino logger with redaction
    worker/index.ts           worker entry point
    components/               accessible UI primitives
  tests/
    unit/  integration/  permissions/  pii-corpus/  e2e/
  README.md  SECURITY.md
```

---

## 2. Authentication and sessions

**Key format:** `pmk_<prefix>_<secret>`

- `prefix` = 8 random base32 characters. It is stored in plaintext, indexed, and shown in the UI to identify the key.
- `secret` = 32 random bytes (256 bits) from `crypto.randomBytes`, base64url-encoded.
- Stored value: `HMAC-SHA-256(KEY_PEPPER, full_key)`. HMAC with a server-side pepper is at least as strong as plain SHA-256, and a leaked database alone cannot be used to check guessed keys. Lookup is by `prefix`, then a constant-time compare (`timingSafeEqual`) of the hash.
- Every key has a required `expires_at`. The default is 90 days and the maximum is 365 days, both configurable. The Leader can extend, shorten, or revoke a key.

**Validation on every request:** `authenticate(req)` resolves either `Authorization: Bearer pmk_…` (API and MCP) or the session cookie (UI) to an active `api_keys` row. The row is active only if `revoked_at IS NULL`, `expires_at > now()`, the membership is active, and the project is not archived. This is a single indexed query on every request, with no caching. That is what makes revocation take effect immediately.

**Web sessions:**

- `POST /api/auth/session { key }` exchanges a key for a session token: 32 random bytes in an `HttpOnly; Secure; SameSite=Strict; Path=/` cookie, with only its hash stored.
- `sessions.expires_at = min(now() + SESSION_TTL (default 8h), key.expires_at)`.
- Each request re-checks both the session and its key. Revoking or changing a key's expiry updates its sessions in the same transaction.
- CSRF protection for session routes uses a double-submit token: a non-HttpOnly `csrf` cookie plus an `X-CSRF-Token` header on every mutating request, together with `SameSite=Strict` and an `Origin` check. Bearer-authenticated requests are not subject to CSRF.

**Ending open streams:**

- Revoking a key, shortening its expiry, removing a member, or changing a role triggers `NOTIFY auth_changed, '<api_key_id>'`.
- Every web process LISTENs on that channel and closes matching SSE and MCP streams at once.
- As a safety net, each open stream also re-validates its key every 15 seconds and at `expires_at`, using a timer set to the exact expiry. This makes expiry exact even if a NOTIFY is missed.

**Throttling and lockout:**

- Failed attempts are counted per source IP and per key prefix in `auth_throttle`, using sliding windows.
- Defaults: 10 failures per 5 minutes per IP triggers a 15-minute IP lockout. 5 failures per key prefix locks that prefix for 15 minutes. Responses have a uniform shape and timing. All thresholds are configurable through environment variables.
- Every attempt (success, failure, lockout, session create or end, key issue, extend, revoke) is written to `auth_events`. The log records the prefix only, never the key.

**Role changes:** Each key carries its member's role. If the Leader changes a member's role, existing keys follow the new role immediately, because the role is read from the membership on every request. **See Q4.**

---

## 3. Permission matrix as code

```ts
// src/server/authz/matrix.ts
export const MATRIX = {
  'decision.final_approve':   ['leader'],                 // requirements, tasks, merges, completions
  'member.manage':            ['leader'],                 // invite, remove, change role
  'apikey.manage':            ['leader'],                 // issue, expire, revoke
  'project.configure':        ['leader'],                 // settings, GitHub link, models, credentials
  'work_item.write':          ['leader', 'maintainer'],   // create/edit/reorder/archive req + tasks
  'task.assign':              ['leader', 'maintainer'],
  'review.recommend':         ['leader', 'maintainer'],
  'task.work':                ['leader', 'maintainer', 'contributor'], // claim, run agent, submit (own/assigned)
  'comment.write':            ['leader', 'maintainer', 'contributor', 'viewer'],
  'project.read':             ['leader', 'maintainer', 'contributor', 'viewer'],
} as const satisfies Record<string, readonly Role[]>;
```

- `task.work` also requires that the task is assigned to the actor, or unassigned and being claimed. Leaders and Maintainers can work any task.
- Agents are not principals. An agent run carries `actor = member` with a restricted capability set. Calling `decision.final_approve`, `member.manage`, `apikey.manage`, `project.configure`, a `done` transition, or a merge from an agent context is rejected even if the member is a Leader.
- Tests: for every (action × role) cell, and for each surface that exposes that action (REST route, MCP tool, job handler), the suite asserts allow or deny. That comes to roughly 10 actions × 4 roles × up to 3 surfaces. A separate cross-project suite checks that a valid key for project A gets `404 NOT_FOUND` (not 403, so it learns nothing) for every project B resource.

---

## 4. State machines

### Task

```
draft ──► ready ──► in_progress ──► awaiting_review ──► approved ──► done
  │         ▲  │         │   ▲            │  │               │
  │         │  │         │   └── changes_requested ◄─┘  │         (Leader)
  │         │  │         ▼                                 │
  └─────────┴──┴──► blocked ◄──────────────────────────────┘
any non-terminal ──► cancelled          (blocked ──► previous state)
```

| Transition | Who |
|---|---|
| draft→ready, →blocked, blocked→prev, →cancelled | Leader, Maintainer (`work_item.write`) |
| ready→in_progress (claim) | `task.work` |
| in_progress→awaiting_review (submit; also set automatically when an agent draft is produced) | `task.work` / system on behalf of member |
| awaiting_review→changes_requested | **Leader decision** (Maintainers record a *recommendation* only) |
| changes_requested→in_progress | `task.work` |
| awaiting_review→approved | **Leader only** (`decision.final_approve`) |
| approved→done | **Leader only**. If the task has a linked PR, the merge happens as part of this step (see §7). |

- Agents and the `system:agent` actor can only produce a draft and move the task to `awaiting_review`.
- Every transition writes a `task_transitions` row (from, to, actor, at, reason) and an `audit_events` row.

### Requirement

Statuses: `draft`, `active`, `in_review`, `done`, `archived`.

- `in_review` is computed when every non-cancelled task is `done`.
- `→done` requires `decision.final_approve` **and** the all-tasks-done check, both done inside one transaction with `SELECT … FOR UPDATE`.
- A requirement with zero tasks cannot reach `done`.

---

## 5. Jobs, heartbeats, and live status

- **Kinds:** `agent.run`, `github.sync_out`, `github.webhook_apply`, `github.reconcile`, `eval.compute`.
- **States:** `queued`, `running`, `succeeded`, `failed`, `cancelled`, `blocked`, and **`stalled`**. `stalled` is added because the spec says jobs move to it.
- **Fields:** `started_at`, `last_heartbeat_at`, `progress` (0–100), `status_message`, `attempt`, `max_attempts`, `next_retry_at`, `error_code`, `idempotency_key`.
- **Enqueue:** `enqueueJob(tx, {kind, projectId, idempotencyKey, payload})` inserts the `jobs` row (with a unique `(project_id, kind, idempotency_key)`) and calls `boss.send(kind, {jobId}, {singletonKey: jobId, retryLimit, retryBackoff: true})` in the same transaction. pg-boss supports passing a db executor for this. If a duplicate request arrives, the existing job ID is returned.
- **Worker:** a handler wrapper marks the job `running`, starts a heartbeat interval (default every 10 s), passes `ctx.progress(pct, msg)` to the handler, and writes the terminal state.
  - Transient errors (network, 429, 5xx) are rethrown so pg-boss retries them with exponential backoff.
  - Permanent errors (`PII_BLOCKED`, validation, permission) mark the job `failed` or `blocked` and are not retried.
- **Idempotency:** each handler checks for an existing result before taking side effects. For example, an agent run is stored by `job_id`, and GitHub writes use deterministic branch names and check for existing issues.
- **Stall monitor:** a pg-boss cron runs every 30 s. It moves `running` jobs with `last_heartbeat_at < now() - JOB_STALL_SECONDS` (default 60) to `stalled`, notifies the Leader, and re-queues the job if attempts remain.
- **Restarts:** pg-boss persists queued jobs. When a worker dies, its in-flight jobs expire (`expireInSeconds`) and are retried. On startup the worker also sweeps `running` rows whose heartbeat is older than the stall threshold.
- **Live updates:**
  - Every write to `jobs`, `tasks`, `requirements`, or `comments` emits `NOTIFY project_events, '{projectId, type, id, version}'`. This is a small payload that only tells clients what changed, never row data.
  - The web process keeps one LISTEN connection and fans out to SSE subscribers filtered by project. Clients refetch the changed entity through normal authorized reads, so data never leaks through the stream.
  - Polling fallback: `GET /api/projects/:id/changes?since=<cursor>`, with the client switching to it automatically when EventSource fails.
- **UI:** a `<JobStatusBadge>` appears on task, requirement, and project views. It shows the state, progress, status message, and a relative heartbeat time ("heartbeat 4 s ago"). A stalled job is shown in a warning style.

---

## 6. AI agents and the PII gateway

**Adapter interface**

```ts
interface ModelAdapter {
  readonly provider: 'anthropic' | 'openai' | 'gemini' | 'openai_compatible';
  generate(req: { model: string; system: string; messages: ChatMessage[]; maxTokens: number; signal: AbortSignal })
    : Promise<{ text: string; usage: { inputTokens: number; outputTokens: number }; raw: { id: string } }>;
}
```

Only `gateway.ts` constructs adapters. The gateway works in this order:

1. Authorize the member (`task.work`). Check the model is in `project_models`. Load and decrypt the provider credential in memory only.
2. Assemble the context: the task, its requirement, acceptance criteria, selected GitHub file excerpts, and the member's instructions.
3. **Scan every segment of the context**, each labeled with its source. **Run an intent check** on the instruction.
4. If anything matches: **refuse** with `PII_BLOCKED {categories, sources}`, write `pii_refusals`, check the repeat threshold, and send nothing.
5. Call the adapter with a timeout and abort signal. Record token usage and cost (from a per-model pricing table the Leader can configure).
6. **Scan the output.** If it matches, block it with `PII_BLOCKED_OUTPUT`. The output is discarded and not stored, and a refusal is logged.
7. Store the `agent_runs` draft and move the task to `awaiting_review`.

Prompt and output are stored only after they pass the scan. Provider credentials never appear in logs, errors, or API responses. The API returns only `{provider, label, last4?, created_at}`.

**Encryption:** credentials use AES-256-GCM with `MASTER_KEY` (32 bytes, base64 env). Each record has a fresh 12-byte IV and stores `{key_version, iv, ciphertext, tag}`. The project ID and credential ID are bound as AAD, so a ciphertext cannot be swapped into another row. `key_version` allows the master key to be rotated later.

**PII detection method (deterministic, documented in SECURITY.md)**

1. **Normalization**, applied before the detectors run:
   - NFKC normalization.
   - Remove zero-width and bidi control characters.
   - Map common homoglyphs to ASCII.
   - De-obfuscate `[at]`, `(at)`, ` at `, `[dot]`, ` dot `.
   - Collapse spaced or dashed digit runs ("4 1 1 1-1111…").
   - Decode inline base64 and URL encoding where a segment decodes to printable text, and scan the decoded text too.
2. **Detectors**, each returning a category and a confidence:
   - `email`
   - `phone` (libphonenumber, using the project's default region)
   - `postal_address` (street number + street-type lexicon + city/ZIP/postcode patterns)
   - `government_id` (US SSN with invalid-range rules, UK NINO, CA SIN with Luhn, and passport/driver-licence patterns near keywords)
   - `financial_account` (card numbers with Luhn, IBAN mod-97, routing + account patterns near keywords)
   - `date_of_birth` (dates near DOB keywords)
   - `health` (a lexicon of conditions, medications, and diagnosis terms near a person reference)
   - `credential_secret`: known token formats (AWS, GitHub, Slack, Stripe, OpenAI/Anthropic keys, private key blocks, JWTs, connection strings with passwords) plus a high-entropy string heuristic
   - `name_with_contact`: a capitalized personal-name pattern (with a first-name list) within N tokens of any contact detector hit. This is mainly for reporting, since the contact detail alone is already blocked.
3. **Intent guard:** rule patterns plus a lexicon detect requests to collect, look up, infer, de-anonymize, or reveal information about a person ("find the home address of…", "what is X's phone…", "guess her age/ethnicity/health…"). This guard is applied to instructions only, not to the code context.
4. **Allowlist:** RFC 2606/6761 reserved domains (`example.com`, `.test`, `.invalid`), well-known test card numbers, and `noreply@github.com`-style bot addresses. **See Q6.**
5. **Known limits (documented):**
   - Names on their own, without contact details, are not reliably detected.
   - Non-English and non-Latin PII has lower recall.
   - Free-text health statements without lexicon terms may be missed.
   - Images and binary files are rejected rather than scanned.
   - Regex-based detection produces false positives on code (for example, numeric literals that pass Luhn). Blocking is deliberately conservative.
6. **Corpus test:** `tests/pii-corpus/{positive,negative}/*.jsonl` with at least 300 samples. It includes obfuscated forms, code fixtures, and the intent prompts. CI fails if recall on positives drops below 100% for the curated set, or if any curated negative is flagged.

**Repeat-refusal alert:** 3 or more refusals from the same member in 24 hours (configurable) creates a `notifications` row for the Leader and a live event. It fires at most once per window.

---

## 7. GitHub two-way sync

- **Linking:** the Leader uses either a **GitHub App** installation (preferred: short-lived installation tokens and a per-repo scope) or a **fine-grained PAT** limited to one repo with Issues, Pull requests, Contents, and Metadata permissions. Credentials are encrypted like provider credentials.
- **Mapping:**
  - Task ↔ issue. Task status is mirrored as a `status:<state>` label plus open/closed (closed when `done` or `cancelled`).
  - An agent draft that includes code becomes a branch `pm/task-<shortid>-run-<n>` with a commit and a **draft PR** linked to the issue (`Closes #n`).
- **Outbound:** every app status change enqueues `github.sync_out` (idempotent by `task_id + version`).
- **Inbound:** `/api/github/webhook` does the following:
  - Verifies `X-Hub-Signature-256` with a constant-time comparison.
  - Dedupes on `X-GitHub-Delivery` (stored in `github_deliveries`).
  - Validates the payload with Zod.
  - Enqueues `github.webhook_apply`.
- **Reconciliation:** a cron runs every 10 minutes (and on demand) and compares app state against GitHub.
- **Conflict rule, as specified:** **the app is the source of truth for status, and GitHub is the source of truth for code.**
  - A GitHub status change, such as a label edit or closing or reopening an issue, is a *request*. It is applied in the app only if that transition is valid **and** needs no Leader decision, for example `ready → in_progress`. The actor is `system:github` on behalf of the mapped member if the GitHub user is linked, otherwise `system:github`. This satisfies the acceptance criterion "a GitHub issue status change appears in the app".
  - If the change is invalid or needs a Leader decision (for example, someone closes an issue to mean "done"), the app keeps its status, re-asserts it on GitHub (reopens the issue and resets the label), and writes a `conflict_resolved` audit event with both values.
  - Code (branch contents, PR diff) is always read from GitHub. If someone pushes to a draft branch, the review view shows the new diff and marks the review as stale.
- **Merging:**
  - Only `approved → done` by the Leader triggers `PUT /pulls/:n/merge`, with an expected `sha` guard so a different commit cannot be merged by accident.
  - If a PR is merged on GitHub without approval, the app cannot undo it (GitHub owns code). It records a conflict, raises an open risk on the evaluation view, and alerts the Leader.
  - SECURITY.md will recommend a branch protection rule so that only the app can merge.

---

## 8. MCP server

- **Endpoint:** `POST/GET/DELETE /api/mcp` using `StreamableHTTPServerTransport`, with `Authorization: Bearer pmk_…`. Origin validation and the same throttle as other auth apply.
- **Per-request server:** each request builds a server with only the tools the role allows (`listTools` is filtered from `MATRIX`). Each tool handler also re-checks with `can()`, so a tool called directly without being listed is rejected with `FORBIDDEN`.
- **Session expiry:** an MCP session ID is bound to the API key. Revocation closes it through the same `auth_changed` channel described in §2.

**Tools**

| Tool | Action | Long-running → returns `job_id` |
|---|---|---|
| `list_projects` | project.read (only the key's project; a user's other keys are separate) | |
| `get_project`, `list_requirements`, `list_tasks`, `get_task_status`, `get_job_status` | project.read | |
| `comment` | comment.write | |
| `create_task`, `update_task`, `create_requirement` | work_item.write | |
| `assign_task` | task.assign | |
| `claim_task`, `submit_for_review` | task.work | |
| `run_agent` | task.work | ✅ |
| `recommend_review` | review.recommend | |
| `decide_review`, `approve_requirement` | decision.final_approve | `decide_review(done)` with PR merge ✅ |
| `sync_github` | project.configure | ✅ |
| `run_evaluation` | project.read | ✅ |

- **Resources:** `project://{id}`, `project://{id}/requirements`, `task://{id}`, `job://{id}`, `project://{id}/evaluation`.
- **Prompts:** `triage_requirement`, `plan_tasks_for_requirement`, `work_task`, `review_draft`.
- **Errors:** every tool error is structured as `{code, message, details?}` with stable codes:
  - `UNAUTHENTICATED`, `KEY_EXPIRED`, `KEY_REVOKED`, `FORBIDDEN`, `NOT_FOUND`
  - `VALIDATION_FAILED`, `INVALID_TRANSITION`, `CONFLICT`, `RATE_LIMITED`
  - `PII_BLOCKED`, `PII_BLOCKED_OUTPUT`, `MODEL_NOT_ALLOWED`, `PROVIDER_ERROR`, `GITHUB_ERROR`, `INTERNAL`

  REST routes use the same codes. Both surfaces get them from one `AppError` class.

---

## 9. Data model

All tables have `id uuid pk default gen_random_uuid()` and `created_at timestamptz`. Every project-owned table has `project_id uuid not null` and an index starting with `project_id`. Types are shown in shorthand.

| Entity | Columns (beyond id / created_at) | Notes |
|---|---|---|
| **users** | display_name, github_login?, updated_at | No passwords or email required. See Q2 on how a user is recognized across projects. |
| **projects** | name, slug unique, description, leader_user_id → users, archived_at?, settings jsonb (session TTL, default key TTL, PII region, alert thresholds), updated_at | Exactly one Leader, enforced by `memberships` with a partial unique index. |
| **memberships** | project_id, user_id, role enum(leader,maintainer,contributor,viewer), status enum(active,removed), removed_at?, unique(project_id,user_id) | Partial unique index `(project_id) WHERE role='leader' AND status='active'`. |
| **invitations** | project_id, role, token_hash, token_prefix, invited_by → memberships, label (free text), expires_at, redeemed_at?, redeemed_by_user_id?, revoked_at? | Single use: `UPDATE … SET redeemed_at=now() WHERE id=? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at>now() RETURNING`. |
| **api_keys** | project_id, membership_id, prefix unique, key_hash, label, expires_at not null, revoked_at?, revoked_by?, last_used_at?, created_by | The role is read from the membership. |
| **sessions** | api_key_id, token_hash unique, csrf_hash, expires_at, ended_at?, user_agent_hash, ip_hash | Ends when the key ends. |
| **auth_events** | api_key_prefix?, project_id?, event enum, outcome, ip_hash, user_agent_hash, detail jsonb (redacted) | Append-only. |
| **auth_throttle** | scope enum(ip,prefix), subject_hash, window_start, failures, locked_until? | |
| **requirements** | project_id, key (e.g. `REQ-12`), title, description, acceptance_criteria jsonb [{id,text}], priority enum(p0..p3), status enum, position numeric (for reorder), version int, archived_at?, approved_by?, approved_at?, updated_at | Optimistic concurrency on `version`. |
| **tasks** | project_id, requirement_id, key (`TASK-34`), title, description, status enum (9 states), status_before_block?, assignee_membership_id?, position, version, github_issue_number?, updated_at | |
| **task_transitions** | project_id, task_id, from_status, to_status, actor_type enum(member,system), actor_membership_id?, actor_system?, reason?, at | Used for time-in-state metrics. |
| **agent_runs** | project_id, task_id, membership_id (on behalf of), job_id unique, provider, model, input_snapshot jsonb (only after it passes the scan), output_text?, draft_kind enum(text,code), github_branch?, github_pr_number?, input_tokens, output_tokens, cost_usd numeric(12,6), status, error_code? | A draft only, never final. |
| **jobs** | project_id, kind, status enum (7 states), idempotency_key, payload jsonb, result jsonb?, progress smallint, status_message, attempt, max_attempts, started_at?, last_heartbeat_at?, finished_at?, next_retry_at?, error_code?, requested_by_membership_id?, target_type?, target_id?, unique(project_id,kind,idempotency_key) | The record users see. pg-boss lives in its own schema. |
| **reviews** | project_id, task_id, agent_run_id?, reviewer_membership_id, kind enum(recommendation,decision), verdict enum(approve,request_changes), body, reviewed_commit_sha?, stale bool | `decision` is allowed only for the Leader (CHECK enforced in the service). |
| **comments** | project_id, target_type enum(requirement,task,agent_run,review), target_id, author_membership_id, body, edited_at?, deleted_at? | |
| **github_links** | project_id unique, owner, repo, auth_type enum(app,pat), installation_id?, credential_id? → provider_credentials, webhook_secret_enc, default_branch, last_reconciled_at? | |
| **github_deliveries** | delivery_id unique, event, received_at, processed_at? | Dedupes webhook deliveries. |
| **provider_credentials** | project_id, provider enum(anthropic,openai,gemini,openai_compatible,github), label, base_url?, key_version, iv bytea, ciphertext bytea, auth_tag bytea, last4?, created_by, revoked_at? | Never returned or logged. |
| **project_models** | project_id, provider, model, credential_id, input_price_per_mtok, output_price_per_mtok, enabled | The allowlist of models a member can choose from. |
| **pii_refusals** | project_id, membership_id, direction enum(input,output,intent), categories text[], sources text[], job_id?, at | **No matched content is stored.** |
| **notifications** | project_id, recipient_membership_id, kind (pii_repeat, job_stalled, github_conflict, unapproved_merge), payload jsonb (redacted), read_at? | In-app only for v1. |
| **audit_events** | project_id?, actor_type, actor_membership_id?, actor_role?, actor_system?, action, target_type, target_id, before jsonb?, after jsonb?, request_id, at | **Append-only:** a BEFORE UPDATE/DELETE trigger raises an exception, and the app DB role has only INSERT/SELECT. Redacted before write (no secrets or PII payloads). Also serves as the activity feed and the record of conflict resolutions. |

**Isolation:** every service query goes through `scoped(actor)`, which always adds `where project_id = actor.projectId`. As a second layer, **Postgres Row-Level Security** is enabled on all project tables, with the policy `project_id = current_setting('app.project_id')::uuid`. That setting is applied per transaction with `SET LOCAL`. The worker sets it per job. **See Q7.**

---

## 10. Milestones

Each milestone ends with: tests green → commit → short summary.

| # | Milestone | Deliverables | Exit criteria (tests) |
|---|---|---|---|
| 1 | **Plan & schema** | This document; answers to open questions | Your approval |
| 2 | **Scaffold, Compose, CI** | Next.js strict TS, Tailwind, ESLint (incl. gateway import rule), Drizzle + initial migration, Dockerfile, `docker-compose.yml` (web/worker/db with healthchecks), `.env.example`, Zod env, pino with redaction, security headers + CSP + CORS, GitHub Actions: typecheck, lint, unit, integration (Postgres service), `npm audit`, Playwright smoke | `docker compose up` serves `/healthz` for web and worker; CI green |
| 3 | **Auth, sessions, roles, permission tests** | Key generation/hashing, bootstrap CLI (see Q1), session exchange, CSRF, throttle/lockout, auth events, `MATRIX` + `can()`, request context, `AppError` codes, RLS | Permission test for every matrix cell; expired/revoked key → 401 on next request; lockout tests; cross-project 404 tests |
| 4 | **Projects, requirements, tasks, dashboard** | CRUD + reorder + archive; task and requirement state machines; transitions + audit; dashboard (coverage, status counts, blocked, recent activity) | State-machine unit tests (every allowed/denied transition); "requirement done only when all tasks done + Leader"; audit before/after recorded |
| 5 | **Invitations & members** | Invite (single use, expiring), redeem → membership + key shown once, remove member, change role, key issue/extend/shorten/revoke UI | Acceptance #1 (Leader creates project → invites → member connects) as an integration test; reused/expired invite rejected |
| 6 | **Jobs, worker, heartbeats, live status** | `jobs` + pg-boss, handler wrapper, heartbeats, stall monitor, retries, restart sweep, NOTIFY bus, SSE endpoint with revocation teardown, polling fallback, `<JobStatusBadge>` everywhere | Kill worker mid-job → job resumes; no heartbeat → `stalled` + Leader notified; revoked key closes open SSE stream within 1 s |
| 7 | **Agent adapters & PII gateway** | Adapters (Anthropic, OpenAI, Gemini, OpenAI-compatible), credential encryption, model allowlist, gateway, PII detectors + normalization + intent guard, output scan, refusal log + repeat alert, PII corpus | Acceptance #4: provider mock records **zero** calls on PII input; corpus thresholds; agent context cannot call approve/done/merge |
| 8 | **Review & evaluation** | Review view (draft, diff, requirement, acceptance criteria), recommendations vs Leader decision, evaluation view (coverage, pass rate, rework rate, cost, time-in-state, open risks), `eval.compute` job | Acceptance #5: draft cannot reach `done` without Leader; metric unit tests |
| 9 | **GitHub two-way sync** | Link via App/PAT, issue mapping, branch + draft PR for code drafts, webhook verify + dedupe, apply rules, reconciliation cron, merge-on-approval with SHA guard, conflict logging | Acceptance #6 against a recorded/mock GitHub API (nock); bad signature rejected; conflict rule tests |
| 10 | **MCP server** | Streamable HTTP endpoint, role-filtered tools, resources, prompts, structured errors, job IDs for long tools, stream teardown on revoke | Acceptance #7 using the MCP SDK client per role; hidden tool called directly → `FORBIDDEN` |
| 11 | **Hardening, e2e, docs** | Playwright e2e of all acceptance criteria, a11y checks (axe), log/error redaction review, `SECURITY.md` (threat model, key lifecycle, PII limits), `README.md`, audit export (CSV/JSONL) | All 8 acceptance criteria pass in e2e; `npm audit` clean at high |

---

## 11. Open questions (need your answer before milestone 2)

1. **Bootstrap and project creation.** With API keys as the only credential and keys scoped to one project, someone has to create the first Leader, and someone has to create new projects. Proposal:
   - A one-time `npm run bootstrap -- --project "Name" --leader "Display Name"` CLI (run in the web container) prints the first Leader key.
   - After that, any active key holder can create a new project, becomes its Leader, and receives a new Leader key for it, shown once.
   - Optionally, an instance setting `PROJECT_CREATION=leaders_only|anyone`.

   OK?
2. **Identity across projects.** A key belongs to one member in one project, so a person in 3 projects holds 3 keys. Proposal:
   - When redeeming an invitation, a person can present one of their existing valid keys to link the new membership to the same `User`. Otherwise a new `User` is created.
   - The web UI keeps a "key ring" of several sessions, one per project, so the user can switch projects without pasting keys each time. Each session is still bound to its own key.

   OK?
3. **Where should the code live?** This repository currently holds the static Erlanger Disciples church website. The platform is unrelated. Proposal: build it in a **new, separate repository**. Alternatives: build it under `platform/` here (where this plan is), or replace the site. Which do you prefer?
4. **Role changes and existing keys.** Proposal: a key always takes its member's *current* role, so changing a role takes effect immediately with no new key needed. The alternative is to freeze the role into each key and require reissuing keys after a role change. Which do you prefer?
5. **Who moves `approved → done`?** Proposal: the Leader only. When a PR is attached, this action also performs the merge. Alternatively, `done` could follow automatically when the approved PR merges. Which do you prefer?
6. **PII allowlist.** Proposal: allow reserved example domains (`example.com`), documented test card numbers, and GitHub bot/noreply addresses. Without this, much ordinary code and git metadata would be blocked. Note that this is a narrow exception to "block on any match". Approve?
7. **Postgres RLS as a second isolation layer.** This adds some complexity (`SET LOCAL` per transaction) and gives defense in depth against a missed `where`. Proposal: include it. Agree?
8. **Notifications.** Proposal: in-app notifications only (with a badge and live events) for "notify the Leader". No email in v1, because email would need SMTP setup and handling of personal data. OK?

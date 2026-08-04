# infra/ — feedback + telemetry ingest stack (Terraform)

The cloud half of the in-app feedback loop and of usage analytics: one HTTP API with
**two routes**, **two Lambdas**, one **Aurora DSQL** cluster, one S3 bucket, and the guard
rails that make **publicly writable** endpoints safe to leave running. Design + rationale live
in `docs/plans/feedback-triage.md` (§7–§10) and `docs/plans/usage-analytics.md`; this file is
the runbook.

> **TWO FUNCTIONS, ON PURPOSE.** `POST /v1/telemetry` is its own Lambda with its own IAM role
> and its own **database** role, not a second route on the submit handler. Everything that
> makes either endpoint safe is per-identity — an IAM policy with one or two statements, and a
> GRANT list that is the real answer to "what can a compromised public endpoint do". One
> function serving both would hold the union: `INSERT ON report` plus an S3 presign permission
> for the counter path, and UPSERT on the counters for the feedback path. The cost of the split
> is one more zip and one more log group.

- **IaC: Terraform (HCL)** — owner decision, 2026-08-03. Not CDK.
- **Store: Aurora DSQL** (serverless Postgres) — owner decision. The plan and the
  first cut of this stack used DynamoDB; §3.2's single-table design existed only
  because DynamoDB cannot filter without an index, so in SQL the five item kinds
  are five tables, the two GSIs are two indexes, and `--since 7d` is a `WHERE`.
- **Region: us-east-1**, in a **dedicated AWS sub-account** (AWS Organizations).
- **CI validates. CI never plans and never applies.** There are no cloud
  credentials and no OIDC deploy role in a public repo; deploying is a manual act
  from the dev machine. See `.github/workflows/infra.yml`.

## What gets created

| File | Resources |
| --- | --- |
| `versions.tf` | provider pins (aws `~> 6.0` — `aws_dsql_cluster` needs it) + the `backend "s3"` block + default tags |
| `variables.tf` | region, name prefix, alarm email, triage principal, every spend knob (both routes) |
| `api.tf` | HTTP API `eqcompanion-api`, `$default` stage, `POST /v1/feedback` + `POST /v1/telemetry`, stage + per-route throttles, access logging |
| `lambda.tf` | `eqcompanion-feedback-submit` and `eqcompanion-telemetry-ingest` (both Node 22, arm64, 256 MB, 10 s), their log groups at 14-day retention |
| `dsql.tf` | the Aurora DSQL cluster (deletion protection + `prevent_destroy`) and the endpoint/ingest-role locals |
| `schema.sql` | the tables, indexes, config seed and the two ingest **database roles** — applied by the CLI, not by Terraform (see step 2.5) |
| `s3.tf` | `eqcompanion-logs-<random hex>` + all four Block-Public-Access flags + SSE-S3 + versioning off + 90-day lifecycle + `prevent_destroy` |
| `iam.tf` | the two ingest roles (`dsql:DbConnect` only; telemetry has no S3 at all) and `EqCompanionFeedbackTriageRole` (`dsql:DbConnectAdmin`) |
| `alarms.tf` | `EqCompanionOpsAlerts` SNS topic + email sub + 8 alarms + a $10 monthly budget |
| `dashboard.tf` | `eqcompanion-telemetry` CloudWatch dashboard, fed by the ingest handler's EMF documents |
| `outputs.tf` | `api_url`, `telemetry_api_url`, `cluster_endpoint`, `bucket_name`, `triage_role_arn`, both `*_role_arn`s, log group names |
| `build.mjs` | esbuild bundles of `lambda/submit.ts` and `lambda/telemetry.ts` → **deterministic** `dist/submit.zip` + `dist/telemetry.zip` |

Each handler imports its validator from `src/shared/` — `validateSubmit` from
`feedback.ts`, `validateTelemetryBatch` from `telemetryValidate.ts` — so the server runs the
same validator as the client. `build.mjs` is what makes those imports survive into a Lambda
zip, and CI runs it on every change to either side so the two cannot drift apart silently.

The telemetry handler additionally imports `src/shared/telemetryRollup.ts`, which is the ONE
definition of what a batch becomes: the metric names it writes are the metric names the triage
Analytics tab and `triage-feedback analytics digest` read back.

## There is no database password

Aurora DSQL authenticates with a short-lived IAM token that `@aws-sdk/dsql-signer`
derives **locally** (SigV4 over the cluster hostname — no network call) from
whatever credentials the caller already holds. Nothing is stored in Secrets
Manager or SSM, nothing rotates, and there is no credential to leak.

Two identities, and the difference matters:

| Who | IAM action | Database role | Can do |
| --- | --- | --- | --- |
| the submit Lambda | `dsql:DbConnect` | `feedback_ingest` | `INSERT` on `report`; read config/profile; read+write+delete the three counter tables |
| the telemetry Lambda | `dsql:DbConnect` | `telemetry_ingest` | read `feedback_config`; UPSERT `usage_daily`, `usage_funnel_daily`, `analytics_install`. **No privilege at all on `report`, no `install_profile`, no DELETE anywhere.** |
| the triage CLI | `dsql:DbConnectAdmin` | `admin` | everything — it applies the schema and it is the deletion path for `forget`/`wipe`/`analytics wipe` |

§8.5's promise — *the ingest path can create and count; it cannot read the corpus
or destroy anything* — used to be enforced by omitting `dynamodb:Query`/`Scan`/
`DeleteItem` from a policy. DSQL has one IAM action for data access, so the
property moved down a layer: the Lambda may only log in **as a named database
role**, and that role's `GRANT` list (bottom of `schema.sql`) is where the promise
now lives. Granting the Lambda `dsql:DbConnectAdmin` would hand a public write
endpoint superuser on the whole backlog. Never do it.

## One-time: the sub-account and the state backend

Already done for this product — recorded here so it can be redone or audited:

1. Create a dedicated account in AWS Organizations for the product.
2. Create a local profile that assumes an admin role in it. This repo commits
   **no profile name and no account id**; the examples below use `<profile>`.
3. Hand-create the state backend in that account, in **us-east-1** (a backend
   cannot bootstrap itself):
   - S3 bucket `eqcompanion-tf-state-dae027bf` — versioning **on**, Block Public
     Access all four flags, SSE-S3.
   - DynamoDB table `eqcompanion-tf-lock`, on-demand, partition key `LockID` (S).

Those names are hardcoded in the `backend "s3"` block in `versions.tf`. They are
physical names, not secrets: no account id appears anywhere in git.

> The lock table is the **last DynamoDB dependency in the tree** and it is
> Terraform's, not the product's. Terraform now deprecates `dynamodb_table` in
> favour of S3-native locking (`use_lockfile = true`), which would retire it —
> but that raises the required Terraform version and `.github/workflows/infra.yml`
> pins the CI toolchain, so it is a deliberate follow-up, not a drive-by.

## Deploy

```bash
export AWS_PROFILE=<profile>
cd infra

node build.mjs                     # BOTH zips FIRST — plan hashes them
terraform init                     # first run downloads providers + reads the backend
terraform plan  -var triage_principal_arn=arn:aws:iam::<acct>:user/<you>
terraform apply -var triage_principal_arn=arn:aws:iam::<acct>:user/<you>
```

`node build.mjs` now emits **two** bundles — `dist/submit.zip` and `dist/telemetry.zip` — and
both are hashed by the plan. A plan run without a build deploys nothing useful for either
function.

`alarm_email` defaults to `jmoyers+eqc@gmail.com`; override with
`-var alarm_email=...`. **Confirm the SNS subscription email after the first
apply** — until you click it, every alarm and budget alert goes nowhere.

Commit `.terraform.lock.hcl` (the provider checksum lock). Never commit
`*.tfstate`, `*.tfvars`, `tfplan` or `dist/`; `.gitignore` covers them.

After a successful apply:

1. `terraform output api_url` → paste into `FEEDBACK_API_URL` in
   `src/main/feedback/net.ts` and commit. It contains the API id, not the account
   id, and has to be in the client anyway.

2. **Step 2.5 — apply the schema. The stack does not work without this.**

   ```bash
   npx tsx scripts/triage-feedback.mts migrate --profile <profile>
   ```

   `terraform apply` creates an **empty** cluster: there is no `aws_dsql_*`
   resource that runs DDL, and DSQL's IAM-token auth means Terraform would have to
   mint a token and speak the postgres wire protocol to do it. So the schema is a
   reviewable SQL file (`infra/schema.sql`) applied by a reviewable command.

   `migrate` connects as `admin`, splits the file, and runs **one statement per
   transaction** (a DSQL law: a transaction may carry only one DDL statement and
   may not mix DDL with DML). It is idempotent — anything already present is
   reported as `exists`, not an error — so re-run it after any schema change and
   after any apply that replaced the cluster.

   Indexes are created with `CREATE INDEX ASYNC` (DDL cannot lock in a distributed
   database) and finish in the background; `migrate` says so when it is done.

3. The endpoint is seeded **closed**, on purpose. Open it once you have smoke
   tested: `npx tsx scripts/triage-feedback.mts closed off --profile <profile>`.

## Wave A2 — usage analytics: EXACTLY WHAT TO RUN, IN ORDER

Everything below is idempotent and safe to re-run. `<profile>` is the deploy profile;
`<acct>` is the account id (never committed).

```bash
export AWS_PROFILE=<profile>
cd infra

# 1. BOTH bundles, before the plan. The telemetry zip is new; without it the plan
#    would create the function with no code and the apply would fail.
node build.mjs

# 2. Plan and apply. New resources: the telemetry Lambda + its role/policy/log group,
#    the /v1/telemetry route + integration + permission, two alarms, one dashboard.
terraform plan  -var triage_principal_arn=arn:aws:iam::<acct>:user/<you>
terraform apply -var triage_principal_arn=arn:aws:iam::<acct>:user/<you>

# 3. THE STACK CACHE IS STALE. `terraform output` gained telemetry_lambda_role_arn,
#    and .triage/stack.json was written before it existed. Refresh it, or `migrate`
#    stops and tells you to (it refuses to send an unsubstituted ${...} to the cluster).
cd ..
npx tsx scripts/triage-feedback.mts migrate --profile <profile> --refresh

# 4. Smoke test with the switch still CLOSED — a 503 is the correct answer here and
#    proves the route, the function, the DSQL connection and the config read all work.
curl -si -X POST "$(cd infra && terraform output -raw telemetry_api_url)" \
  -H 'content-type: application/json' \
  -d '{"v":1,"env":{"analyticsId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","appVersion":"0.2.0","channel":"dev","platform":"win32","tzOffsetBucket":0},"events":[{"ts":1,"ev":{"t":"sessionHeartbeat","uptimeMs":1000}}]}'
# expect: HTTP/2 503  {"ok":false,"error":"closed",...}

# 5. Open it, re-run step 4 (expect 202 {"ok":true,"accepted":1}), then read it back.
npx tsx scripts/triage-feedback.mts analytics open   --profile <profile>
npx tsx scripts/triage-feedback.mts analytics digest --profile <profile> --days 7
```

Step 4 is worth doing **before** step 5: it separates "the plumbing is wrong" from "the switch
is off", which are the two failures that look identical from the client.

**The client stays dark.** `TELEMETRY_API_URL` in `src/main/telemetry/net.ts` is still `''`
and `tests/telemetryNet.test.mts` pins that it is. Filling it in is a separate, owner-approved
commit that must ALSO rewrite `SECURITY.md`'s "no telemetry of any kind" bullet, add the
retention rows for `usage_daily` / `usage_funnel_daily` / `analytics_install`, add the README
paragraph, and re-run `npm run gen:telemetry-doc` — the dark-build pins are designed to fail on
that change so the doc edit cannot be forgotten (`docs/plans/usage-analytics.md` A2).

### Day-2 for the telemetry route

| Situation | Command |
| --- | --- |
| Stop collecting NOW | `triage-feedback analytics close` (one statement; **no deploy**) |
| Start collecting | `triage-feedback analytics open` |
| Tighten the per-id daily event cap | `UPDATE feedback_config SET max_events_per_id_per_day = N` — deploy-free |
| A deletion request for an analyticsId | `triage-feedback analytics wipe --id <analyticsId>` |
| The numbers, as text | `triage-feedback analytics digest [--days N] [--json]` |
| The numbers, in the app | Triage → Analytics (dev builds only) |
| "Is anyone using it right now" | the `eqcompanion-telemetry` CloudWatch dashboard |
| Read the handler's logs | `aws logs tail "$(terraform output -raw telemetry_log_group)" --follow` |

`analytics wipe --id` deletes the `analytics_install` row, which is the id's entire footprint.
The counters it contributed to are anonymous sums — `usage_daily` holds "37 map opens on
2026-08-04" with no id in the table — so there is nothing in them to attribute, and subtracting
a guess would corrupt a true number to satisfy a request the data does not contain.

## Removing a column: the ordering, and what DSQL will not do

**THE BUNDLE GOES FIRST, THEN THE SCHEMA.** A running Lambda that still names a
column in its `INSERT` starts failing with `42703 undefined_column` the instant
that column disappears — every submit, immediately, with the endpoint open. So:

1. `npm run build` in `infra/`, `terraform apply` — the new bundle is live and its
   `INSERT` no longer names the column.
2. *Then* change the live schema.

Reversing the two turns a cleanup into an outage. Adding a column is the opposite
order (schema first, then the bundle that writes it), for the same reason.

**`title` and `contact` are the worked example, and step 2 is blocked.** Both left
the wire contract, then `schema.sql`, then every reader — so a stack migrated from
today's `schema.sql` never has them. A cluster migrated *before* that still does,
and **Aurora DSQL cannot drop a column**: its documented `ALTER TABLE` grammar has
no `DROP [COLUMN]` action at all (it has `DROP DEFAULT`, `DROP NOT NULL`,
`DROP EXPRESSION`, `DROP IDENTITY` and `DROP CONSTRAINT` — and not that one). See
<https://docs.aws.amazon.com/aurora-dsql/latest/userguide/alter-table-syntax-support.html>.
Putting the statement in `schema.sql` anyway would fail the whole `migrate` run on
a syntax error, so it is not there.

What *is* available is destroying the values, which is the point of the exercise:

```sql
UPDATE report SET title = NULL, contact = NULL
 WHERE title IS NOT NULL OR contact IS NOT NULL;
```

Run it once, as `admin`, against a cluster that predates the change — never as part
of `migrate`, because on a cluster built from today's `schema.sql` those column
names do not resolve. It is idempotent (the `WHERE` makes a re-run touch nothing)
and it is bounded by DSQL's **3,000-modified-rows-per-transaction** cap: if the
backlog is ever larger than that, run it in `report_id`-keyed batches. Afterwards
the columns are empty shells — no reader anywhere names them — and the physical
drop stays open until DSQL grows the grammar for it.

## Validate without touching the cloud

Exactly what CI runs. No credentials, no state, no lock:

```bash
cd infra
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
node build.mjs
```

Note what this does **not** cover: `schema.sql` is never executed by CI (there is
no cluster to execute it against), so a SQL typo surfaces at `migrate` time. That
is the same trade as every migration in every repo, and `migrate` stops on the
offending statement and prints it.

## Day-2 operations

| Situation | Command |
| --- | --- |
| Active flood — stop everything now | `triage-feedback closed on --message "..."` (one statement; **no deploy**) |
| One install spamming | `triage-feedback block <installId> --reason "..."` |
| Tighten the daily quota | `UPDATE feedback_config SET max_per_install_per_day = N` — deploy-free |
| Deletion request | `triage-feedback forget <reportId>` (the slice) / `wipe --install <id>` (everything) |
| Schema change | edit `schema.sql`, then `triage-feedback migrate` |
| Read the handler's logs | `aws logs tail "$(terraform output -raw lambda_log_group)" --follow` |
| Who hit us | `aws logs tail "$(terraform output -raw api_access_log_group)"` (source IPs, 14-day retention, incident-only) |

The kill switch and the quota live in the database precisely so that answering
abuse never requires a release. The app fetches no configuration at any point —
the kill switch rides in the submit response.

## Retention, and the one thing DSQL does not do

| Data | Retention | Mechanism |
| --- | --- | --- |
| Report row | indefinite — it *is* the backlog | none |
| `usage_daily` / `usage_funnel_daily` | indefinite | none — they are anonymous daily sums with no id in them, and the whole point of the aggregates-on-arrival design (plan T6) is that there is no per-user trail to expire |
| `analytics_install` | indefinite; deleted on request | `triage-feedback analytics wipe --id`. One row per analyticsId, and the only per-id row this feature has |
| Log object | 90 days | **S3 lifecycle — unchanged**; `triage-feedback forget <id>` deletes one on request |
| Quota counters (3 d), idempotency keys (7 d), dedupe probes (2 d) | lazy | swept by the ingest handler |
| Lambda / API access logs | 14 days | CloudWatch retention |

**DynamoDB had TTL. DSQL has nothing.** So the three counter tables are swept by
the ingest path itself (`infra/lambda/db.ts`), immediately after a submit clears
the quota gate: at most once per 10 minutes per warm container, at most 200 rows
per table per pass, and every failure logged and swallowed. The bound is not
politeness — DSQL caps a transaction at 3,000 modified rows, so an unbounded
`DELETE` would eventually *fail* rather than merely be slow.

The consequence, stated plainly: expired rows go away **as traffic flows**, not on
a clock. If ingest goes idle they linger. That costs a few kilobytes and leaks
nothing (an installId is an anonymous token, §9.3), and the alternative — an
EventBridge rule plus a second Lambda to delete six rows a week — is more moving
parts than the problem deserves.

## Teardown

`terraform destroy` **will fail**, twice over and on purpose: the bucket and the
cluster both carry `lifecycle { prevent_destroy = true }`, and the cluster also
has service-side `deletion_protection_enabled`. A teardown cannot take
user-submitted evidence and the whole backlog with it. Undoing both is the
deliberate act that makes a real teardown possible. Do it in a commit, not in a
panic.

## Cost shape

DSQL bills request-based DPU plus storage — nothing to provision, nothing to
autoscale, no capacity setting that turns a flood into a bill (the same property
`PAY_PER_REQUEST` bought before). The free tier is 100k DPU and 1 GB/month, which
is orders of magnitude past this product's volume. Around it: a 2 rps route
throttle, reserved concurrency 5, a 2 MB S3-enforced upload cap, 90-day object
expiry and 14-day log retention. An attacker saturating the route throttle for a
full month is roughly 5.2 M requests — about $5 of API Gateway plus bounded
Lambda/DSQL, under the $10 budget and alarmed within five minutes.

## Gotchas

- **Build before you plan.** `source_code_hash` reads `dist/submit.zip` and
  `dist/telemetry.zip`. Both are guarded by `fileexists()` so `terraform validate` works on a
  clean checkout, but a plan without a build deploys nothing useful.
- **A NEW OUTPUT MEANS A STALE `.triage/stack.json`.** The cache is read back without
  re-validating (it is a cache, not a contract), so a stack.json written before
  `telemetry_lambda_role_arn` existed simply has no value for it. `migrate` catches that on the
  SUBSTITUTED text — an unresolved `${...}` stops the run and says `--refresh` — because an
  `AWS IAM GRANT … TO '${…}'` reaching the cluster literally would map the role to nothing and
  fail much later, much more confusingly.
- **`ALTER TABLE … ADD COLUMN` is how the config row grew, and it is not spelled
  `IF NOT EXISTS`.** DSQL's supported ALTER grammar is a documented subset and that clause is
  not in it, so a self-guarding statement would risk failing the whole run on syntax. Instead
  the migrate runner treats `42701 duplicate_column` as "already there", exactly as it already
  treats `42P07` for a table. Adding a column is therefore idempotent; **removing** one is
  still impossible (see the section above).
- **The zip is byte-deterministic** (fixed 1980 timestamps). Rebuilding without a
  source change produces the same hash and therefore no redeploy. Do not "fix"
  that by stamping the current time.
- **`pg` is bundled pure-JS.** `build.mjs` replaces `pg-native` and
  `cloudflare:sockets` with a stub that throws if anything ever evaluates it.
  Nothing does; do not "fix" it by installing `pg-native`.
- **`bigint` comes back as a string.** Both readers set node-postgres's int8 type
  parser to `Number` once, at module scope. Every bigint in this schema is an
  epoch-millisecond or a byte count, so the conversion is exact — but a new
  `bigint` column that is a real 64-bit integer would need its own handling.
- **Retry is part of the contract.** DSQL takes no locks; a write that raced is
  aborted at commit with SQLSTATE `40001`. Every write in the handler and the CLI
  goes through a bounded, jittered retry. Code that talks to this database
  directly must do the same.
- **Alarm dimensions are not interchangeable.** DSQL's usage (DPU) metrics key on
  `ResourceId`; its observability metrics key on `ClusterId`. The wrong one gives
  an alarm that sits in `INSUFFICIENT_DATA` forever and never fires.
- **The stage is `$default`, not `v1`.** A named stage prefixes every path, so
  stage `v1` + route `/v1/feedback` would resolve at `/v1/v1/feedback`. The
  version lives in the path; `api.tf` explains it at length. `/v1/telemetry` rides the same
  stage, for the same reason.
- **EMF is a LOG LINE, not an API call.** The telemetry dashboard is fed by JSON documents the
  handler writes to stdout (`infra/lambda/emf.ts`); CloudWatch extracts the metrics from the log
  group. So a metric that never appears has a typo in `_aws`, not a permission problem — a
  malformed document is silently just a log line. Never put an analyticsId in a dimension: a
  dimension value mints a billed metric and would rebuild, in the metrics store, exactly the
  per-user trail the storage design refuses to keep.
- **`.triage/stack.json` is a cache.** After an apply that renames anything, run
  the triage CLI once with `--refresh` (or delete the file).

# infra/ — feedback ingest stack (Terraform)

The cloud half of the in-app feedback loop: one HTTP API route, one Lambda, one
**Aurora DSQL** cluster, one S3 bucket, and the guard rails that make a **publicly
writable** endpoint safe to leave running. Design + rationale live in
`docs/plans/feedback-triage.md` (§7–§10); this file is the runbook.

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
| `variables.tf` | region, name prefix, alarm email, triage principal, every spend knob |
| `api.tf` | HTTP API `eqcompanion-api`, `$default` stage, `POST /v1/feedback`, stage + route throttles, access logging |
| `lambda.tf` | `eqcompanion-feedback-submit` (Node 22, arm64, 256 MB, 10 s), reserved concurrency 5, its log group at 14-day retention |
| `dsql.tf` | the Aurora DSQL cluster (deletion protection + `prevent_destroy`) and the endpoint/ingest-role locals |
| `schema.sql` | the tables, indexes, config seed and ingest **database role** — applied by the CLI, not by Terraform (see step 2.5) |
| `s3.tf` | `eqcompanion-logs-<random hex>` + all four Block-Public-Access flags + SSE-S3 + versioning off + 90-day lifecycle + `prevent_destroy` |
| `iam.tf` | the ingest role (`dsql:DbConnect` only) and `EqCompanionFeedbackTriageRole` (`dsql:DbConnectAdmin`) |
| `alarms.tf` | `EqCompanionOpsAlerts` SNS topic + email sub + 6 alarms + a $10 monthly budget |
| `outputs.tf` | `api_url`, `cluster_endpoint`, `bucket_name`, `triage_role_arn`, `lambda_role_arn`, log group names |
| `build.mjs` | esbuild bundle of `lambda/submit.ts` → a **deterministic** `dist/submit.zip` |

The handler imports `validateSubmit` from `src/shared/feedback.ts`, so the server
runs the same validator as the dialog and the main process. `build.mjs` is what
makes that import survive into a Lambda zip, and CI runs it on every change to
either side so the two cannot drift apart silently.

## There is no database password

Aurora DSQL authenticates with a short-lived IAM token that `@aws-sdk/dsql-signer`
derives **locally** (SigV4 over the cluster hostname — no network call) from
whatever credentials the caller already holds. Nothing is stored in Secrets
Manager or SSM, nothing rotates, and there is no credential to leak.

Two identities, and the difference matters:

| Who | IAM action | Database role | Can do |
| --- | --- | --- | --- |
| the Lambda | `dsql:DbConnect` | `feedback_ingest` | `INSERT` on `report`; read config/profile; read+write+delete the three counter tables |
| the triage CLI | `dsql:DbConnectAdmin` | `admin` | everything — it applies the schema and it is the deletion path for `forget`/`wipe` |

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

node build.mjs                     # produce dist/submit.zip FIRST — plan hashes it
terraform init                     # first run downloads providers + reads the backend
terraform plan  -var triage_principal_arn=arn:aws:iam::<acct>:user/<you>
terraform apply -var triage_principal_arn=arn:aws:iam::<acct>:user/<you>
```

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
| Deletion request | `triage-feedback forget <reportId>` / `wipe --install <id>` |
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
| `contact` field | until `triage-feedback forget <id>` | manual, one command |
| Log object | 90 days | **S3 lifecycle — unchanged** |
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

- **Build before you plan.** `source_code_hash` reads `dist/submit.zip`. It is
  guarded by `fileexists()` so `terraform validate` works on a clean checkout, but
  a plan without a build deploys nothing useful.
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
  version lives in the path; `api.tf` explains it at length.
- **`.triage/stack.json` is a cache.** After an apply that renames anything, run
  the triage CLI once with `--refresh` (or delete the file).

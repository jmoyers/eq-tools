# infra/ — feedback ingest stack (Terraform)

The cloud half of the in-app feedback loop: one HTTP API route, one Lambda, one
DynamoDB table, one S3 bucket, and the guard rails that make a **publicly
writable** endpoint safe to leave running. Design + rationale live in
`docs/plans/feedback-triage.md` (§7–§10); this file is the runbook.

- **IaC: Terraform (HCL)** — owner decision, 2026-08-03. Not CDK.
- **Region: us-east-1**, in a **dedicated AWS sub-account** (AWS Organizations).
- **CI validates. CI never plans and never applies.** There are no cloud
  credentials and no OIDC deploy role in a public repo; deploying is a manual act
  from the dev machine. See `.github/workflows/infra.yml`.

## What gets created

| File | Resources |
| --- | --- |
| `versions.tf` | provider pins + the `backend "s3"` block + default tags |
| `variables.tf` | region, name prefix, alarm email, triage principal, every spend knob |
| `api.tf` | HTTP API `eqcompanion-api`, `$default` stage, `POST /v1/feedback`, stage + route throttles, access logging |
| `lambda.tf` | `eqcompanion-feedback-submit` (Node 22, arm64, 256 MB, 10 s), reserved concurrency 5, its log group at 14-day retention |
| `dynamo.tf` | `EqCompanionFeedback` (on-demand, TTL, 2 GSIs, PITR, `prevent_destroy`) |
| `s3.tf` | `eqcompanion-logs-<random hex>` + all four Block-Public-Access flags + SSE-S3 + versioning off + 90-day lifecycle + `prevent_destroy` |
| `iam.tf` | the ingest role (create + count only) and `EqCompanionFeedbackTriageRole` |
| `alarms.tf` | `EqCompanionOpsAlerts` SNS topic + email sub + 6 alarms + a $10 monthly budget |
| `outputs.tf` | `api_url`, `table_name`, `bucket_name`, `triage_role_arn`, log group names |
| `build.mjs` | esbuild bundle of `lambda/submit.ts` → a **deterministic** `dist/submit.zip` |

The handler imports `validateSubmit` from `src/shared/feedback.ts`, so the server
runs the same validator as the dialog and the main process. `build.mjs` is what
makes that import survive into a Lambda zip, and CI runs it on every change to
either side so the two cannot drift apart silently.

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
`*.tfstate`, `*.tfvars`, or `dist/`; `.gitignore` covers all of them.

After a successful apply:

1. `terraform output api_url` → paste into `FEEDBACK_API_URL` in
   `src/main/feedback/net.ts` and commit. It contains the API id, not the account
   id, and has to be in the client anyway.
2. Seed the config item so the endpoint starts accepting:
   `npx tsx scripts/triage-feedback.mts closed off --message "..."`.

## Validate without touching the cloud

Exactly what CI runs. No credentials, no state, no lock:

```bash
cd infra
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
node build.mjs
```

## Day-2 operations

| Situation | Command |
| --- | --- |
| Active flood — stop everything now | `triage-feedback closed on --message "..."` (one UpdateItem; **no deploy**) |
| One install spamming | `triage-feedback block <installId> --reason "..."` |
| Tighten the daily quota | edit `maxPerInstallPerDay` on the `CONFIG/FEEDBACK` item — deploy-free |
| Deletion request | `triage-feedback forget <reportId>` / `wipe --install <id>` |
| Read the handler's logs | `aws logs tail "$(terraform output -raw lambda_log_group)" --follow` |
| Who hit us | `aws logs tail "$(terraform output -raw api_access_log_group)"` (source IPs, 14-day retention, incident-only) |

The kill switch and the quota live in DynamoDB precisely so that answering abuse
never requires a release. The app fetches no configuration at any point — the
kill switch rides in the submit response.

## Teardown

`terraform destroy` **will fail**, on purpose: both the bucket and the table carry
`lifecycle { prevent_destroy = true }` so a teardown cannot take user-submitted
evidence and the whole backlog with it. Removing those blocks is the deliberate
act that makes a real teardown possible. Do it in a commit, not in a panic.

## Cost shape

On-demand DynamoDB, a 2 rps route throttle, reserved concurrency 5, a 2 MB
S3-enforced upload cap, 90-day object expiry and 14-day log retention. An attacker
saturating the route throttle for a full month is roughly 5.2 M requests — about
$5 of API Gateway plus bounded Lambda/DynamoDB, under the $10 budget and alarmed
within five minutes.

## Gotchas

- **Build before you plan.** `source_code_hash` reads `dist/submit.zip`. It is
  guarded by `fileexists()` so `terraform validate` works on a clean checkout, but
  a plan without a build deploys nothing useful.
- **The zip is byte-deterministic** (fixed 1980 timestamps). Rebuilding without a
  source change produces the same hash and therefore no redeploy. Do not "fix"
  that by stamping the current time.
- **The stage is `$default`, not `v1`.** A named stage prefixes every path, so
  stage `v1` + route `/v1/feedback` would resolve at `/v1/v1/feedback`. The
  version lives in the path; `api.tf` explains it at length.
- **`.triage/stack.json` is a cache.** After an apply that renames anything, run
  the triage CLI once with `--refresh` (or delete the file).

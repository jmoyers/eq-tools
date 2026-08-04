# -----------------------------------------------------------------------------
# The ONE Lambda (§8.2). POST /v1/feedback is the entire public surface: no
# presign route, no list route, no config route, no S3 event handler.
#
# The bundle is produced by `node infra/build.mjs` (esbuild → dist/submit.mjs →
# a DETERMINISTIC dist/submit.zip), which is how the handler can import
# validateSubmit from src/shared/feedback.ts — one validator, client and server.
# Run the build before any plan/apply; CI runs it too, purely to prove it bundles.
#
# reserved_concurrent_executions is the hard blast-radius cap. It bounds spend
# even if a route throttle is misconfigured, and — because it is a RESERVATION,
# not a limit — it also means this function can never starve a future one.
#
# THE 10s TIMEOUT AND THE DSQL CONNECTION. A cold invoke now has to mint an IAM
# auth token and open a TLS postgres connection before it can do any work. The
# token is signed LOCALLY (SigV4 over the cluster hostname — no network call),
# and the connection is opened lazily and then CACHED on the module scope, so
# only the first request in a container pays for it and warm requests pay
# nothing. 10s stays comfortable; the handler's own connect/statement timeouts
# (infra/lambda/db.ts) fire well inside it so a stuck connect returns a clean
# 500 instead of an API Gateway timeout.
# -----------------------------------------------------------------------------

locals {
  lambda_name   = "${var.name_prefix}-feedback-submit"
  lambda_bundle = "${path.module}/dist/submit.zip"

  telemetry_lambda_name   = "${var.name_prefix}-telemetry-ingest"
  telemetry_lambda_bundle = "${path.module}/dist/telemetry.zip"
}

# Declared here (not left to the service) so the 14-day retention is OURS. A
# service-created group defaults to "never expire", which is the quiet cost line
# in every "serverless is free" architecture.
resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.lambda_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "submit" {
  function_name = local.lambda_name
  role          = aws_iam_role.lambda.arn
  runtime       = "nodejs22.x"
  handler       = "submit.handler"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = 10
  filename      = local.lambda_bundle

  # Guarded: `terraform validate` runs in CI against a checkout that has not
  # necessarily built the bundle yet. A missing zip must fail at plan/apply
  # (where it means "you forgot to build"), never at validate.
  source_code_hash = fileexists(local.lambda_bundle) ? filebase64sha256(local.lambda_bundle) : null

  reserved_concurrent_executions = var.lambda_reserved_concurrency

  # DSQL_ENDPOINT + DSQL_USER are all the handler needs to authenticate: the
  # password is an IAM token it mints itself with @aws-sdk/dsql-signer on every
  # cold connect. THERE IS NO SECRET HERE — no Secrets Manager entry, no SSM
  # parameter, nothing to rotate and nothing to leak in a console screenshot.
  environment {
    variables = {
      DSQL_ENDPOINT = local.dsql_endpoint
      DSQL_USER     = local.dsql_ingest_role
      BUCKET_NAME   = aws_s3_bucket.logs.bucket
      MAX_PER_DAY   = tostring(var.default_max_reports_per_day)
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy.lambda,
  ]
}

# -----------------------------------------------------------------------------
# The SECOND Lambda: POST /v1/telemetry (docs/plans/usage-analytics.md A2).
#
# WHY A SECOND FUNCTION AND NOT A SECOND ROUTE ON THE FIRST. Everything that
# makes the feedback path safe is per-IDENTITY: an IAM role with exactly two
# statements, and a DATABASE role whose GRANT list is the real answer to "what
# can a compromised public endpoint do". One function serving both routes would
# hold the union of both — `INSERT ON report` plus an S3 presign permission for
# the counter path, and UPSERT on the counters for the feedback path — and the
# GRANT list would stop being readable as a promise. The cost of the split is one
# more 3 MB zip and one more log group; the benefit is that "telemetry ingest
# cannot read or write the backlog" is enforced rather than asserted.
#
# It also gets its own alarms and its own concurrency: a telemetry flood cannot
# throttle feedback submissions, which are the ones a human is waiting on.
#
# NO S3, NO PRESIGN, NO BUCKET ENV. This function's entire world is DSQL.
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "telemetry" {
  name              = "/aws/lambda/${local.telemetry_lambda_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "telemetry" {
  function_name = local.telemetry_lambda_name
  role          = aws_iam_role.telemetry.arn
  runtime       = "nodejs22.x"
  handler       = "telemetry.handler"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = 10
  filename      = local.telemetry_lambda_bundle

  # Same guard as the submit bundle: a missing zip must fail at plan/apply (where
  # it means "you forgot `node build.mjs`"), never at CI's `terraform validate`.
  source_code_hash = fileexists(local.telemetry_lambda_bundle) ? filebase64sha256(local.telemetry_lambda_bundle) : null

  reserved_concurrent_executions = var.telemetry_reserved_concurrency

  # DSQL_USER is the whole difference in privilege: this function logs in as
  # `telemetry_ingest`, whose GRANTs are counters and its own install row.
  # MAX_EVENTS_PER_DAY is only the cold-start fallback — the live control is the
  # `max_events_per_id_per_day` column, changeable without a deploy.
  environment {
    variables = {
      DSQL_ENDPOINT      = local.dsql_endpoint
      DSQL_USER          = local.dsql_telemetry_role
      DSQL_APPLICATION   = "eqc-telemetry-ingest"
      MAX_EVENTS_PER_DAY = tostring(var.default_max_events_per_id_per_day)
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.telemetry,
    aws_iam_role_policy.telemetry,
  ]
}

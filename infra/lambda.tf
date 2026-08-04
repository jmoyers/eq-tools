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
# -----------------------------------------------------------------------------

locals {
  lambda_name   = "${var.name_prefix}-feedback-submit"
  lambda_bundle = "${path.module}/dist/submit.zip"
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

  environment {
    variables = {
      TABLE_NAME  = aws_dynamodb_table.feedback.name
      BUCKET_NAME = aws_s3_bucket.logs.bucket
      MAX_PER_DAY = tostring(var.default_max_reports_per_day)
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy.lambda,
  ]
}

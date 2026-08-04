# -----------------------------------------------------------------------------
# IAM — two roles, both spelled out action by action (§8.5, §10.1).
#
# THE INGEST ROLE CAN CREATE AND COUNT. IT CANNOT READ THE BACKLOG OR DELETE A
# REPORT. Under DynamoDB that sentence was enforced HERE, by omitting Query,
# Scan and DeleteItem. Aurora DSQL has exactly one IAM action for data access —
# "may this principal open a connection" — so the property moves DOWN a layer:
#
#   * this role gets `dsql:DbConnect`, NOT `dsql:DbConnectAdmin`, so it can only
#     log in as a NAMED DATABASE ROLE that an admin has mapped to it;
#   * `infra/schema.sql` creates that role (`feedback_ingest`), maps it with
#     `AWS IAM GRANT`, and grants it INSERT on `report` and nothing else — no
#     SELECT, no UPDATE, no DELETE on the backlog.
#
# So the guarantee is intact and the check moved from "read the actions list" to
# "read the GRANT list". `dsql:DbConnectAdmin` on this role would have silently
# handed the public write endpoint superuser on the whole corpus; it is the one
# thing this file must never do.
#
# A presign still cannot grant what the signer lacks, so the 2 MB / one-key /
# 5-minute upload policy remains the ceiling of what a compromised handler could
# do to the bucket.
#
# The TRIAGE role is the dev machine's read/write path and DOES connect as
# `admin`: it runs the schema migration (CREATE TABLE / CREATE ROLE / GRANT) and
# it is the deletion path for `forget` and `wipe`. It exists so the triage CLI
# runs under a named role instead of raw account admin, and so the same script
# works unchanged from a second machine.
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "lambda_inline" {
  # One action, one cluster. Everything the handler may actually DO to the data
  # is a GRANT on the `feedback_ingest` database role (schema.sql).
  statement {
    sid       = "FeedbackDsqlConnectAsIngestRole"
    effect    = "Allow"
    actions   = ["dsql:DbConnect"]
    resources = [aws_dsql_cluster.feedback.arn]
  }

  # Only enough to SIGN the presigned POST. The handler never uploads anything
  # itself and can never read back what a client uploaded.
  statement {
    sid       = "PresignLogUploads"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.logs.arn}/logs/*"]
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${var.name_prefix}-feedback-submit-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "lambda" {
  name   = "feedback-submit"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_inline.json
}

# CloudWatch Logs write access only. The log group itself (and its 14-day
# retention) is declared in lambda.tf so Terraform owns the retention instead of
# letting the service create an infinite-retention group on first invoke.
resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# ---- telemetry ingest role --------------------------------------------------
#
# ONE STATEMENT. Read it beside the feedback role above and the difference IS the
# design: no `s3:PutObject`, because this path has no upload leg and never mints
# a presign. `dsql:DbConnect` (never `...Admin`) lets it log in only as the named
# database role `telemetry_ingest`, whose GRANTs are at the bottom of schema.sql:
# SELECT on the config row, UPSERT on the three counter tables, and nothing else.
# It cannot read the backlog, cannot write a report, and holds no DELETE anywhere.

data "aws_iam_policy_document" "telemetry_inline" {
  statement {
    sid       = "TelemetryDsqlConnectAsIngestRole"
    effect    = "Allow"
    actions   = ["dsql:DbConnect"]
    resources = [aws_dsql_cluster.feedback.arn]
  }
}

resource "aws_iam_role" "telemetry" {
  name = "${var.name_prefix}-telemetry-ingest-role"
  # The same trust policy document as the submit role: both are Lambda functions,
  # and the document says only "lambda.amazonaws.com may assume this".
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "telemetry" {
  name   = "telemetry-ingest"
  role   = aws_iam_role.telemetry.id
  policy = data.aws_iam_policy_document.telemetry_inline.json
}

resource "aws_iam_role_policy_attachment" "telemetry_basic" {
  role       = aws_iam_role.telemetry.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# ---- triage role ------------------------------------------------------------

data "aws_iam_policy_document" "triage_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = [var.triage_principal_arn]
    }
  }
}

data "aws_iam_policy_document" "triage_inline" {
  # `DbConnectAdmin` = log in as the built-in `admin` database role. This is the
  # operator identity: it applies the schema (`triage-feedback migrate`), reads
  # the backlog, and performs deletions. It is deliberately the SAME privilege
  # level the triage role held before (Query + Scan + BatchWrite + DeleteItem on
  # the whole table) — nothing widened, it is just spelled with one action now.
  statement {
    sid       = "TriageDsqlAdmin"
    effect    = "Allow"
    actions   = ["dsql:DbConnectAdmin"]
    resources = [aws_dsql_cluster.feedback.arn]
  }

  # DeleteObject is what makes `forget` / `wipe` real rather than a promise.
  statement {
    sid    = "TriageLogObjects"
    effect = "Allow"

    actions = [
      "s3:DeleteObject",
      "s3:GetObject",
    ]

    resources = ["${aws_s3_bucket.logs.arn}/logs/*"]
  }

  statement {
    sid       = "TriageListLogPrefix"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.logs.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["logs/*"]
    }
  }
}

resource "aws_iam_role" "triage" {
  name               = "EqCompanionFeedbackTriageRole"
  assume_role_policy = data.aws_iam_policy_document.triage_assume.json
}

resource "aws_iam_role_policy" "triage" {
  name   = "feedback-triage"
  role   = aws_iam_role.triage.id
  policy = data.aws_iam_policy_document.triage_inline.json
}

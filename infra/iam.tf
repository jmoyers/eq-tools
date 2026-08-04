# -----------------------------------------------------------------------------
# IAM — two roles, both spelled out action by action (§8.5, §10.1).
#
# THE INGEST ROLE CAN CREATE AND COUNT. IT CANNOT READ THE CORPUS OR DELETE
# ANYTHING. Notably absent: dynamodb:Query, dynamodb:Scan, dynamodb:DeleteItem,
# s3:GetObject, s3:DeleteObject, s3:ListBucket. A presign cannot grant what the
# signer lacks, so the 2 MB / one-key / 5-minute upload policy is the ceiling of
# what a compromised handler could do to the bucket.
#
# The TRIAGE role is the dev machine's read/write path. It exists so the triage
# CLI runs under a named, least-privilege role instead of raw account admin, and
# so the same script works unchanged from a second machine.
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
  # Config + install profile + idempotency reads, the quota counter, and the
  # report/idempotency transaction. TransactWriteItems is authorised by the
  # PutItem/UpdateItem/ConditionCheckItem actions it performs.
  statement {
    sid    = "FeedbackTableIngest"
    effect = "Allow"

    actions = [
      "dynamodb:BatchGetItem",
      "dynamodb:ConditionCheckItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]

    resources = [aws_dynamodb_table.feedback.arn]
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
  # Query covers every `list`/`digest`/`cluster` path (GSI + ULID range). Scan is
  # here only for the CLI's `--scan` escape hatch, which prints a loud warning.
  statement {
    sid    = "TriageTable"
    effect = "Allow"

    actions = [
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:UpdateItem",
    ]

    resources = [
      aws_dynamodb_table.feedback.arn,
      "${aws_dynamodb_table.feedback.arn}/index/*",
    ]
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

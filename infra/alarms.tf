# -----------------------------------------------------------------------------
# Ops: one SNS topic, one email subscription, six alarms, one budget (§9.2).
#
# The point of the alarms is TIME TO KNOWLEDGE. A budget alone tells you about a
# flood at the end of the month; a 5-minute request-count alarm tells you while
# it is happening, which is when the kill switch is still useful.
#
# The email subscription needs ONE manual confirmation click after the first
# apply. Terraform shows it as `pending confirmation` until then, and an
# unconfirmed subscription delivers nothing — check it before trusting the alarms.
# -----------------------------------------------------------------------------

data "aws_caller_identity" "current" {}

resource "aws_sns_topic" "ops" {
  name = "EqCompanionOpsAlerts"
}

data "aws_iam_policy_document" "ops_topic" {
  # AWS Budgets publishes from a SERVICE principal and is therefore denied by the
  # default topic policy. This statement is what makes the budget alerts arrive.
  statement {
    sid     = "AllowBudgetsPublish"
    effect  = "Allow"
    actions = ["SNS:Publish"]

    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }

    resources = [aws_sns_topic.ops.arn]
  }

  statement {
    sid     = "AllowCloudWatchAlarmsPublish"
    effect  = "Allow"
    actions = ["SNS:Publish"]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    resources = [aws_sns_topic.ops.arn]
  }

  # Setting ANY topic policy replaces the default one, which is what grants the
  # account owner management of the topic. Restate it, or a future subscribe from
  # the console starts failing for no visible reason.
  statement {
    sid    = "AllowOwnerManagement"
    effect = "Allow"

    actions = [
      "SNS:AddPermission",
      "SNS:DeleteTopic",
      "SNS:GetTopicAttributes",
      "SNS:ListSubscriptionsByTopic",
      "SNS:Publish",
      "SNS:RemovePermission",
      "SNS:SetTopicAttributes",
      "SNS:Subscribe",
    ]

    principals {
      type        = "AWS"
      identifiers = [data.aws_caller_identity.current.account_id]
    }

    resources = [aws_sns_topic.ops.arn]
  }
}

resource "aws_sns_topic_policy" "ops" {
  arn    = aws_sns_topic.ops.arn
  policy = data.aws_iam_policy_document.ops_topic.json
}

resource "aws_sns_topic_subscription" "ops_email" {
  topic_arn = aws_sns_topic.ops.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# ---- alarms -----------------------------------------------------------------

# A flood is visible in minutes, not at month end. 5,000 requests in 5 minutes is
# ~16 rps sustained — three times the stage ceiling, so this can only fire on a
# genuine anomaly (or a throttle that was widened without thinking).
resource "aws_cloudwatch_metric_alarm" "api_flood" {
  alarm_name          = "${var.name_prefix}-api-request-flood"
  alarm_description   = "API Gateway request count over 5,000 in 5 minutes."
  namespace           = "AWS/ApiGateway"
  metric_name         = "Count"
  dimensions          = { ApiId = aws_apigatewayv2_api.main.id }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${var.name_prefix}-api-5xx"
  alarm_description   = "API Gateway 5xx responses over 10 in 5 minutes."
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  dimensions          = { ApiId = aws_apigatewayv2_api.main.id }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name          = "${var.name_prefix}-feedback-lambda-errors"
  alarm_description   = "Submit handler errors over 10 in 5 minutes."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.submit.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
}

# Throttles mean the reserved-concurrency cap is doing its job — which is exactly
# when a human should look, so the threshold is zero.
resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  alarm_name          = "${var.name_prefix}-feedback-lambda-throttles"
  alarm_description   = "Submit handler hit its reserved concurrency cap."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = aws_lambda_function.submit.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
}

# ---- the database ------------------------------------------------------------
#
# These two replace the DynamoDB read/write throttle alarms. There is no
# "throttling" to watch on DSQL — it does not provision capacity — so the two
# things worth knowing about are SPEND and CONTENTION.
#
# MIND THE DIMENSION. Aurora DSQL splits its metrics across two dimension names
# in the SAME namespace: the *usage* (DPU) metrics key on `ResourceId`, the
# *observability* metrics key on `ClusterId`. Getting that wrong produces an
# alarm that is permanently INSUFFICIENT_DATA and therefore never fires — the
# exact failure mode the plan's `ThrottledRequests` alarm had. Both names below
# are taken from the published metric tables, not guessed.

# DPU is the billing unit and the free tier is 100k/month (~12 DPU per 5-minute
# period averaged over a month). A sustained 200 is unambiguous: either the route
# throttle was widened or something is wrong.
resource "aws_cloudwatch_metric_alarm" "dsql_dpu" {
  alarm_name          = "${var.name_prefix}-feedback-dsql-dpu"
  alarm_description   = "Aurora DSQL total DPU consumption over the 5-minute budget."
  namespace           = "AWS/AuroraDSQL"
  metric_name         = "TotalDPU"
  dimensions          = { ResourceId = aws_dsql_cluster.feedback.identifier }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.dsql_dpu_alarm_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
}

# DSQL is optimistic: a write conflict is a commit-time abort the caller retries.
# The handler retries a bounded number of times, so a HANDFUL of these is the
# system working. A storm means many installs are colliding on one row, which at
# this product's volume can only mean a bug or an attack — the threshold is set
# well above normal noise so it says something when it speaks.
resource "aws_cloudwatch_metric_alarm" "dsql_occ_conflicts" {
  alarm_name          = "${var.name_prefix}-feedback-dsql-occ-conflicts"
  alarm_description   = "Aurora DSQL optimistic-concurrency aborts over 50 in 5 minutes."
  namespace           = "AWS/AuroraDSQL"
  metric_name         = "OccConflicts"
  dimensions          = { ClusterId = aws_dsql_cluster.feedback.identifier }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 50
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
}

# ---- budget -----------------------------------------------------------------

resource "aws_budgets_budget" "monthly" {
  name         = "${var.name_prefix}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 50
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.ops.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 80
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.ops.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.ops.arn]
  }
}

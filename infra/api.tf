# -----------------------------------------------------------------------------
# API Gateway HTTP API — one route, auth NONE, throttled twice (§8.1, §9.1).
#
# STAGE CHOICE, and a deliberate deviation from the plan's naming table. The plan
# says "stage v1" AND "route POST /v1/feedback" AND an api_url of
# `https://<id>.execute-api.<region>.amazonaws.com/v1/feedback`. Those three
# cannot all be true: a NAMED stage prefixes every path, so stage `v1` + route
# `/v1/feedback` resolves at `/v1/v1/feedback`. We keep the VERSION IN THE PATH
# (which is what "versioned from day one" means, and what lets a future web route
# join this API under its own version) and use the $default stage, so the
# committed FEEDBACK_API_URL is exactly the URL the plan writes down.
#
# NO CORS BLOCK. Every caller is the Electron main process — a non-browser client
# that sends no Origin and asks for no preflight. Adding CORS would only make the
# endpoint reachable from web pages, which is strictly more attack surface for a
# capability nothing needs.
# -----------------------------------------------------------------------------

locals {
  feedback_route_path = "/v1/feedback"

  # The second public route (docs/plans/usage-analytics.md T5: "same API, same
  # Lambda family, same kill-switch/caps philosophy"). Same $default stage, so
  # the version stays in the path here too.
  telemetry_route_path = "/v1/telemetry"
}

resource "aws_apigatewayv2_api" "main" {
  name          = "${var.name_prefix}-api"
  protocol_type = "HTTP"
  description   = "EQ Legends Companion public API. Today: feedback ingest only."
}

# Access logs carry the SOURCE IP, deliberately, as incident-only evidence: if
# there is ever a real flood the record exists for two weeks and then evaporates.
# It is never joined to a report row (§9.7).
resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/aws/apigateway/${var.name_prefix}-api"
  retention_in_days = var.log_retention_days
}

resource "aws_apigatewayv2_integration" "submit" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.submit.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
  timeout_milliseconds   = 15000
}

resource "aws_apigatewayv2_route" "submit" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST ${local.feedback_route_path}"
  target    = "integrations/${aws_apigatewayv2_integration.submit.id}"
}

resource "aws_apigatewayv2_integration" "telemetry" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.telemetry.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
  timeout_milliseconds   = 15000
}

resource "aws_apigatewayv2_route" "telemetry" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST ${local.telemetry_route_path}"
  target    = "integrations/${aws_apigatewayv2_integration.telemetry.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  # Product-wide ceiling: every route on this API, now and later.
  default_route_settings {
    throttling_rate_limit  = var.api_rate_limit
    throttling_burst_limit = var.api_burst_limit
  }

  # And a tighter one for the public-write route specifically.
  route_settings {
    route_key              = aws_apigatewayv2_route.submit.route_key
    throttling_rate_limit  = var.route_rate_limit
    throttling_burst_limit = var.route_burst_limit
  }

  # Telemetry gets its OWN budget, deliberately a little wider than feedback's: a
  # client flushes on a 60s timer and every install in the field is a caller,
  # where a feedback submit is a human pressing a button. It is still a per-route
  # ceiling, so a telemetry flood cannot consume feedback's share of the stage.
  route_settings {
    route_key              = aws_apigatewayv2_route.telemetry.route_key
    throttling_rate_limit  = var.telemetry_route_rate_limit
    throttling_burst_limit = var.telemetry_route_burst_limit
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn

    format = jsonencode({
      requestId               = "$context.requestId"
      ip                      = "$context.identity.sourceIp"
      requestTime             = "$context.requestTime"
      httpMethod              = "$context.httpMethod"
      routeKey                = "$context.routeKey"
      status                  = "$context.status"
      protocol                = "$context.protocol"
      responseLength          = "$context.responseLength"
      integrationStatus       = "$context.integrationStatus"
      integrationErrorMessage = "$context.integrationErrorMessage"
    })
  }
}

resource "aws_lambda_permission" "api" {
  statement_id  = "AllowInvokeFromHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.submit.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "api_telemetry" {
  statement_id  = "AllowInvokeFromHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.telemetry.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

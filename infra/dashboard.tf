# -----------------------------------------------------------------------------
# The CloudWatch dashboard — surface 2 of the four in docs/plans/usage-analytics.md §1:
# "active sessions now, events/min, ingest 4xx/5xx, per-funnel-step counters
# today. The 'is anyone using it right now' glance."
#
# WHY A DASHBOARD AND NOT JUST THE TRIAGE TAB. The triage panel reads DSQL, and
# DSQL holds DAILY aggregates — it can tell you what yesterday looked like and it
# can tell you today's running totals, but it cannot tell you what is happening
# in the last five minutes, because nothing writes a five-minute row. The EMF
# documents the handler emits (infra/lambda/emf.ts) are exactly that missing
# resolution, and this is where they are read.
#
# EVERY WIDGET READS METRICS THE HANDLER ACTUALLY EMITS. `EQCompanion/Telemetry`
# is `EMF_NAMESPACE`; the metric names are the ones in `emitMetrics`. A widget
# naming a metric nothing publishes renders as an empty chart with no error,
# which is the failure mode to watch for when editing this file.
#
# NO ANALYTICS ID IS A DIMENSION ANYWHERE, here or in the emitter. A dimension
# value mints a billed metric and would rebuild — in the metrics store — the
# per-user trail T6 exists to not keep.
# -----------------------------------------------------------------------------

locals {
  dashboard_region = var.region

  # `SessionsStarted` is a count of launches; the live-presence signal is
  # HEARTBEATS, one per running session per 5 minutes, which is why the "right
  # now" widget is built on it rather than on session starts.
  telemetry_pulse_widget = {
    type   = "metric"
    x      = 0
    y      = 0
    width  = 12
    height = 6

    properties = {
      title  = "Telemetry pulse — events/min and live sessions"
      region = local.dashboard_region
      view   = "timeSeries"
      stat   = "Sum"
      period = 60

      metrics = [
        ["EQCompanion/Telemetry", "EventsAccepted", "Channel", "prod"],
        [".", ".", ".", "dev"],
        [".", "Heartbeats", ".", "prod"],
        [".", "Heartbeats", ".", "dev"],
        [".", "ActiveInstalls", ".", "prod"],
      ]
    }
  }

  telemetry_health_widget = {
    type   = "metric"
    x      = 12
    y      = 0
    width  = 12
    height = 6

    properties = {
      title  = "Ingest health — refusals, errors, duration"
      region = local.dashboard_region
      view   = "timeSeries"
      stat   = "Sum"
      period = 300

      metrics = [
        # The handler's own refusal counters: a closed kill switch and a spent cap
        # are VISIBLE here rather than looking like silence.
        ["EQCompanion/Telemetry", "Rejected", "Reason", "closed"],
        [".", ".", ".", "quota_exceeded"],
        [".", ".", ".", "invalid_event"],
        [".", ".", ".", "too_large"],
        [".", ".", ".", "internal"],
        ["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.telemetry.function_name],
        [".", "Throttles", ".", "."],
      ]
    }
  }

  telemetry_funnel_widget = {
    type   = "metric"
    x      = 0
    y      = 6
    width  = 24
    height = 6

    properties = {
      title   = "Funnel steps today (per step, all versions)"
      region  = local.dashboard_region
      view    = "timeSeries"
      stacked = false
      stat    = "Sum"
      period  = 3600

      # SEARCH rather than a fixed list: the step enums grow by schema PR
      # (src/shared/telemetry.ts TELEMETRY_FUNNEL_STEPS), and a hand-listed widget
      # would silently omit every step added after this file was written.
      metrics = [
        [{ expression = "SEARCH('{EQCompanion/Telemetry,Funnel,Step,Outcome} MetricName=\"FunnelStep\"', 'Sum', 3600)", id = "funnel" }],
      ]
    }
  }

  api_widget = {
    type   = "metric"
    x      = 0
    y      = 12
    width  = 24
    height = 6

    properties = {
      title  = "API — requests and 4xx/5xx across both routes"
      region = local.dashboard_region
      view   = "timeSeries"
      stat   = "Sum"
      period = 300

      metrics = [
        ["AWS/ApiGateway", "Count", "ApiId", aws_apigatewayv2_api.main.id],
        [".", "4xx", ".", "."],
        [".", "5xx", ".", "."],
      ]
    }
  }
}

resource "aws_cloudwatch_dashboard" "telemetry" {
  dashboard_name = "${var.name_prefix}-telemetry"

  dashboard_body = jsonencode({
    widgets = [
      local.telemetry_pulse_widget,
      local.telemetry_health_widget,
      local.telemetry_funnel_widget,
      local.api_widget,
    ]
  })
}

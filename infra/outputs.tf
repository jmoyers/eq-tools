# -----------------------------------------------------------------------------
# Outputs — the ONLY place physical names are published.
#
# Nothing here is committed. `scripts/triage-feedback.mts` runs
# `terraform output -json` once and caches the result in .triage/stack.json
# (gitignored), so no account id, table name or bucket name ever lands in git.
# The single value that DOES get committed is api_url, which contains the API id
# — not the account id — and has to be in the client anyway.
# -----------------------------------------------------------------------------

output "api_url" {
  description = "Full ingest URL. Paste into FEEDBACK_API_URL in src/main/feedback/net.ts."
  value       = "${trimsuffix(aws_apigatewayv2_stage.default.invoke_url, "/")}${local.feedback_route_path}"
}

output "api_id" {
  description = "HTTP API id (dimension for the CloudWatch alarms)."
  value       = aws_apigatewayv2_api.main.id
}

output "region" {
  description = "Region every resource lives in; the triage CLI configures its clients from this."
  value       = var.region
}

output "cluster_endpoint" {
  description = "Aurora DSQL hostname the triage CLI and the Lambda connect to (postgres/5432, IAM token auth)."
  value       = local.dsql_endpoint
}

output "cluster_identifier" {
  description = "Aurora DSQL cluster id (dimension for the DPU + OCC alarms)."
  value       = aws_dsql_cluster.feedback.identifier
}

# Consumed by `triage-feedback migrate`, which substitutes it into schema.sql's
# `AWS IAM GRANT feedback_ingest TO '<arn>'`. It carries the account id, which is
# exactly why the schema file holds a placeholder instead of the literal.
output "lambda_role_arn" {
  description = "Execution role ARN the DSQL ingest database role is mapped to."
  value       = aws_iam_role.lambda.arn
}

output "bucket_name" {
  description = "S3 bucket holding uploaded log slices under logs/."
  value       = aws_s3_bucket.logs.bucket
}

output "triage_role_arn" {
  description = "Role the triage CLI assumes with --role-arn (least privilege; see iam.tf)."
  value       = aws_iam_role.triage.arn
}

output "ops_topic_arn" {
  description = "SNS topic every alarm and budget notification publishes to."
  value       = aws_sns_topic.ops.arn
}

output "lambda_function_name" {
  description = "Submit handler function name (for `aws logs tail`)."
  value       = aws_lambda_function.submit.function_name
}

output "lambda_log_group" {
  description = "CloudWatch log group for the submit handler."
  value       = aws_cloudwatch_log_group.lambda.name
}

output "api_access_log_group" {
  description = "CloudWatch log group holding API access logs (source IPs, 14-day retention)."
  value       = aws_cloudwatch_log_group.api_access.name
}

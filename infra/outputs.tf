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

output "table_name" {
  description = "DynamoDB table the triage CLI queries."
  value       = aws_dynamodb_table.feedback.name
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

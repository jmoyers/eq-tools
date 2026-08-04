# -----------------------------------------------------------------------------
# S3 — the uploaded log slices (§3.3).
#
#   logs/<yyyy>/<mm>/<dd>/<reportId>.log.gz
#
# The bucket name carries a random_id suffix for global uniqueness SO THAT THE
# ACCOUNT ID NEVER APPEARS IN GIT (this repo is public). Nothing reads the name
# from source: the client is handed a presigned POST, and the triage CLI resolves
# it from `terraform output -json`.
#
# No CORS: every writer and reader is a non-browser client (Electron main, the
# triage script), so there is no Origin header and no preflight to answer.
# -----------------------------------------------------------------------------

resource "random_id" "bucket_suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "logs" {
  bucket = "${var.name_prefix}-logs-${random_id.bucket_suffix.hex}"

  # A `terraform destroy` must not be able to delete user-submitted evidence.
  # Removing this block is the deliberate act that makes a real teardown possible.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket = aws_s3_bucket.logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }

    bucket_key_enabled = true
  }
}

# Versioning stays OFF, stated explicitly rather than left to the default: a
# versioned object makes "we deleted it on request" a lie, and `triage-feedback
# forget/wipe` must be able to tell the truth.
resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id

  versioning_configuration {
    status = "Disabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    id     = "expire-log-slices"
    status = "Enabled"

    filter {
      prefix = "logs/"
    }

    # No IA transition: at this volume the per-object transition request costs
    # more than the storage it would save.
    expiration {
      days = var.log_object_expiration_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

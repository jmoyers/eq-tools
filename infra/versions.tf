# =============================================================================
# infra/ — Terraform root for the EQ Legends Companion feedback ingest stack.
# =============================================================================
#
# WHAT THIS IS. One HTTP API route (POST /v1/feedback), one Lambda, one Aurora
# DSQL cluster, one S3 bucket for log slices, and the guard rails that make a
# publicly writable endpoint safe to leave running on a personal AWS account:
# route throttles, reserved concurrency, request-based billing, a size-pinned
# presigned POST, lifecycle expiry, short log retention, a $10 budget and six
# alarms. Full design + rationale: docs/plans/feedback-triage.md (§7-§9), with
# the DynamoDB -> DSQL rework argued in dsql.tf.
#
# IaC IS TERRAFORM (owner decision, 2026-08-03), region us-east-1, deployed into
# a DEDICATED AWS sub-account. CI validates; CI NEVER plans or applies (there are
# no cloud credentials in a public repo) — see .github/workflows/infra.yml.
#
# THE AWS PROVIDER IS PINNED TO 6.x BECAUSE `aws_dsql_cluster` NEEDS IT. Do not
# relax it back to 5.x without checking that the resource still resolves.
#
# STATE BACKEND. Bootstrapped by hand in the sub-account before the first init
# (bucket + lock table; see README.md). The values below are physical names, not
# secrets: no account id and no profile name appears in any committed file. The
# deploy profile is supplied at run time, e.g.
#
#     AWS_PROFILE=<your-profile> terraform init
#
# LOCAL/CI VALIDATION never touches the backend:
#
#     terraform init -backend=false && terraform validate
#
# =============================================================================

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # The lock table is the LAST DynamoDB dependency in this tree, and it is
  # Terraform's own, not the product's. Terraform now deprecates `dynamodb_table`
  # in favour of S3-native locking (`use_lockfile = true`), which would retire it
  # entirely — but that raises the minimum Terraform version and CI pins its
  # toolchain in .github/workflows/infra.yml, so it is a deliberate follow-up
  # (one commit that moves the pin, the backend and the README bootstrap
  # together), not a drive-by edit inside a store migration.
  backend "s3" {
    bucket         = "eqcompanion-tf-state-dae027bf"
    key            = "eqcompanion/feedback"
    region         = "us-east-1"
    dynamodb_table = "eqcompanion-tf-lock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "eqcompanion"
      Component = "feedback"
      ManagedBy = "terraform"
    }
  }
}

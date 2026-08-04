# -----------------------------------------------------------------------------
# Aurora DSQL — the feedback store (§3.2, reworked). Owner decision: serverless
# POSTGRES, not DynamoDB.
#
# WHAT CHANGED AND WHY IT IS A SMALL CHANGE. The single-table design existed
# because DynamoDB cannot filter without an index: `pk`/`sk` prefixes,
# `gsi1 byChannel`, `gsi2 byStatus` and the ULID sort key were all machinery for
# expressing "reports since T, newest first" as a key range. In SQL that is a
# WHERE clause. So the five logical items become five real tables, the two GSIs
# become two indexes, and every "no filter expression, no scan" note in the plan
# becomes an ordinary indexed predicate.
#
# WHAT DSQL DOES NOT HAVE, and what this stack does instead:
#
#   * NO TTL. DynamoDB expired the quota / idempotency / dedupe rows for free.
#     Here the ingest handler sweeps them (bounded DELETE, time-gated, best
#     effort) — see infra/lambda/db.ts. That is the only retention mechanism
#     that moved; the 90-day S3 lifecycle on log slices is UNTOUCHED.
#   * NO FOREIGN KEYS, NO TRIGGERS, NO PL/pgSQL. The schema needs none: every
#     relationship is by id and every rule is in the handler.
#   * NO SYNCHRONOUS `CREATE INDEX`. Indexes are `CREATE INDEX ASYNC`, which is
#     one of the reasons the schema cannot be applied from Terraform (below).
#   * FIXED REPEATABLE READ + optimistic concurrency. Nothing blocks; a write
#     conflict is a commit-time serialization error that the caller RETRIES.
#     The quota cap's race-safety argument is written out in submit.ts.
#
# THE SCHEMA IS NOT IN THIS FILE, ON PURPOSE. Terraform has no first-class way
# to run SQL against a DSQL cluster (there is no `aws_dsql_*` DDL resource, and
# the IAM-token auth means a provisioner would have to mint its own token and
# speak the postgres wire protocol). Rather than smuggle DDL through a
# `null_resource` + `local-exec` that nobody can review or re-run safely, the
# schema lives in `infra/schema.sql` and is applied by
# `npx tsx scripts/triage-feedback.mts migrate` — idempotent, tolerant of
# already-exists, and documented as step 2.5 of the deploy runbook (README).
# One DDL statement per transaction is a DSQL law, and the migrate runner obeys
# it by issuing every statement on its own.
#
# BILLING: DPU (request-based) + storage. Nothing to provision, nothing to
# autoscale, no capacity setting that turns a flood into a bill — the same
# property PAY_PER_REQUEST bought before. Free tier covers this product's
# volume many times over; the DPU alarm in alarms.tf is the tripwire.
# -----------------------------------------------------------------------------

resource "aws_dsql_cluster" "feedback" {
  # Belt: the service itself refuses a delete while this is set. The report rows
  # ARE the backlog (§3.5) and are retained indefinitely.
  deletion_protection_enabled = true

  tags = {
    Name = "${var.name_prefix}-feedback"
  }

  # Braces: `terraform destroy` must not be able to take the backlog with it,
  # the same rule the bucket carries. Removing this block AND flipping
  # deletion_protection_enabled is the deliberate two-step that makes a real
  # teardown possible (§9.4, "Nuclear").
  lifecycle {
    prevent_destroy = true
  }
}

locals {
  # DSQL publishes no `endpoint` attribute; the public hostname is derived from
  # the cluster identifier. Spelled out once, here, and consumed by the Lambda
  # env and the `cluster_endpoint` output.
  dsql_endpoint = "${aws_dsql_cluster.feedback.identifier}.dsql.${var.region}.on.aws"

  # The database role the INGEST path logs in as. Created by `migrate`, mapped to
  # the Lambda's IAM role with `AWS IAM GRANT`, and granted the narrowest set of
  # table privileges that makes the handler work (schema.sql spells them out).
  # It is emphatically NOT `admin`: see iam.tf.
  dsql_ingest_role = "feedback_ingest"
}

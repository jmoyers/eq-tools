# -----------------------------------------------------------------------------
# DynamoDB — ONE table, single-table design (§3.2).
#
#   Report        REPORT#<ulid>       / META
#   Install       INSTALL#<installId> / PROFILE
#   Daily quota   INSTALL#<installId> / QUOTA#<yyyy-mm-dd>   TTL 3d
#   Idempotency   INSTALL#<installId> / IDEMP#<clientId>     TTL 7d
#   Dedupe probe  DEDUPE#<sha256>     / <yyyy-mm-dd>         TTL 2d
#   Config        CONFIG              / FEEDBACK             (kill switch, quota)
#
# PAY_PER_REQUEST on purpose: nothing to over-provision, nothing to autoscale,
# and no capacity setting that turns a flood into a bill. reportId is a ULID, so
# the GSI sort key IS the timeline and `--since 7d` is a BETWEEN with no filter
# expression and no scan.
# -----------------------------------------------------------------------------

resource "aws_dynamodb_table" "feedback" {
  name         = "EqCompanionFeedback"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "gsi1pk"
    type = "S"
  }

  attribute {
    name = "gsi1sk"
    type = "S"
  }

  attribute {
    name = "gsi2pk"
    type = "S"
  }

  attribute {
    name = "gsi2sk"
    type = "S"
  }

  # byChannel — the workhorse: "every prod report since T, newest first".
  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }

  # byStatus — "everything still new", "everything accepted but not shipped".
  global_secondary_index {
    name            = "gsi2"
    hash_key        = "gsi2pk"
    range_key       = "gsi2sk"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  # The report rows ARE the backlog and are retained indefinitely (§3.5); PITR is
  # the only thing standing between a fat-fingered BatchWrite and losing them.
  # Cents per month at this volume.
  point_in_time_recovery {
    enabled = true
  }

  # Same reasoning as the bucket: `terraform destroy` must not be able to take the
  # backlog with it. Removing this block is a deliberate act (§9.4, "Nuclear").
  lifecycle {
    prevent_destroy = true
  }
}

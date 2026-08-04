-- =============================================================================
-- infra/schema.sql — the Aurora DSQL schema for the feedback store.
-- =============================================================================
--
-- APPLIED BY:  npx tsx scripts/triage-feedback.mts migrate --profile <p>
--
-- NOT by Terraform. DSQL DDL needs an IAM-signed postgres connection, which
-- Terraform cannot make; see the header of infra/dsql.tf. The migrate command
-- connects as `admin`, splits this file into statements, and runs each one in
-- its OWN transaction (DSQL law: one DDL statement per transaction, and DDL and
-- DML may not share a transaction).
--
-- IDEMPOTENT. Re-running is a no-op: tables use IF NOT EXISTS, and the runner
-- treats "already exists" (42P07 / 42710 / 42P06) as success and says so.
--
-- STATEMENT SPLITTING is line-based: a statement ends at the first line whose
-- last character is `;`. Therefore NO STRING LITERAL IN THIS FILE MAY END A LINE
-- WITH A SEMICOLON. Nothing here does; keep it that way (there is no PL/pgSQL to
-- dollar-quote — DSQL does not support it).
--
-- `${LAMBDA_ROLE_ARN}` is substituted by the migrate command from
-- `terraform output -raw lambda_role_arn`. It contains the account id, which is
-- why it is a placeholder in a public repo and not a literal.
--
-- ---------------------------------------------------------------------------
-- SHAPE NOTES (why the columns look like this)
-- ---------------------------------------------------------------------------
--  * TIMES ARE epoch-MILLISECOND `bigint`, not timestamptz. The whole contract
--    (`receivedAt`, `clientTs`, `triagedAt`, `expiresAt`) is `number` in
--    src/shared/feedback.ts and in the triage CLI. Storing the same number keeps
--    ONE representation end to end; a timestamptz would add a conversion at
--    every boundary for no query we run. Both readers set node-postgres's int8
--    parser to Number — epoch ms is exact well past year 10000.
--  * `env_json` / `log_json` are TEXT holding JSON, not jsonb. Nothing ever
--    queries INTO them (the CLI parses them in JS), jsonb cannot be indexed in
--    DSQL anyway, and DSQL's jsonb support is two months old. The three env
--    fields that ARE queried or displayed in every list — channel, app_version,
--    platform — are promoted to real columns; env_json stays authoritative for
--    `show`.
--  * PRIMARY KEYS ARE THE UNIQUENESS RULES. `report_idempotency` is keyed on
--    (install_id, client_report_id), so idempotency is enforced by the key
--    itself rather than by a secondary unique index that would be built
--    asynchronously (and therefore unenforced for a window). Same for the quota
--    and dedupe counters.
--  * NO FOREIGN KEYS — DSQL has none. Every relationship here is by id and is
--    already enforced by the handler, which is the only writer of report rows.
--  * `report_id` is a ULID (server-minted). It stays the primary key so a report
--    is addressable by exactly the id the user is shown, and `received_at`
--    carries the timeline for every range query.

-- ---- tables -----------------------------------------------------------------

-- The kill switch and the live quota (§9.6). One row, id 'FEEDBACK'.
-- Seeded below with accepting = false: a freshly migrated stack is CLOSED until
-- the operator runs `triage-feedback closed off`, which is the safe default for
-- an endpoint that has never been smoke-tested.
CREATE TABLE IF NOT EXISTS feedback_config (
  id                      text    NOT NULL,
  accepting               boolean NOT NULL,
  closed_message          text    NOT NULL,
  max_per_install_per_day integer NOT NULL,
  PRIMARY KEY (id)
);

-- Per-install block list. Absent row = not blocked.
CREATE TABLE IF NOT EXISTS install_profile (
  install_id     text    NOT NULL,
  blocked        boolean NOT NULL,
  blocked_reason text,
  blocked_at     bigint,
  PRIMARY KEY (install_id)
);

-- The backlog. Written once by ingest (INSERT only — the ingest role holds no
-- SELECT/UPDATE/DELETE here), amended thereafter only by the triage path.
CREATE TABLE IF NOT EXISTS report (
  report_id   text   NOT NULL,
  install_id  text   NOT NULL,
  report_type text   NOT NULL,
  title       text,
  description text   NOT NULL,
  contact     text,
  channel     text   NOT NULL,
  app_version text   NOT NULL,
  platform    text   NOT NULL,
  env_json    text   NOT NULL,
  log_json    text,
  log_key     text,
  client_ts   bigint NOT NULL,
  received_at bigint NOT NULL,
  spam_score  integer NOT NULL,
  status      text   NOT NULL,
  severity    text,
  cluster_id  text,
  dupe_of     text,
  disposition text,
  issue_url   text,
  triaged_at  bigint,
  redacted_at bigint,
  PRIMARY KEY (report_id)
);

-- Daily per-install quota counter. `expires_at` is swept by the handler; there
-- is no TTL in DSQL.
CREATE TABLE IF NOT EXISTS install_quota (
  install_id text    NOT NULL,
  quota_day  text    NOT NULL,
  n          integer NOT NULL,
  bytes      bigint  NOT NULL,
  expires_at bigint  NOT NULL,
  PRIMARY KEY (install_id, quota_day)
);

-- Idempotency across offline retries (§6.4). The PRIMARY KEY *is* the guarantee.
CREATE TABLE IF NOT EXISTS report_idempotency (
  install_id       text   NOT NULL,
  client_report_id text   NOT NULL,
  report_id        text   NOT NULL,
  expires_at       bigint NOT NULL,
  PRIMARY KEY (install_id, client_report_id)
);

-- Copy-paste-flood probe (§9.5): same description text, same day, different
-- install. A spam SIGNAL only — it never blocks anything.
CREATE TABLE IF NOT EXISTS dedupe_probe (
  hash          text    NOT NULL,
  probe_day     text    NOT NULL,
  first_install text    NOT NULL,
  n             integer NOT NULL,
  expires_at    bigint  NOT NULL,
  PRIMARY KEY (hash, probe_day)
);

-- ---- indexes ----------------------------------------------------------------
--
-- `CREATE INDEX ASYNC` is mandatory in DSQL (DDL cannot lock in a distributed
-- system). It returns a job id immediately and builds in the background; the
-- migrate command prints the id. Deliberately NO `IF NOT EXISTS` — it is not
-- part of the ASYNC grammar everywhere, and the runner already treats
-- "already exists" as success, which is the check that matters.
--
-- Columns are ASC: PostgreSQL scans an index backwards for `ORDER BY ... DESC`,
-- so a DESC index would buy nothing and adds a syntax bet.
--
-- These two replace gsi1 (byChannel) and gsi2 (byStatus). There is deliberately
-- NO index on install_id: `wipe --install` is a once-a-year deletion request and
-- the CLI warns that it is an unindexed scan — the same trade the plan made when
-- it refused a third GSI. There is likewise no index on `expires_at`: the sweep
-- is bounded and time-gated, and indexing it would tax every submit to speed up
-- a janitor.

CREATE INDEX ASYNC report_by_channel ON report (channel, received_at);

CREATE INDEX ASYNC report_by_status ON report (status, received_at);

-- ---- seed -------------------------------------------------------------------
-- DML, so it is its own transaction (DSQL forbids mixing it with DDL).

INSERT INTO feedback_config (id, accepting, closed_message, max_per_install_per_day)
VALUES ('FEEDBACK', false, 'Feedback is not open yet. Please try again later.', 10)
ON CONFLICT (id) DO NOTHING;

-- ---- the ingest database role ----------------------------------------------
--
-- THE INGEST PATH CAN CREATE AND COUNT. IT CANNOT READ THE BACKLOG OR DELETE A
-- REPORT. That property was IAM-shaped under DynamoDB (no Query, no Scan, no
-- DeleteItem); with one SQL endpoint it has to be shaped by GRANTs instead, so
-- the Lambda logs in as this role and never as `admin`. Note what is absent
-- below: any privilege at all on `report` other than INSERT.
--
-- DELETE on the three counter tables is what makes the retention sweep real.

CREATE ROLE feedback_ingest WITH LOGIN;

AWS IAM GRANT feedback_ingest TO '${LAMBDA_ROLE_ARN}';

GRANT USAGE ON SCHEMA public TO feedback_ingest;

GRANT SELECT ON feedback_config TO feedback_ingest;

GRANT SELECT ON install_profile TO feedback_ingest;

GRANT INSERT ON report TO feedback_ingest;

GRANT SELECT, INSERT, DELETE ON report_idempotency TO feedback_ingest;

GRANT SELECT, INSERT, UPDATE, DELETE ON install_quota TO feedback_ingest;

GRANT SELECT, INSERT, UPDATE, DELETE ON dedupe_probe TO feedback_ingest;

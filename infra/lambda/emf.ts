/**
 * emf.ts — CloudWatch metrics without a metrics client, and without a PutMetricData call.
 *
 * THE EMBEDDED METRIC FORMAT is a documented JSON shape you WRITE TO STDOUT. CloudWatch Logs
 * recognises the `_aws` node, extracts the named fields as metrics, and keeps the whole line as
 * a searchable log event. That buys the near-real-time view plan §1 asks for — "active sessions
 * now, events/min, per-funnel-step counters today" — for the cost of a `console` write:
 *
 *   * NO SDK. `aws-embedded-metrics` would be a dependency, a flush lifecycle and a second
 *     opinion about buffering inside a function whose whole job takes 30 ms.
 *   * NO EXTRA LATENCY. `PutMetricData` is a network call on the request path; this is not.
 *   * NO EXTRA IAM. The function already writes to its log group.
 *
 * WHAT MUST NEVER GO IN A DIMENSION: an analyticsId, or anything else with more than a handful
 * of values. A CloudWatch dimension VALUE mints a distinct metric, which is billed and which
 * would also re-create — in the metrics store — exactly the per-user trail that T6 refuses to
 * keep. Every dimension emitted here is a closed enum member from the schema.
 *
 * Reference: docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
 */

import process from 'node:process'

/** The product's namespace. One place, so a dashboard cannot be pointed at a typo. */
export const EMF_NAMESPACE = 'EQCompanion/Telemetry'

/** A CloudWatch unit string. `Count` is the only one this ingest path has ever needed. */
export type EmfUnit = 'Count' | 'Milliseconds' | 'Bytes'

export interface EmfMetric {
  name: string
  value: number
  unit?: EmfUnit
}

/** CloudWatch refuses a line past this; it is also far past anything worth emitting. */
const MAX_METRICS_PER_LINE = 100

/**
 * ONE EMF document, as the string that goes to stdout. Returned rather than written so it can
 * be asserted in a test without capturing a stream — the whole shape is the contract with
 * CloudWatch, and a typo in `_aws` fails silently (the line stays a log event and simply
 * produces no metric), which is exactly the kind of failure a test has to catch instead.
 *
 * Metrics with a non-finite value are DROPPED: `NaN` in one field would invalidate the whole
 * document, taking the good metrics beside it down too.
 */
export function emfLine(
  dimensions: Record<string, string>,
  metrics: readonly EmfMetric[],
  nowMs: number
): string | null {
  const usable = metrics.filter((m) => Number.isFinite(m.value)).slice(0, MAX_METRICS_PER_LINE)
  if (usable.length === 0) return null
  const dimensionKeys = Object.keys(dimensions)
  const doc: Record<string, unknown> = {
    _aws: {
      Timestamp: nowMs,
      CloudWatchMetrics: [
        {
          Namespace: EMF_NAMESPACE,
          // A single dimension SET. An empty set is legal and means "aggregate only".
          Dimensions: dimensionKeys.length > 0 ? [dimensionKeys] : [[]],
          Metrics: usable.map((m) => ({ Name: m.name, Unit: m.unit ?? 'Count' }))
        }
      ]
    },
    ...dimensions
  }
  for (const m of usable) doc[m.name] = m.value
  return JSON.stringify(doc)
}

/** Write one document. Best effort by construction: a stdout write cannot fail a request. */
export function emit(
  dimensions: Record<string, string>,
  metrics: readonly EmfMetric[],
  nowMs: number
): void {
  const line = emfLine(dimensions, metrics, nowMs)
  if (line !== null) process.stdout.write(`${line}\n`)
}

// Frame coalescing for high-rate pointer paths (the chart hover layers). A 1000Hz mouse
// delivers hundreds of `pointermove`s per frame; every one of them would otherwise run a hit
// test and a setState. This drops all but the LAST set of arguments per animation frame, which
// is exactly what a cursor-following readout needs — intermediate positions are never drawn.
//
// `requestAnimationFrame` is looked up on the global at CALL time (not captured at module
// load), so a test can stub it and drive the frames by hand.

/** The throttled callback, plus the cancel its owner must call on unmount. */
export type Throttled<A extends unknown[]> = ((...a: A) => void) & { cancel: () => void }

/** Coalesce calls to at most one per animation frame; last args win. */
export function rafThrottle<A extends unknown[]>(fn: (...a: A) => void): Throttled<A> {
  let handle: number | null = null
  let pending: A | null = null

  const run = (): void => {
    handle = null
    const args = pending
    pending = null
    if (args) fn(...args)
  }

  const wrapped = (...a: A): void => {
    pending = a
    handle ??= requestAnimationFrame(run)
  }
  const throttled = wrapped as Throttled<A>
  throttled.cancel = (): void => {
    if (handle !== null) cancelAnimationFrame(handle)
    handle = null
    pending = null
  }
  return throttled
}

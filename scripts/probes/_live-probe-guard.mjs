/**
 * Consent gate for the live probes.
 *
 * Everything under `scripts/probes/` talks to the real upstream and therefore
 * spends real plan quota. Run them by accident — a stray `node .` completion, a
 * "let me just try it" — and the account is charged for it. Requiring one
 * explicit environment variable makes that a deliberate act.
 *
 * Import this for its side effect, as the first statement of a probe:
 *
 *   import './_live-probe-guard.mjs'
 *
 * Set `CMDGO_ALLOW_LIVE_PROBES=1` to pass.
 */
if (process.env.CMDGO_ALLOW_LIVE_PROBES !== '1') {
  console.error(
    '拒绝运行：本探针会向真实上游发起请求，消耗真实额度。\n'
    + '确认后请设置 CMDGO_ALLOW_LIVE_PROBES=1 再执行。\n'
    + '（Windows PowerShell: $env:CMDGO_ALLOW_LIVE_PROBES = "1"）',
  )
  process.exit(1)
}

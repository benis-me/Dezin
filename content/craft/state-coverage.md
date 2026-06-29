# State coverage

The single most reliable AI-design failure is shipping only the **populated**
state. Any surface that loads or mutates data must handle all five:

1. **Loading** — see the threshold table; never a frozen blank.
2. **Empty** — say what this is and how to fill it (a first-run prompt, not a void).
3. **Error** — what happened, why, and the recovery path; **preserve the user's input**.
4. **Populated** — the real thing, with realistic data.
5. **Edge** — very long strings, 10k rows, zero/negative values, RTL.

## Loading thresholds

| Wait | Treatment |
|---|---|
| < 300ms | no indicator (it'd flash) |
| 300ms–2s | skeleton matching the final layout |
| 2–10s | labelled spinner / progress |
| 10–30s | determinate bar + cancel |
| 15s | "taking longer than expected" |
| 60s | stop + error with retry |

Errors use `role="alert"` and move focus; toasts use `role="status"`.

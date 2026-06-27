# AGY quota fixtures

These fixtures preserve the cli-jaw AGY quota parser contract without storing
account-specific raw data.

Source tags:

- `synthetic-contract`: hand-built schema sample for a known behavior contract.
- `sanitized-live`: derived from a live shape with account fields redacted.
- `observed-live`: exact raw shape with no sensitive fields.

Rules:

- Do not commit real email addresses, account IDs, access tokens, cookies, or
  provider request IDs.
- Keep upstream-like fields as raw as possible. Tests should normalize the
  snapshot, not pre-normalize it into cli-jaw `windows`.
- Binary AGY `remainingPercentage` values are availability-only. Backend keeps
  compatibility `percent`, but UI must display `Available` or `Exhausted`
  whenever `precision` is `binary`.

Fixture map:

| File | Source | Purpose |
| --- | --- | --- |
| `precise-google-ai-pro.json` | synthetic-contract | Fractional `remainingPercentage` values produce precise percent bars. |
| `binary-available-exhausted.json` | synthetic-contract | Binary `0`/`1` values produce `precision: "binary"` windows. |
| `missing-models.json` | synthetic-contract | Missing `models` fails soft with no windows. |
| `empty-models.json` | synthetic-contract | Empty `models` fails soft with no windows. |
| `mixed-precise-binary.json` | synthetic-contract | Current snapshot-wide precision policy: any fractional quota makes the snapshot precise. |
| `auth-or-upstream-error.json` | synthetic-contract | Error-shaped schema drift fails soft at parser scope. |


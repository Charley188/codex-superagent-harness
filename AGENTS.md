# Development guide

Keep the Codex execution engine and DSH-derived orchestration boundaries explicit. Read callers and tests before adapting upstream behavior. Do not change pinned vendor bytes: preserve licenses and update provenance deliberately when upgrading.

Use `state/` for runtime outputs and dedicated tools directories for scripts. Never commit local configuration, credentials, user projects or model transcripts. Synthetic fixtures are the only bundled model inputs.

Run `test.ps1` after code changes. Deployment additionally requires `certify.ps1` against the exact local CLI and source fingerprint. Do not copy or forge acceptance certificates. Keep unavailable UI features clearly identified, and verify that editable settings actually affect subsequent requests.

This is a generic framework. Do not hard-code personal projects, research topics, credentials, drive paths or fixed professional Worker roles. Keep the public README accurate about implemented and unimplemented functionality.

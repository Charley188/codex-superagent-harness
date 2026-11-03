# Calls the configured Codex using synthetic input; consumes model quota.
$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath (Join-Path $PSScriptRoot 'app')
try {
    & python -B -m research_ops certify
    if ($LASTEXITCODE -ne 0) { throw 'Codex compatibility certification failed; service remains gated.' }
} finally { Pop-Location }
Push-Location -LiteralPath (Join-Path $PSScriptRoot 'prototypes/dsh-core')
try {
    & node --experimental-transform-types framework/certify.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Framework certification failed; service remains gated.' }
} finally { Pop-Location }

$ErrorActionPreference = 'Stop'
function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed (exit $LASTEXITCODE)" }
}
Push-Location -LiteralPath $PSScriptRoot
try {
    Invoke-Checked 'python' @('-B','tools/check_public.py')
    Invoke-Checked 'python' @('-B','-m','unittest','discover','-s','tests','-v')
    Push-Location -LiteralPath 'app'
    try { Invoke-Checked 'python' @('-B','-m','unittest','discover','-s','tests','-v') } finally { Pop-Location }
    Push-Location -LiteralPath 'prototypes/dsh-core'
    try {
        Invoke-Checked 'node' @('run-tests.mjs','--json')
        Invoke-Checked 'python' @('-B','-m','unittest','discover','-s','tests','-p','test_*.py','-v')
        Invoke-Checked 'python' @('-B','framework/validate_release.py')
        Invoke-Checked 'node' @('panel/check.mjs')
    } finally { Pop-Location }
    Write-Host 'Offline regression passed. This does not certify real model execution.'
} finally { Pop-Location }

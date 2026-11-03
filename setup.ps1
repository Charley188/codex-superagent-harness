param([string]$Codex = 'codex')
$ErrorActionPreference = 'Stop'
function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed (exit $LASTEXITCODE)" }
}
Push-Location -LiteralPath $PSScriptRoot
try {
    foreach ($program in @('node','python','pnpm','npm')) { Get-Command $program -ErrorAction Stop | Out-Null }
    Invoke-Checked 'node' @('-e', 'const [a,b]=process.versions.node.split(".").map(Number);if(!((a===22&&b>=19)||a>=24))throw Error("Node 22.19+ (22.x) or 24+ required")')
    Invoke-Checked 'python' @('-c', 'import sys; assert sys.version_info >= (3,12), "Python 3.12+ required"')
    if (-not (Test-Path -LiteralPath 'config.local.json')) {
        Invoke-Checked 'python' @('-B','tools/initialize.py','--codex',$Codex)
    } else { Write-Host 'Existing local policy preserved.' }
    Push-Location -LiteralPath 'prototypes/dsh-core'
    try {
        Invoke-Checked 'pnpm' @('install','--frozen-lockfile')
        Push-Location -LiteralPath 'panel'
        try {
            Invoke-Checked 'npm' @('ci')
            Invoke-Checked 'node' @('build.mjs')
        } finally { Pop-Location }
        if (-not (Test-Path -LiteralPath '../../state/dsh-core/framework-local/projects.json')) {
            Invoke-Checked 'node' @('--experimental-transform-types','framework/cli.mjs','init')
        }
    } finally { Pop-Location }
    Write-Host 'Setup complete. Next: .\test.ps1, .\certify.ps1, then .\start.ps1'
} finally { Pop-Location }

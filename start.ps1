param(
    [ValidateSet('start','init','status','pause','resume','doctor','backup','certify','shutdown')]
    [string]$Action = 'start',
    [switch]$NoBrowser,
    [switch]$Foreground
)
$ErrorActionPreference = 'Stop'
$frameworkRoot = Join-Path $PSScriptRoot 'prototypes/dsh-core'
$connectionPath = Join-Path $PSScriptRoot 'state/dsh-core/framework-local/connection.json'

if ($Action -eq 'start' -and -not $Foreground) {
    $launcher = Join-Path $PSScriptRoot 'state/desktop/CodexSuperagent.exe'
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { & (Join-Path $PSScriptRoot 'desktop/build.ps1') }
    if ($NoBrowser) { Start-Process -FilePath $launcher -ArgumentList '--no-browser' -WindowStyle Hidden }
    else { Start-Process -FilePath $launcher -WindowStyle Hidden }
    Write-Host 'Codex Superagent is running in the background. Use the desktop/tray icon to open it and Exit workbench to close it.'
    return
}

function Get-RunningFrameworkUrl {
    try {
        if (-not (Test-Path -LiteralPath $connectionPath -PathType Leaf)) { return $null }
        $connection = Get-Content -Raw -LiteralPath $connectionPath | ConvertFrom-Json
        $address = [uri]$connection.url
        # Open only the authenticated loopback service, never an arbitrary URL from an old state file.
        if ($address.Scheme -ne 'http' -or $address.Host -ne '127.0.0.1' -or
            $address.AbsolutePath -ne '/' -or $address.UserInfo -or $address.Query -or
            $address.Fragment -notmatch '^#[a-f0-9]{64}$') { return $null }
        $headers = @{ Authorization = 'Bearer ' + $address.Fragment.Substring(1) }
        $status = Invoke-RestMethod -Uri ($address.GetLeftPart([System.UriPartial]::Authority) + '/api/status') -Headers $headers -TimeoutSec 2 -ErrorAction Stop
        if ($null -eq $status.projects -or $null -eq $status.paused) { return $null }
        return $address.AbsoluteUri
    } catch {
        return $null
    }
}

function Open-FrameworkPage([string]$Address) {
    Write-Host "Codex Superagent: $Address"
    if ($NoBrowser) { return }
    try {
        # The requested interactive page opens in the user's default browser.
        Start-Process -FilePath $Address -ErrorAction Stop
    } catch {
        Write-Warning 'The browser could not be opened automatically. Copy the complete link above into your browser.'
    }
}

Push-Location -LiteralPath $frameworkRoot
try {
    if ($Action -eq 'start') {
        $runningAddress = Get-RunningFrameworkUrl
        if ($runningAddress) {
            Write-Host 'The workbench is already running. Opening the existing instance.'
            Open-FrameworkPage $runningAddress
            return
        }
        $pageOpened = $false
        # Read startup output as it arrives; serve remains in the foreground until shutdown.
        # Windows PowerShell 5 represents redirected native stderr as ErrorRecord objects.
        $savedPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & node --experimental-transform-types framework/cli.mjs serve 2>&1 | ForEach-Object {
                $line = $_.ToString()
                Write-Host $line
                if (-not $pageOpened -and $line.StartsWith('Codex Superagent: ')) {
                    $readyAddress = Get-RunningFrameworkUrl
                    if ($readyAddress) {
                        Open-FrameworkPage $readyAddress
                        $pageOpened = $true
                    }
                }
            }
            $frameworkExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $savedPreference
        }
        if ($frameworkExitCode -ne 0) { throw "Framework command failed with exit code $frameworkExitCode; execution records are preserved." }
        return
    } elseif ($Action -eq 'certify') {
        & node --experimental-transform-types framework/certify.mjs
    } else {
        $frameworkCommand = if ($Action -eq 'start') { 'serve' } else { $Action }
        & node --experimental-transform-types framework/cli.mjs $frameworkCommand
    }
    if ($LASTEXITCODE -ne 0) { throw "Framework command failed with exit code $LASTEXITCODE; execution records are preserved." }
} finally {
    Pop-Location
}

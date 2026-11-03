param([switch]$DesktopShortcut)
$ErrorActionPreference = 'Stop'
$researchRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$outputDirectory = Join-Path $researchRoot 'state/desktop'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$pythonPath = (Get-Command python.exe -ErrorAction Stop).Source
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler is unavailable.' }
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 64,64
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::FromArgb(16,42,67))
$font = New-Object System.Drawing.Font 'Segoe UI',34,([System.Drawing.FontStyle]::Bold)
$graphics.DrawString('C',$font,[System.Drawing.Brushes]::White,6,1)
$graphics.FillEllipse([System.Drawing.Brushes]::DeepSkyBlue,43,43,15,15)
$icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
$iconPath = Join-Path $outputDirectory 'workbench.ico'
$stream = [System.IO.File]::Create($iconPath)
try { $icon.Save($stream) } finally { $stream.Dispose(); $icon.Dispose(); $font.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
$exePath = Join-Path $outputDirectory 'CodexSuperagent.exe'
& $compiler /nologo /target:winexe /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/win32icon:$iconPath" "/out:$exePath" (Join-Path $PSScriptRoot 'Launcher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Desktop launcher build failed.' }
$hasher = [System.Security.Cryptography.SHA256]::Create()
try { $instanceKey = ([BitConverter]::ToString($hasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($researchRoot.ToLowerInvariant())))).Replace('-','').Substring(0,24) } finally { $hasher.Dispose() }
$config = @{ root=$researchRoot; node=$nodePath; python=$pythonPath; instance_key=$instanceKey } | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $outputDirectory 'launcher.json'),$config,(New-Object System.Text.UTF8Encoding $false))
$shortcutPaths = @((Join-Path $researchRoot 'Codex Superagent.lnk'))
if ($DesktopShortcut) { $shortcutPaths += Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex Superagent.lnk' }
$shell = New-Object -ComObject WScript.Shell
foreach ($shortcutPath in $shortcutPaths) {
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath=$exePath; $shortcut.WorkingDirectory=$researchRoot; $shortcut.IconLocation="$exePath,0"; $shortcut.Description='Open the local Codex Superagent workbench'; $shortcut.Save()
}
Write-Host "Desktop launcher ready: $exePath"

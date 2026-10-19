# Doplní adresu vašeho GitHub repozitáře do Umbrel manifestu (ikona, odkazy).
# Použití:  .\configure-store.ps1 -User vas-github-ucet -Repo finterm-umbrel
param(
  [Parameter(Mandatory = $true)][string]$User,
  [Parameter(Mandatory = $true)][string]$Repo
)
$manifest = Join-Path $PSScriptRoot 'finterm-terminal\umbrel-app.yml'
$text = Get-Content -Raw -Encoding UTF8 $manifest
$text = $text.Replace('GITHUB_USER', $User).Replace('GITHUB_REPO', $Repo)
[System.IO.File]::WriteAllText($manifest, $text, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Hotovo: $manifest -> https://github.com/$User/$Repo"

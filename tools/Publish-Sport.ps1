param([string]$ReleaseDirectory = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

# Run from the extracted update archive. No Python or existing working tree is required.
$git = [string](Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source)
function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArguments)
    $output = & $git @GitArguments
    if ($LASTEXITCODE -ne 0) { throw "git failed ($LASTEXITCODE): $($GitArguments[0])" }
    return $output
}

$manifestPath = Join-Path $ReleaseDirectory 'Sport-release.json'
$release = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($release.repository -cne 'https://github.com/Stepan-fair/ha-sport.git') { throw 'Unexpected repository.' }
if ($release.commit -notmatch '^[a-f0-9]{40}$' -or $release.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release manifest.' }
if ($release.bundle -cne 'Sport-release.bundle') { throw 'Unexpected bundle filename.' }
$bundle = Join-Path $ReleaseDirectory $release.bundle
if ((Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLowerInvariant() -cne $release.sha256) { throw 'Bundle checksum mismatch. Extract the archive again.' }

$stage = Join-Path ([IO.Path]::GetTempPath()) ('ha-sport-release-' + [guid]::NewGuid().ToString('N'))
Invoke-Git clone --no-checkout -- $bundle $stage
$commit = [string]$release.commit
$tag = 'v' + [string]$release.version
$resolved = [string](Invoke-Git -C $stage rev-parse ($tag + '^{commit}'))
if ($resolved.Trim() -cne $commit) { throw 'The tag does not match the reviewed commit.' }
$configuration = (Invoke-Git -C $stage show ($commit + ':sport_diary/config.yaml')) -join "`n"
if ($configuration -notmatch ('(?m)^version: "' + [regex]::Escape([string]$release.version) + '"\s*$')) { throw 'Application version mismatch.' }
foreach ($key in @('person1_user','person2_user','person1_weight','person2_weight','nutrition_assistant_user')) {
    if ($configuration -notmatch ('(?m)^  ' + $key + ': ""\s*$')) { throw ('Private configuration detected: ' + $key) }
}
$files = @(Invoke-Git -C $stage ls-tree -r --name-only $commit)
foreach ($file in $files) {
    if ($file -match '(^|/)(data|backups?|\.tools|\.env)(/|$)|\.(db|sqlite|sqlite3|pem|key|pfx|p12)$') { throw ('Private runtime file detected: ' + $file) }
    if ($file -notmatch '^(README\.md|repository\.yaml|\.gitignore|\.github/workflows/[\w.-]+\.ya?ml|tools/[\w.-]+\.ps1|sport_diary/(web/[\w.-]+\.(js|css|html|json)|translations/[\w.-]+\.yaml|[\w.-]+\.(py|js|cjs|md|yaml)|Dockerfile))$') { throw ('Unexpected release file: ' + $file) }
}

Invoke-Git -C $stage remote set-url origin $release.repository
Invoke-Git -C $stage fetch origin main --tags
# Abort if newer server changes are not part of this update. Never force push.
Invoke-Git -C $stage merge-base --is-ancestor origin/main $commit
Write-Host ("Publishing " + $tag + ' to Stepan-fair/ha-sport...')
Invoke-Git -C $stage push --atomic origin ($commit + ':refs/heads/main') ('refs/tags/' + $tag)
$remote = @(Invoke-Git -C $stage ls-remote origin refs/heads/main ('refs/tags/' + $tag + '^{}'))
if (-not ($remote | Where-Object { $_ -eq ($commit + "`trefs/heads/main") })) { throw 'The main branch could not be verified after publication.' }
if (-not ($remote | Where-Object { $_ -eq ($commit + "`trefs/tags/" + $tag + '^{}') })) { throw 'The release tag could not be verified after publication.' }
Write-Host ("Published " + $tag + '. Check for the Sport update in Home Assistant.')
Write-Host 'Repository: https://github.com/Stepan-fair/ha-sport'

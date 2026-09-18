# Keep this script ASCII so Windows PowerShell 5.1 reads it without a BOM.
# User-visible text lives in the UTF-8 catalog; native tool output is untouched.

function Initialize-AutoCompanyMessages {
    param(
        [string]$RepoRoot = (Join-Path $PSScriptRoot '../..'),
        [string]$Language,
        [string]$CatalogPath
    )

    $script:AutoCompanyMessageLanguage = 'en'
    $script:AutoCompanyMessageCatalog = $null
    try {
        # Only explicit -Language accepts PowerShell's case-insensitive aliases.
        # This display-only reader must not change or mask runtime validation.
        if ($PSBoundParameters.ContainsKey('Language')) {
            if ($Language -ieq 'en') { $selected = 'en' }
            elseif ($Language -ieq 'zh-CN') { $selected = 'zh-CN' }
            else { throw 'Invalid language.' }
        } else {
            $selected = 'zh-CN'
            $localPath = Join-Path $RepoRoot '.auto-company.local'
            if (Test-Path -LiteralPath $localPath) {
                $item = Get-Item -LiteralPath $localPath -Force -ErrorAction Stop
                if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                    throw 'Local configuration must not be a symlink.'
                }
                $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
                $localText = $utf8.GetString([System.IO.File]::ReadAllBytes($localPath))
                $foundLanguage = $false
                foreach ($line in ($localText -split '\r\n|\n|\r')) {
                    if (-not $line.Trim() -or $line.TrimStart().StartsWith('#')) { continue }
                    if ($line -cnotmatch '^([A-Z][A-Z0-9_]*)=(.*)$') {
                        throw 'Invalid local configuration.'
                    }
                    if ($Matches[1] -ceq 'AUTO_COMPANY_LANGUAGE') {
                        if ($foundLanguage) { throw 'Duplicate language setting.' }
                        $selected = $Matches[2]
                        $foundLanguage = $true
                    }
                }
            }
            $environmentLanguage = [Environment]::GetEnvironmentVariable('AUTO_COMPANY_LANGUAGE')
            if ($null -ne $environmentLanguage) { $selected = $environmentLanguage }
            if ($selected -cnotin @('zh-CN', 'en')) { throw 'Invalid language.' }
        }
        $script:AutoCompanyMessageLanguage = $selected
    } catch {
        # English is the original diagnostic text. Let the runtime report its
        # own invalid configuration rather than fail while rendering an error.
        $script:AutoCompanyMessageLanguage = 'en'
    }

    try {
        if (-not $CatalogPath) { $CatalogPath = Join-Path $RepoRoot 'i18n/windows-messages.json' }
        $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
        $catalogText = $utf8.GetString([System.IO.File]::ReadAllBytes($CatalogPath))
        $script:AutoCompanyMessageCatalog = ConvertFrom-Json -InputObject $catalogText -ErrorAction Stop
    } catch {
        # The English key is also the fallback when a catalog is unavailable.
        $script:AutoCompanyMessageCatalog = $null
    }
}

function Get-AutoCompanyMessage {
    param(
        [Parameter(Mandatory = $true)][string]$Key,
        [object[]]$Values = @()
    )

    $template = $Key
    if ($null -ne $script:AutoCompanyMessageCatalog) {
        $entry = $script:AutoCompanyMessageCatalog.PSObject.Properties[$Key]
        if ($null -ne $entry -and $null -ne $entry.Value) {
            $translation = $entry.Value.PSObject.Properties[$script:AutoCompanyMessageLanguage]
            if ($null -ne $translation -and $translation.Value -is [string] -and
                -not [string]::IsNullOrWhiteSpace($translation.Value)) {
                # A stale/broken translation must not drop diagnostic values.
                $expected = @([regex]::Matches($Key, '\{[0-9]+\}') | ForEach-Object { $_.Value } | Sort-Object -Unique)
                $actual = @([regex]::Matches($translation.Value, '\{[0-9]+\}') | ForEach-Object { $_.Value } | Sort-Object -Unique)
                if (($expected -join '|') -ceq ($actual -join '|')) {
                    $template = $translation.Value
                }
            }
        }
    }
    # One pass and a match evaluator keep $, braces, paths and untrusted native
    # diagnostics literal; neither shell expansion nor format-string evaluation.
    $resolvedValues = $Values
    return [regex]::Replace($template, '\{([0-9]+)\}', [System.Text.RegularExpressions.MatchEvaluator]{
        param($match)
        $index = 0
        if ([int]::TryParse($match.Groups[1].Value, [ref]$index) -and $index -lt $resolvedValues.Count) {
            return [string]$resolvedValues[$index]
        }
        return $match.Value
    })
}

Initialize-AutoCompanyMessages

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$windowsRoot = Join-Path $repoRoot 'scripts/windows'
. (Join-Path $windowsRoot 'messages-win.ps1')
$catalogPath = Join-Path $repoRoot 'i18n/windows-messages.json'
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$catalog = ConvertFrom-Json -InputObject $utf8.GetString([System.IO.File]::ReadAllBytes($catalogPath))
$originalLanguage = [Environment]::GetEnvironmentVariable('AUTO_COMPANY_LANGUAGE')
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$testRoot = Join-Path $tempRoot ('auto-company-messages-' + [guid]::NewGuid())
$null = New-Item -ItemType Directory -Path $testRoot
$localPath = Join-Path $testRoot '.auto-company.local'
$brokenCatalogPath = Join-Path $testRoot 'broken-catalog.json'
$script:checks = 0
$script:failures = @()
$missingWsl = 'wsl.exe not found. Enable WSL first.'

function Assert-Equal {
    param($Actual, $Expected)
    if ($Actual -cne $Expected) { throw "Expected <$Expected>, got <$Actual>." }
}

function Invoke-MessageCheck {
    param([string]$Name, [scriptblock]$Body)
    $script:checks++
    try {
        Remove-Item Env:AUTO_COMPANY_LANGUAGE -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $localPath -ErrorAction SilentlyContinue
        & $Body
        Write-Host "PASS: $Name"
    } catch {
        $script:failures += "${Name}: $_"
    }
}

try {
    Invoke-MessageCheck 'default Chinese is decoded as UTF-8 in both PowerShell editions' {
        Initialize-AutoCompanyMessages -RepoRoot $testRoot -CatalogPath $catalogPath
        $actual = Get-AutoCompanyMessage -Key $missingWsl
        Assert-Equal $actual $catalog.PSObject.Properties[$missingWsl].Value.'zh-CN'
        Assert-Equal ([int]$actual[0]) 0x672A
    }

    Invoke-MessageCheck 'repository language and environment precedence' {
        [System.IO.File]::WriteAllText($localPath, "# operator setting`nAUTO_COMPANY_LANGUAGE=en`nACTIVE_PROJECT=projects/example`n", $utf8)
        Initialize-AutoCompanyMessages -RepoRoot $testRoot -CatalogPath $catalogPath
        Assert-Equal (Get-AutoCompanyMessage -Key $missingWsl) $missingWsl
        $before = [System.IO.File]::ReadAllText($localPath)
        $env:AUTO_COMPANY_LANGUAGE = 'zh-CN'
        Initialize-AutoCompanyMessages -RepoRoot $testRoot -CatalogPath $catalogPath
        Assert-Equal (Get-AutoCompanyMessage -Key $missingWsl) $catalog.PSObject.Properties[$missingWsl].Value.'zh-CN'
        Assert-Equal ([System.IO.File]::ReadAllText($localPath)) $before
    }

    Invoke-MessageCheck 'explicit language aliases override display without changing environment' {
        $env:AUTO_COMPANY_LANGUAGE = 'zh-CN'
        foreach ($value in @('en', 'EN', 'En')) {
            Initialize-AutoCompanyMessages -RepoRoot $testRoot -CatalogPath $catalogPath -Language $value
            Assert-Equal (Get-AutoCompanyMessage -Key $missingWsl) $missingWsl
        }
        $env:AUTO_COMPANY_LANGUAGE = 'en'
        foreach ($value in @('zh-CN', 'zh-cn', 'ZH-CN')) {
            Initialize-AutoCompanyMessages -RepoRoot $testRoot -CatalogPath $catalogPath -Language $value
            Assert-Equal (Get-AutoCompanyMessage -Key $missingWsl) $catalog.PSObject.Properties[$missingWsl].Value.'zh-CN'
        }
        Assert-Equal $env:AUTO_COMPANY_LANGUAGE 'en'
    }

    Invoke-MessageCheck 'invalid languages fall back to original English diagnostics' {
        foreach ($value in @('invalid', 'EN', 'zh-cn', ' en ')) {
            $env:AUTO_COMPANY_LANGUAGE = $value
            Initialize-AutoCompanyMessages -RepoRoot $testRoot -CatalogPath $catalogPath
            Assert-Equal (Get-AutoCompanyMessage -Key $missingWsl) $missingWsl
        }
        Initialize-AutoCompanyMessages -RepoRoot $testRoot -CatalogPath $catalogPath -Language 'invalid'
        Assert-Equal (Get-AutoCompanyMessage -Key $missingWsl) $missingWsl
    }

    Invoke-MessageCheck 'malformed local config stays untouched and cannot execute code' {
        foreach ($contents in @('AUTO_COMPANY_LANGUAGE=invalid',
            "AUTO_COMPANY_LANGUAGE=zh-CN`nAUTO_COMPANY_LANGUAGE=en`n",
            'AUTO_COMPANY_LANGUAGE="en"', '$(throw ''must not execute'')',
            'export AUTO_COMPANY_LANGUAGE=en', "AUTO_COMPANY_LANGUAGE=zh-CN`nnot a setting")) {
            [System.IO.File]::WriteAllText($localPath, $contents, $utf8)
            Initialize-AutoCompanyMessages -RepoRoot $testRoot -CatalogPath $catalogPath
            Assert-Equal (Get-AutoCompanyMessage -Key $missingWsl) $missingWsl
            Assert-Equal ([System.IO.File]::ReadAllText($localPath)) $contents
        }
        [System.IO.File]::WriteAllBytes($localPath, [byte[]]@(0xFF, 0xFE, 0x00))
        Initialize-AutoCompanyMessages -RepoRoot $testRoot -CatalogPath $catalogPath
        Assert-Equal (Get-AutoCompanyMessage -Key $missingWsl) $missingWsl
    }

    Invoke-MessageCheck 'saved service settings do not override display selection or get rewritten' {
        $savedPath = Join-Path $testRoot '.auto-loop.env'
        $saved = "AUTO_COMPANY_LANGUAGE=en`nUSAGE_HARD_LIMIT_USD=12`n"
        [System.IO.File]::WriteAllText($savedPath, $saved, $utf8)
        Initialize-AutoCompanyMessages -RepoRoot $testRoot -CatalogPath $catalogPath
        Assert-Equal (Get-AutoCompanyMessage -Key $missingWsl) $catalog.PSObject.Properties[$missingWsl].Value.'zh-CN'
        Assert-Equal ([System.IO.File]::ReadAllText($savedPath)) $saved
    }

    Invoke-MessageCheck 'unavailable and malformed catalogs retain the original error' {
        Initialize-AutoCompanyMessages -RepoRoot $testRoot -CatalogPath (Join-Path $testRoot 'missing.json')
        Assert-Equal (Get-AutoCompanyMessage -Key $missingWsl) $missingWsl
        foreach ($contents in @('{broken json', '{}', '{"wsl.exe not found. Enable WSL first.": {"zh-CN": 7}}',
            '{"wsl.exe not found. Enable WSL first.": {"zh-CN": " "}}')) {
            [System.IO.File]::WriteAllText($brokenCatalogPath, $contents, $utf8)
            Initialize-AutoCompanyMessages -RepoRoot $testRoot -CatalogPath $brokenCatalogPath
            Assert-Equal (Get-AutoCompanyMessage -Key $missingWsl) $missingWsl
        }
        [System.IO.File]::WriteAllBytes($brokenCatalogPath, [byte[]]@(0xFF))
        Initialize-AutoCompanyMessages -RepoRoot $testRoot -CatalogPath $brokenCatalogPath
        Assert-Equal (Get-AutoCompanyMessage -Key $missingWsl) $missingWsl
    }

    Invoke-MessageCheck 'placeholders preserve literal paths, braces, dollar signs and raw errors' {
        $literal = 'C:\repo path\{1}\$HOME\$(throw ''must not execute'')'
        foreach ($language in @('en', 'zh-CN')) {
            Initialize-AutoCompanyMessages -RepoRoot $testRoot -CatalogPath $catalogPath -Language $language
            $actual = Get-AutoCompanyMessage -Key 'WSL command failed ({0}): {1}' -Values @(17, $literal)
            if (-not $actual.Contains($literal) -or -not $actual.Contains('17')) { throw 'Diagnostic content changed.' }
        }
        Assert-Equal (Get-AutoCompanyMessage -Key 'Unknown {0}: {1}' -Values @($literal, '$&')) ('Unknown ' + $literal + ': $&')
        Assert-Equal (Get-AutoCompanyMessage -Key '{0}/{1}' -Values @(0, '')) '0/'
        Assert-Equal (Get-AutoCompanyMessage -Key 'Unknown {9}' -Values @('value')) 'Unknown {9}'
    }

    Invoke-MessageCheck 'broken translated placeholders fall back without losing diagnostics' {
        [System.IO.File]::WriteAllText($brokenCatalogPath, '{"Failure {0}": {"zh-CN": "Failure {1}"}}', $utf8)
        Initialize-AutoCompanyMessages -RepoRoot $testRoot -CatalogPath $brokenCatalogPath
        Assert-Equal (Get-AutoCompanyMessage -Key 'Failure {0}' -Values @('raw error')) 'Failure raw error'
    }

    Invoke-MessageCheck 'blank translations retain the original diagnostic' {
        foreach ($blank in @('', '   ')) {
            $broken = @{ 'Failure' = @{ en = 'Failure'; 'zh-CN' = $blank } } | ConvertTo-Json
            [System.IO.File]::WriteAllText($brokenCatalogPath, $broken, $utf8)
            Initialize-AutoCompanyMessages -RepoRoot $testRoot -CatalogPath $brokenCatalogPath -Language 'zh-CN'
            Assert-Equal (Get-AutoCompanyMessage -Key 'Failure') 'Failure'
        }
    }

    Invoke-MessageCheck 'every catalog entry has both languages and matching placeholders' {
        foreach ($entry in $catalog.PSObject.Properties) {
            Assert-Equal $entry.Value.en $entry.Name
            if (-not $entry.Value.'zh-CN' -or $entry.Value.'zh-CN' -ceq $entry.Name) { throw "Missing Chinese: $($entry.Name)" }
            $expected = @([regex]::Matches($entry.Name, '\{[0-9]+\}') | ForEach-Object { $_.Value } | Sort-Object)
            $actual = @([regex]::Matches($entry.Value.'zh-CN', '\{[0-9]+\}') | ForEach-Object { $_.Value } | Sort-Object)
            Assert-Equal ($actual -join '|') ($expected -join '|')
        }
    }

    Invoke-MessageCheck 'all Windows message call sites use known catalog entries and parse safely' {
        foreach ($file in (Get-ChildItem -LiteralPath $windowsRoot -Filter '*.ps1')) {
            $tokens = $null
            $parseErrors = $null
            $ast = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors)
            if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
            $calls = $ast.FindAll({ param($node)
                $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Get-AutoCompanyMessage'
            }, $true)
            foreach ($call in $calls) {
                $key = $call.CommandElements[2].Value
                if (-not $catalog.PSObject.Properties[$key]) { throw "Unknown message in $($file.Name): $key" }
            }
        }
    }

    # Execute real entrypoints in a temporary checkout with a strict WSL mock
    # and inert guardian scripts. No real service, process or engine is invoked.
    $fixtureWindows = Join-Path $testRoot 'scripts/windows'
    $fixtureI18n = Join-Path $testRoot 'i18n'
    $null = New-Item -ItemType Directory -Path $fixtureWindows, $fixtureI18n -Force
    foreach ($name in @('start-win.ps1', 'stop-win.ps1', 'messages-win.ps1')) {
        Copy-Item -LiteralPath (Join-Path $windowsRoot $name) -Destination $fixtureWindows
    }
    Copy-Item -LiteralPath $catalogPath -Destination $fixtureI18n
    $guardian = 'param([string]$Action, [string]$Language, [string]$Distro, [string]$RepoWsl)' + "`n" +
        'Write-Output "GUARDIAN_LANGUAGE=$Language ACTION=$Action"; $global:LASTEXITCODE = 0'
    foreach ($name in @('awake-guardian-win.ps1', 'wsl-anchor-win.ps1')) {
        [System.IO.File]::WriteAllText((Join-Path $fixtureWindows $name), $guardian, $utf8)
    }
    $global:autoCompanyMessageWslFixture = @{ FailWsl = $false }
    function wsl.exe {
        $callArgs = @($args)
        if ($callArgs[0] -cne '-d' -or $callArgs[1] -cne 'Fixture') { throw 'Unexpected distro.' }
        if ($callArgs[2] -ceq 'wslpath') { $global:LASTEXITCODE = 0; return '/fixture' }
        if ($callArgs[2] -cne '--cd' -or $callArgs[3] -cne '/fixture' -or
            $callArgs[4] -cne 'bash' -or $callArgs[5] -cne '-lc') { throw 'Unexpected WSL invocation.' }
        if ($global:autoCompanyMessageWslFixture.FailWsl) {
            $global:LASTEXITCODE = 17
            return 'NATIVE ERROR {0} $HOME /raw path'
        }
        if ($callArgs[6] -notin @(
            'command -v systemctl >/dev/null 2>&1 && systemctl --user --version >/dev/null 2>&1',
            'systemctl --user cat auto-company.service >/dev/null 2>&1',
            'bash scripts/wsl/dashboard-wsl.sh check', 'bash scripts/wsl/dashboard-wsl.sh start',
            'bash scripts/wsl/dashboard-wsl.sh stop')) { throw 'Unexpected WSL command.' }
        $global:LASTEXITCODE = 0
    }

    Invoke-MessageCheck 'real start displays explicit English and preserves saved budget/config' {
        $env:AUTO_COMPANY_LANGUAGE = 'zh-CN'
        $output = @(& (Join-Path $fixtureWindows 'start-win.ps1') -Distro Fixture -Language EN 6>&1) | Out-String
        if (-not $output.Contains('WSL daemon started: auto-company.service') -or
            ($output.Split(@('GUARDIAN_LANGUAGE=en ACTION=start'), [StringSplitOptions]::None).Count - 1) -ne 2) {
            throw "Explicit start language did not reach success/guardians: $output"
        }
        $saved = [System.IO.File]::ReadAllText((Join-Path $testRoot '.auto-loop.env'))
        if (-not $saved.Contains('AUTO_COMPANY_LANGUAGE="en"') -or -not $saved.Contains('USAGE_HARD_LIMIT_USD=12')) {
            throw 'Language update lost existing service configuration.'
        }
        Assert-Equal $env:AUTO_COMPANY_LANGUAGE 'zh-CN'
    }

    Invoke-MessageCheck 'real start with no override reuses saved service environment unchanged' {
        [System.IO.File]::WriteAllText($localPath, 'AUTO_COMPANY_LANGUAGE=zh-CN', $utf8)
        $savedPath = Join-Path $testRoot '.auto-loop.env'
        $before = [System.IO.File]::ReadAllText($savedPath)
        $output = @(& (Join-Path $fixtureWindows 'start-win.ps1') -Distro Fixture 6>&1) | Out-String
        if (-not $output.Contains($catalog.PSObject.Properties['WSL daemon started: auto-company.service'].Value.'zh-CN') -or
            -not $output.Contains('GUARDIAN_LANGUAGE=zh-CN ACTION=start')) { throw 'Repository language was not used.' }
        Assert-Equal ([System.IO.File]::ReadAllText($savedPath)) $before
    }

    Invoke-MessageCheck 'real stop localizes the result and passes display language to guardians' {
        $env:AUTO_COMPANY_LANGUAGE = 'en'
        $output = @(& (Join-Path $fixtureWindows 'stop-win.ps1') -Distro Fixture 6>&1) | Out-String
        if (-not $output.Contains('WSL daemon stopped: auto-company.service') -or
            -not $output.Contains('GUARDIAN_LANGUAGE=en ACTION=stop')) { throw 'Stop result language was not preserved.' }
    }

    Invoke-MessageCheck 'real start preserves raw WSL failure before localized wrapper error' {
        $global:autoCompanyMessageWslFixture.FailWsl = $true
        try {
            $output = @(& {
                try { & (Join-Path $fixtureWindows 'start-win.ps1') -Distro Fixture -Language zh-CN }
                catch { Write-Output ('CAUGHT: ' + $_.Exception.Message) }
            } 6>&1) | Out-String
            if (-not $output.Contains('NATIVE ERROR {0} $HOME /raw path') -or
                -not $output.Contains('17') -or -not $output.Contains('command -v systemctl') -or
                -not $output.Contains('CAUGHT: ')) { throw "Raw failure was lost: $output" }
        } finally { $global:autoCompanyMessageWslFixture.FailWsl = $false }
    }
} finally {
    if ($null -eq $originalLanguage) { Remove-Item Env:AUTO_COMPANY_LANGUAGE -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable('AUTO_COMPANY_LANGUAGE', $originalLanguage) }
    Remove-Variable -Name autoCompanyMessageWslFixture -Scope Global -ErrorAction SilentlyContinue
    # Verify the absolute GUID fixture is inside TEMP before recursively deleting.
    $resolvedFixture = (Resolve-Path -LiteralPath $testRoot).Path
    if ($resolvedFixture -cne [System.IO.Path]::GetFullPath($testRoot) -or
        -not $resolvedFixture.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path -Leaf $resolvedFixture) -notmatch '^auto-company-messages-[0-9a-f-]+$') {
        throw 'Refusing to remove an unexpected fixture path.'
    }
    Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}

Write-Host "Windows message checks: $($script:checks - $script:failures.Count) passed, $($script:failures.Count) failed, 0 skipped"
if ($script:failures.Count) { throw ($script:failures -join "`n") }

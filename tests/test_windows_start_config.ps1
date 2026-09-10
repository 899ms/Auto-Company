$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot '../scripts/windows/start-win.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path $scriptPath).Path, [ref]$tokens, [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) { throw ($parseErrors | Out-String) }
$functionAst = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Write-AutoLoopEnv'
}, $true)
# Load only this pure configuration function; never invoke WSL or services.
. ([scriptblock]::Create($functionAst.Extent.Text))
$serviceFunction = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Start-AutoCompanyService'
}, $true)
. ([scriptblock]::Create($serviceFunction.Extent.Text))
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('auto-company-env-' + [guid]::NewGuid())
$null = New-Item -ItemType Directory -Path $testRoot
try {
    $envFile = Join-Path $testRoot '.auto-loop.env'
    $initial = "# operator settings`nUSAGE_HARD_LIMIT_USD=12`nCODEX_SANDBOX_MODE=read-only`nMODEL=old`n"
    [System.IO.File]::WriteAllText($envFile, $initial)
    Write-AutoLoopEnv -RepoWin $testRoot
    if ([System.IO.File]::ReadAllText($envFile) -cne $initial) {
        throw 'Start without explicit settings changed the existing environment.'
    }
    Write-AutoLoopEnv -RepoWin $testRoot -EnvLines @('MODEL=new model', 'CLAUDE_BIN=/home/user name/claude')
    $updated = [System.IO.File]::ReadAllText($envFile)
    foreach ($required in @('USAGE_HARD_LIMIT_USD=12', 'CODEX_SANDBOX_MODE=read-only',
                           'MODEL="new model"', 'CLAUDE_BIN="/home/user name/claude"')) {
        if (-not $updated.Contains($required)) { throw "Missing preserved/quoted setting: $required" }
    }
    if ($updated.Contains('MODEL=old')) { throw 'Explicit MODEL override was not applied.' }
    $rejected = $false
    try { Write-AutoLoopEnv -RepoWin $testRoot -EnvLines @("MODEL=ok`nENGINE=unsafe") }
    catch { $rejected = $true }
    if (-not $rejected) { throw 'Multiline environment injection was accepted.' }
    if ([System.IO.File]::ReadAllText($envFile) -cne $updated) {
        throw 'Rejected input modified the environment.'
    }
    $script:serviceInstalled = $false
    $script:serviceMismatched = $false
    $script:serviceCommands = [System.Collections.Generic.List[string]]::new()
    function Invoke-WslCommand {
        param([string]$RepoWsl, [string]$Command, [switch]$IgnoreExitCode)
        $script:serviceCommands.Add($Command)
        if ($Command -like 'systemctl --user cat*') {
            if ($script:serviceInstalled) { return 0 }
            return 1
        }
        if ($Command -like '*dashboard-wsl.sh check' -and $script:serviceMismatched) {
            throw 'WorkingDirectory mismatch'
        }
        if ($Command -eq 'make install' -or $Command -like '*dashboard-wsl.sh start') {
            $contents = [System.IO.File]::ReadAllText($envFile)
            if (-not $contents.Contains('ENGINE="codex"') -or
                -not $contents.Contains('USAGE_HARD_LIMIT_USD=12')) {
                throw 'Install/start ran before the selected engine and existing budget were persisted.'
            }
        }
        return 0
    }
    Start-AutoCompanyService -RepoWin $testRoot -RepoWsl '/fixture' -EnvLines @('ENGINE=codex')
    if (-not $script:serviceCommands.Contains('make install')) { throw 'First install was not exercised.' }
    $beforeMismatch = [System.IO.File]::ReadAllText($envFile)
    $script:serviceInstalled = $true
    $script:serviceMismatched = $true
    $script:serviceCommands.Clear()
    $rejected = $false
    try { Start-AutoCompanyService -RepoWin $testRoot -RepoWsl '/fixture' -EnvLines @('ENGINE=claude') }
    catch { $rejected = $true }
    if (-not $rejected -or [System.IO.File]::ReadAllText($envFile) -cne $beforeMismatch) {
        throw 'Mismatched installed service was allowed to change configuration.'
    }
    if ($script:serviceCommands.Contains('make install') -or
        $script:serviceCommands.Contains('bash scripts/wsl/dashboard-wsl.sh start')) {
        throw 'Mismatched installed service was controlled.'
    }
    Write-Host 'PASS: explicit Windows config merge, preserved budgets/safety, and multiline rejection'
    Write-Host 'PASS: first install sees chosen config; mismatched existing service causes no config/control writes'
} finally {
    # The GUID directory was created above and contains only this test's fixture.
    Remove-Item -LiteralPath $envFile -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $testRoot
}

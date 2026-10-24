# Dot-source in each consuming Windows shell; vendor state is process-local.
$ErrorActionPreference = 'Stop'
$nativeStage = 'allocation'
try {
    $nativeLocation = (Get-Location).Path
    if (-not $IsWindows -or [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -ne 'X64' -or [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'unavailable' }
    if ($env:RUNNER_OS -and $env:RUNNER_OS -ne 'Windows') { throw 'unavailable' }
    if ($env:RUNNER_ARCH -and $env:RUNNER_ARCH -ne 'X64') { throw 'unavailable' }
    $nativeStage = 'locator'
    $nativeVswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (-not (Test-Path -LiteralPath $nativeVswhere -PathType Leaf)) { throw 'unavailable' }
    $nativeStage = 'installation'
    $nativeInstallations = @(& $nativeVswhere -latest -products '*' -version '[17.0,18.0)' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null)
    if ($LASTEXITCODE -ne 0 -or $nativeInstallations.Count -ne 1 -or [string]::IsNullOrWhiteSpace($nativeInstallations[0]) -or -not [System.IO.Path]::IsPathFullyQualified($nativeInstallations[0]) -or -not (Test-Path -LiteralPath $nativeInstallations[0] -PathType Container)) { throw 'unavailable' }
    $nativeStage = 'vendor_entry'
    $nativeLaunch = Join-Path $nativeInstallations[0] 'Common7/Tools/Launch-VsDevShell.ps1'
    if (-not (Test-Path -LiteralPath $nativeLaunch -PathType Leaf)) { throw 'unavailable' }
    $LASTEXITCODE = 0
    & $nativeLaunch -Arch amd64 -HostArch amd64 -SkipAutomaticLocation 2>$null | Out-Null
    if (-not $? -or $LASTEXITCODE -ne 0) { throw 'unavailable' }
    $nativeStage = 'post_entry_arch'
    if ($env:VSCMD_ARG_HOST_ARCH -ne 'x64' -or $env:VSCMD_ARG_TGT_ARCH -ne 'x64') { throw 'unavailable' }
    $nativeStage = 'required_fields'
    if ([string]::IsNullOrWhiteSpace($env:VCToolsInstallDir) -or [string]::IsNullOrWhiteSpace($env:INCLUDE) -or [string]::IsNullOrWhiteSpace($env:LIB)) { throw 'unavailable' }
    $nativeStage = 'location'
    if ((Get-Location).Path -cne $nativeLocation) { throw 'unavailable' }
    foreach ($nativeName in @('cl.exe', 'link.exe')) {
        $nativeStage = if ($nativeName -eq 'cl.exe') { 'compiler_identity' } else { 'linker_identity' }
        $nativeExpected = Join-Path $env:VCToolsInstallDir "bin/Hostx64/x64/$nativeName"
        $nativeResolved = (Get-Command $nativeName -CommandType Application -ErrorAction Stop).Source
        if (-not (Test-Path -LiteralPath $nativeExpected -PathType Leaf) -or $nativeResolved -ine $nativeExpected) { throw 'unavailable' }
    }
} catch {
    if ($nativeStage -notin @('allocation', 'locator', 'installation', 'vendor_entry', 'post_entry_arch', 'required_fields', 'location', 'compiler_identity', 'linker_identity')) { $nativeStage = 'unknown' }
    throw "Native installed toolchain unavailable: $nativeStage"
}

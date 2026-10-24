param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
)

$ErrorActionPreference = 'Stop'
try {
    # The legacy .NET Framework default can emit backslashes in ZIP entries.
    [AppContext]::SetSwitch('Switch.System.IO.Compression.ZipFile.UseBackslash', $false)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($Source, $Destination)
} catch {
    exit 1
}

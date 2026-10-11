<#
.SYNOPSIS
    Compile et publie Organizator en un executable unique.

.DESCRIPTION
    Publication dependante du runtime .NET 8 installe sur la machine
    (SelfContained=false), en un seul fichier win-x64. Le resultat est
    publish\Organizator.exe.

    -SelfContained embarque le runtime .NET dans l'exe (rien a installer sur le
    poste, ~70 Mo au lieu de ~25). -Installer construit ensuite l'installateur
    publish\installer\Organizator-Setup-<version>.exe (Inno Setup 6, voir
    installer\Organizator.iss) ; il implique -SelfContained.

    La compilation passe toujours par la solution avec MSBuild 18 : invoquer
    MSBuild directement sur le .csproj ferait resoudre $(SolutionDir) au mauvais
    endroit.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File publish.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File publish.ps1 -Installer -Version 1.2.0
#>
[CmdletBinding()]
param(
    [string] $Configuration = 'Release',
    [string] $MSBuildPath = 'C:\Program Files\Microsoft Visual Studio\18\Professional\MSBuild\Current\Bin\amd64\MSBuild.exe',
    [switch] $KeepPrevious,
    [switch] $SelfContained,
    [switch] $Installer,
    [string] $Version = '',
    [string] $ISCCPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$solution = Join-Path $root 'Organizator.sln'
$publishDir = Join-Path $root 'publish'

if (-not (Test-Path -LiteralPath $MSBuildPath)) {
    throw "MSBuild introuvable : $MSBuildPath"
}
if (-not (Test-Path -LiteralPath $solution)) {
    throw "Solution introuvable : $solution"
}

if (-not $KeepPrevious -and (Test-Path -LiteralPath $publishDir)) {
    Write-Host "Nettoyage de $publishDir"
    Remove-Item -LiteralPath $publishDir -Recurse -Force
}

if ($Installer) { $SelfContained = $true }

# Ces proprietes doivent etre identiques a la restauration et a la publication :
# le RID conditionne les actifs restaures.
$props = @(
    "/p:Configuration=$Configuration"
    '/p:Platform=Any CPU'
    '/p:RuntimeIdentifier=win-x64'
    "/p:SelfContained=$(if ($SelfContained) { 'true' } else { 'false' })"
    '/p:PublishSingleFile=true'
    '/p:IncludeNativeLibrariesForSelfExtract=true'
    "/p:PublishDir=$publishDir\"
    '/p:_IsPublishing=true'
)
if ($SelfContained) {
    # Le runtime embarque est compresse dans l'exe (decompresse en memoire au lancement).
    $props += '/p:EnableCompressionInSingleFile=true'
}
if ($Version) {
    $props += "/p:Version=$Version"
}

Write-Host '--- Restauration ---'
& $MSBuildPath $solution '/t:Restore' @props '/v:m' '/nologo'
if ($LASTEXITCODE -ne 0) { throw "Echec de la restauration (code $LASTEXITCODE)." }

Write-Host '--- Compilation et publication ---'
& $MSBuildPath $solution '/t:Build;Publish' @props '/v:m' '/nologo'
if ($LASTEXITCODE -ne 0) { throw "Echec de la publication (code $LASTEXITCODE)." }

$exe = Join-Path $publishDir 'Organizator.exe'
if (-not (Test-Path -LiteralPath $exe)) {
    throw "L'executable attendu est absent : $exe"
}

$size = [Math]::Round((Get-Item -LiteralPath $exe).Length / 1MB, 2)
Write-Host ''
Write-Host "Publie : $exe ($size Mo)"
Get-ChildItem -LiteralPath $publishDir | Select-Object Name, Length | Format-Table -AutoSize

if ($Installer) {
    if (-not $ISCCPath) {
        $ISCCPath = @(
            (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe')
            (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
            (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
        ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    }
    if (-not $ISCCPath) {
        throw 'Inno Setup 6 introuvable (ISCC.exe) : winget install JRSoftware.InnoSetup, ou -ISCCPath.'
    }

    $appVersion = if ($Version) { $Version } else { (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion -replace '\+.*$', '' }
    Write-Host ''
    Write-Host "--- Installateur (version $appVersion) ---"
    & $ISCCPath "/DAppVersion=$appVersion" "/DPublishDir=$publishDir" (Join-Path $root 'installer\Organizator.iss')
    if ($LASTEXITCODE -ne 0) { throw "Echec de l'installateur (code $LASTEXITCODE)." }
    Get-ChildItem -LiteralPath (Join-Path $publishDir 'installer') | Select-Object Name, Length | Format-Table -AutoSize
}

<#
.SYNOPSIS
    Compile et publie Organizator en un executable unique.

.DESCRIPTION
    Publication dependante du runtime .NET 8 installe sur la machine
    (SelfContained=false), en un seul fichier win-x64. Le resultat est
    publish\Organizator.exe.

    La compilation passe toujours par la solution avec MSBuild 18 : invoquer
    MSBuild directement sur le .csproj ferait resoudre $(SolutionDir) au mauvais
    endroit.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File publish.ps1
#>
[CmdletBinding()]
param(
    [string] $Configuration = 'Release',
    [string] $MSBuildPath = 'C:\Program Files\Microsoft Visual Studio\18\Professional\MSBuild\Current\Bin\amd64\MSBuild.exe',
    [switch] $KeepPrevious
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

# Ces proprietes doivent etre identiques a la restauration et a la publication :
# le RID conditionne les actifs restaures.
$props = @(
    "/p:Configuration=$Configuration"
    '/p:Platform=Any CPU'
    '/p:RuntimeIdentifier=win-x64'
    '/p:SelfContained=false'
    '/p:PublishSingleFile=true'
    '/p:IncludeNativeLibrariesForSelfExtract=true'
    "/p:PublishDir=$publishDir\"
    '/p:_IsPublishing=true'
)

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

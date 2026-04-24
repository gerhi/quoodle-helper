# download-vendor.ps1
# Optional: refresh the JavaScript libraries that Quoodle Helper depends on.
# The libraries are already included in the repository under vendor/.
# Run this script only if you want to update to newer pinned versions.
#
#   powershell -ExecutionPolicy Bypass -File download-vendor.ps1

$ErrorActionPreference = 'Stop'

$vendorDir = Join-Path $PSScriptRoot 'vendor'
New-Item -ItemType Directory -Force -Path $vendorDir | Out-Null

$mammothVer = '1.9.0'
$jszipVer = '3.10.1'
$xlsxVer = '0.18.5'
$pdfjsVer = '4.7.76'
$tesseractVer = '5.0.5'

$cdnjs = 'https://cdnjs.cloudflare.com/ajax/libs'

$files = @(
  @{ Url = "$cdnjs/mammoth/$mammothVer/mammoth.browser.min.js"; Out = "$vendorDir\mammoth.browser.min.js" },
  @{ Url = "$cdnjs/jszip/$jszipVer/jszip.min.js";              Out = "$vendorDir\jszip.min.js" },
  @{ Url = "$cdnjs/xlsx/$xlsxVer/xlsx.full.min.js";            Out = "$vendorDir\xlsx.full.min.js" },
  @{ Url = "$cdnjs/pdf.js/$pdfjsVer/pdf.min.mjs";              Out = "$vendorDir\pdf.min.mjs" },
  @{ Url = "$cdnjs/pdf.js/$pdfjsVer/pdf.worker.min.mjs";       Out = "$vendorDir\pdf.worker.min.mjs" },
  @{ Url = "https://unpkg.com/tesseract.js@$tesseractVer/dist/tesseract.min.js"; Out = "$vendorDir\tesseract.min.js" }
)

Write-Host "Refreshing vendor libraries in $vendorDir ..."
foreach ($f in $files) {
  $name = Split-Path -Leaf $f.Out
  Write-Host "-> $name"
  Invoke-WebRequest -Uri $f.Url -OutFile $f.Out -UseBasicParsing
}

Write-Host ""
Write-Host "Done. Pinned versions:"
Write-Host "  mammoth.js  $mammothVer"
Write-Host "  JSZip       $jszipVer"
Write-Host "  SheetJS     $xlsxVer"
Write-Host "  pdf.js      $pdfjsVer"
Write-Host "  Tesseract   $tesseractVer"

#!/usr/bin/env bash
# download-vendor.sh
# Optional: refresh the JavaScript libraries that Quoodle Helper depends on.
# The libraries are already included in the repository under vendor/.
# Run this script only if you want to update to newer pinned versions.
#
#   bash download-vendor.sh
#
# The pinned versions below are what ships in the repo.

set -euo pipefail

VENDOR_DIR="$(dirname "$0")/vendor"
mkdir -p "$VENDOR_DIR"

# Pinned versions
MAMMOTH_VER="1.9.0"
JSZIP_VER="3.10.1"
XLSX_VER="0.18.5"
PDFJS_VER="4.7.76"
TESSERACT_VER="5.0.5"

CDNJS="https://cdnjs.cloudflare.com/ajax/libs"

declare -a FILES=(
  "$CDNJS/mammoth/$MAMMOTH_VER/mammoth.browser.min.js|$VENDOR_DIR/mammoth.browser.min.js"
  "$CDNJS/jszip/$JSZIP_VER/jszip.min.js|$VENDOR_DIR/jszip.min.js"
  "$CDNJS/xlsx/$XLSX_VER/xlsx.full.min.js|$VENDOR_DIR/xlsx.full.min.js"
  "$CDNJS/pdf.js/$PDFJS_VER/pdf.min.mjs|$VENDOR_DIR/pdf.min.mjs"
  "$CDNJS/pdf.js/$PDFJS_VER/pdf.worker.min.mjs|$VENDOR_DIR/pdf.worker.min.mjs"
  "https://unpkg.com/tesseract.js@${TESSERACT_VER}/dist/tesseract.min.js|$VENDOR_DIR/tesseract.min.js"
)

fetch() {
  local url="$1"
  local out="$2"
  local name
  name="$(basename "$out")"
  echo "→ $name"
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location -o "$out" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget --quiet -O "$out" "$url"
  else
    echo "ERROR: need either curl or wget on your system." >&2
    exit 1
  fi
}

echo "Refreshing vendor libraries in $VENDOR_DIR ..."
for entry in "${FILES[@]}"; do
  url="${entry%%|*}"
  out="${entry##*|}"
  fetch "$url" "$out"
done

echo ""
echo "Done. Pinned versions:"
echo "  mammoth.js  $MAMMOTH_VER"
echo "  JSZip       $JSZIP_VER"
echo "  SheetJS     $XLSX_VER"
echo "  pdf.js      $PDFJS_VER"
echo "  Tesseract   $TESSERACT_VER"

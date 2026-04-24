// js/extractors.js — File-to-text extraction
// All extraction runs in the browser.
// PDFs use pdf.js (loaded dynamically) and optionally OCR via Tesseract.js
// for image-only pages.
// DOCX uses mammoth. PPTX uses JSZip + XML parsing. TXT/MD are read as UTF-8.

// Lazy-loaded pdf.js — served locally from ./vendor/
//
// pdf.js needs two files: the main library (pdf.min.mjs) that runs in the
// page context, and a companion worker file (pdf.worker.min.mjs) that runs
// the actual PDF parsing off the main thread. Both must be in ./vendor/.
let _pdfjsLib = null;
let _tesseractPromise = null;

async function getPdfjs() {
  if (_pdfjsLib) return _pdfjsLib;
  try {
    _pdfjsLib = await import('../vendor/pdf.min.mjs');
  } catch (err) {
    throw new Error(
      'Could not load pdf.js from ./vendor/pdf.min.mjs. ' +
      'Ensure the file exists in the vendor directory.'
    );
  }
  _pdfjsLib.GlobalWorkerOptions.workerSrc =
    new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
  return _pdfjsLib;
}

async function getTesseract() {
  if (typeof window === 'undefined') {
    throw new Error('OCR not available in this environment.');
  }
  if (window.Tesseract) return window.Tesseract;
  if (_tesseractPromise) return _tesseractPromise;

  // Lazy-load Tesseract.js from local vendor folder. This avoids depending
  // on external CDNs at runtime while still only paying the cost when OCR
  // is actually needed.
  _tesseractPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'vendor/tesseract.min.js';
    script.async = true;
    script.onload = () => {
      if (window.Tesseract) resolve(window.Tesseract);
      else reject(new Error('Tesseract.js loaded but Tesseract global not found.'));
    };
    script.onerror = () => reject(new Error('Failed to load Tesseract.js from vendor/.'));
    document.head.appendChild(script);
  });

  return _tesseractPromise;
}

export const SUPPORTED_EXTENSIONS = ['pdf', 'docx', 'pptx', 'txt', 'md'];
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

export function detectType(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.docx')) return 'docx';
  if (name.endsWith('.pptx')) return 'pptx';
  if (name.endsWith('.txt')) return 'txt';
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'md';
  // MIME fallback
  const mime = (file.type || '').toLowerCase();
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx';
  if (mime.startsWith('text/')) return 'txt';
  return null;
}

/**
 * Extract text from a File. Returns { text, warnings } or throws.
 * Reports progress via the progress callback (0..1 or null).
 */
export async function extractText(file, onProgress = () => {}) {
  const type = detectType(file);
  if (!type) throw new Error('unsupported');
  if (file.size > MAX_FILE_SIZE) throw new Error('toolarge');

  switch (type) {
    case 'pdf':  return extractPdf(file, onProgress);
    case 'docx': return extractDocx(file);
    case 'pptx': return extractPptx(file);
    case 'txt':
    case 'md':   return extractText_(file);
  }
}

// ---------- PDF ----------

async function extractPdf(file, onProgress) {
  const pdfjs = await getPdfjs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  const parts = [];
  const warnings = [];
  let emptyPages = 0;
  let ocrPages = 0;
  const ocrFailures = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items
      .map(item => ('str' in item ? item.str : ''))
      .filter(s => s.length > 0);
    const pageText = strings.join(' ').replace(/\s+/g, ' ').trim();

    if (pageText.length === 0) {
      // Try OCR for scanned/image-only pages.
      try {
        const Tesseract = await getTesseract();
        const ocrText = await ocrPdfPage(page, Tesseract);
        if (ocrText && ocrText.trim().length > 0) {
          parts.push(`--- Page ${i} (OCR) ---\n\n${ocrText.trim()}`);
          ocrPages++;
        } else {
          emptyPages++;
        }
      } catch (err) {
        emptyPages++;
        ocrFailures.push(`Page ${i}: ${err.message}`);
      }
    } else {
      parts.push(`--- Page ${i} ---\n\n${pageText}`);
    }

    onProgress(i / pdf.numPages);
  }
  if (ocrPages > 0) {
    warnings.push(`OCR was used on ${ocrPages} page(s). Text quality may be limited.`);
  }
  if (emptyPages > 0) {
    warnings.push(`${emptyPages} page(s) had no extractable text (image-only, OCR unavailable or failed).`);
  }
  if (ocrFailures.length > 0) {
    warnings.push('OCR failed on some pages: ' + ocrFailures.join('; '));
  }
  const text = parts.join('\n\n');
  if (text.trim().length === 0) throw new Error('noText');
  return { text, warnings };
}

async function ocrPdfPage(page, Tesseract) {
  // Render page to an offscreen canvas at higher resolution for better OCR.
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context not available for OCR.');

  await page.render({ canvasContext: ctx, viewport }).promise;

  // Use a data URL so we don't have to manage blobs.
  const dataUrl = canvas.toDataURL('image/png');

  // Try common languages used in this app in one pass; Tesseract.js
  // will fetch language data as needed.
  const result = await Tesseract.recognize(dataUrl, 'eng+deu+fra');
  const raw = (result && result.data && result.data.text) || '';
  return raw.replace(/\s+\n/g, '\n');
}

// ---------- DOCX ----------

async function extractDocx(file) {
  if (typeof window.mammoth === 'undefined') {
    throw new Error('mammoth library not loaded');
  }
  const buf = await file.arrayBuffer();
  // Use Mammoth's convertToMarkdown for better structure preservation.
  const result = await window.mammoth.convertToMarkdown({ arrayBuffer: buf });
  const warnings = (result.messages || [])
    .filter(m => m.type === 'warning' || m.type === 'error')
    .map(m => m.message);
  const text = (result.value || '').trim();
  if (text.length === 0) throw new Error('noText');
  return { text, warnings };
}

// ---------- PPTX ----------

async function extractPptx(file) {
  if (typeof window.JSZip === 'undefined') {
    throw new Error('JSZip library not loaded');
  }
  const buf = await file.arrayBuffer();
  const zip = await window.JSZip.loadAsync(buf);
  const slideFiles = [];
  zip.forEach((path, f) => {
    const m = path.match(/^ppt\/slides\/slide(\d+)\.xml$/);
    if (m) slideFiles.push({ path, num: parseInt(m[1], 10), entry: f });
  });
  slideFiles.sort((a, b) => a.num - b.num);

  const parser = new DOMParser();
  const parts = [];
  const warnings = [];

  // Count images once across the whole archive (not per slide)
  let imageCount = 0;
  zip.forEach(p => {
    if (p.startsWith('ppt/media/')) imageCount++;
  });

  for (const sf of slideFiles) {
    const xml = await sf.entry.async('string');
    const doc = parser.parseFromString(xml, 'application/xml');
    // All <a:t> elements hold visible text.
    const tNodes = doc.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 't');
    const lines = [];
    for (const node of tNodes) {
      const txt = (node.textContent || '').trim();
      if (txt) lines.push(txt);
    }
    // Speaker notes, if present.
    const notesPath = `ppt/notesSlides/notesSlide${sf.num}.xml`;
    let notes = '';
    const notesEntry = zip.file(notesPath);
    if (notesEntry) {
      const notesXml = await notesEntry.async('string');
      const notesDoc = parser.parseFromString(notesXml, 'application/xml');
      const ntNodes = notesDoc.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 't');
      const noteLines = [];
      for (const n of ntNodes) {
        const t = (n.textContent || '').trim();
        // Skip the slide number that PPT often includes in notes
        if (t && !/^\d+$/.test(t)) noteLines.push(t);
      }
      if (noteLines.length > 0) notes = noteLines.join(' ');
    }

    const title = lines[0] || `Slide ${sf.num}`;
    let body = `--- Slide ${sf.num}: ${title} ---\n\n`;
    body += lines.slice(1).join('\n');
    if (notes) body += `\n\n[Notes: ${notes}]`;
    parts.push(body);
  }

  if (imageCount > 0) {
    warnings.push(`${imageCount} image(s) across slides were skipped.`);
  }
  const text = parts.join('\n\n').trim();
  if (text.length === 0) throw new Error('noText');
  return { text, warnings };
}

// ---------- TXT / MD ----------

async function extractText_(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Try UTF-8 first
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Fallback
    text = new TextDecoder('windows-1252').decode(bytes);
    return { text: text.trim(), warnings: ['File decoded as windows-1252 (not valid UTF-8).'] };
  }
  if (text.trim().length === 0) throw new Error('noText');
  return { text: text.trim(), warnings: [] };
}

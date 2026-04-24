// js/export.js — Excel (.xlsx) and CSV export

import { t } from './i18n.js';

function headers() {
  return [
    t('table.question'),
    t('table.correct'),
    t('table.wrong') + ' 1',
    t('table.wrong') + ' 2',
    t('table.wrong') + ' 3',
    t('table.explanation'),
    'Source',
  ];
}

function questionsToRows(questions) {
  return questions.map(q => [
    q.question,
    q.correct_answer,
    q.wrong_answers[0] || '',
    q.wrong_answers[1] || '',
    q.wrong_answers[2] || '',
    q.explanation,
    q.source_hint || '',
  ]);
}

function basenameFromSources(sources) {
  if (!sources || sources.length === 0) return 'quoodle-helper';
  // Accept both raw File objects (with .name) and SourceFile entries (with .file.name)
  const first = sources[0];
  const rawName = first?.file?.name ?? first?.name ?? 'export';
  const stripped = String(rawName).replace(/\.[^.]+$/, '');
  return stripped.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'quoodle-helper';
}

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------- XLSX ----------

export function exportXlsx(questions, sources) {
  if (typeof window.XLSX === 'undefined') {
    throw new Error('XLSX library not loaded');
  }
  const rows = [headers(), ...questionsToRows(questions)];
  const ws = window.XLSX.utils.aoa_to_sheet(rows);

  // Column widths
  ws['!cols'] = [
    { wch: 50 }, // Question
    { wch: 30 }, // Correct
    { wch: 30 }, // Wrong 1
    { wch: 30 }, // Wrong 2
    { wch: 30 }, // Wrong 3
    { wch: 60 }, // Explanation
    { wch: 15 }, // Source
  ];

  // Bold header row, wrap-text on everything
  const range = window.XLSX.utils.decode_range(ws['!ref']);
  for (let C = range.s.c; C <= range.e.c; C++) {
    const headerCell = ws[window.XLSX.utils.encode_cell({ r: 0, c: C })];
    if (headerCell) {
      headerCell.s = { font: { bold: true }, alignment: { wrapText: true, vertical: 'top' } };
    }
  }
  for (let R = 1; R <= range.e.r; R++) {
    for (let C = range.s.c; C <= range.e.c; C++) {
      const cell = ws[window.XLSX.utils.encode_cell({ r: R, c: C })];
      if (cell) {
        cell.s = { alignment: { wrapText: true, vertical: 'top' } };
      }
    }
  }

  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, 'Questions');

  const filename = `quoodle-helper-${basenameFromSources(sources)}-${timestamp()}.xlsx`;
  window.XLSX.writeFile(wb, filename);
}

// ---------- CSV ----------

export function exportCsv(questions, sources) {
  const rows = [headers(), ...questionsToRows(questions)];
  const csv = rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
  const bom = '\uFEFF';
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });

  const filename = `quoodle-helper-${basenameFromSources(sources)}-${timestamp()}.csv`;
  triggerDownload(blob, filename);
}

function csvEscape(v) {
  const s = String(v ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

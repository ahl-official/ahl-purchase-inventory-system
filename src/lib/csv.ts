// The leading quote neutralises spreadsheet formulas (=, +, -, @) in user-typed text.
const cell = (v: unknown) => {
  const s = String(v ?? "");
  return '"' + (/^[=+@\-\t\r]/.test(s) ? "'" : "") + s.replaceAll('"', '""') + '"';
};

export function downloadCsv(rows: unknown[][], filename: string) {
  const blob = new Blob(["﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

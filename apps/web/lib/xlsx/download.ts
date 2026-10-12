import { XLSX_MIME } from './write';

/** Baja un archivo desde el navegador. */
export function downloadBytes(name: string, bytes: Uint8Array | string, mime = XLSX_MIME): void {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

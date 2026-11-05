/** Utilidades de archivos del navegador (fotos y documentos). */

export const MAX_ESCANEO = 4 * 1024 * 1024;

/**
 * Reduce una foto grande (lado mayor `lado` px, JPEG) para que suba rápido con
 * mala señal y quepa en el límite del escaneo. Los PDF y lo que no se pueda leer
 * pasan sin tocar.
 */
export async function reducirImagen(file: File, lado = 1800, calidad = 0.82): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise<HTMLImageElement>((ok, mal) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => mal(new Error('imagen'));
      i.src = url;
    });
    URL.revokeObjectURL(url);
    const escala = Math.min(1, lado / Math.max(img.naturalWidth, img.naturalHeight));
    if (escala >= 1 && file.size <= MAX_ESCANEO) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * escala);
    c.height = Math.round(img.naturalHeight * escala);
    c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/jpeg', calidad));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

export const tamanoTxt = (b: number): string => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

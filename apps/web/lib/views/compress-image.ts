/**
 * Comprime una foto en el navegador antes de subirla: lado mayor 1920 px, JPEG
 * calidad 0.8. Una foto de celular pesa 4-8 MB y el operario está con datos
 * móviles en una bodega; comprimida queda en ~300 KB sin perder lo que se lee.
 *
 * La orientación EXIF se aplica al dibujar (`imageOrientation: 'from-image'`),
 * y como el JPEG de salida ya sale derecho y sin EXIF, no se pierde ni se
 * duplica. Si el navegador no decodifica el archivo (HEIC en casi todo salvo
 * Safari) o la compresión no gana nada, se devuelve el archivo original.
 */

const MAX_SIDE = 1920;
const QUALITY = 0.8;

export async function compressImage(file: File): Promise<File> {
  if (typeof document === 'undefined' || !file.type.startsWith('image/')) return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    // Fondo blanco: un PNG con transparencia no debe quedar negro en JPEG.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob((b) => res(b), 'image/jpeg', QUALITY),
    );
    if (!blob || (blob.size >= file.size && scale === 1)) return file;
    const name = `${file.name.replace(/\.[^.]+$/, '') || 'foto'}.jpg`;
    return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
  } catch {
    return file;
  }
}

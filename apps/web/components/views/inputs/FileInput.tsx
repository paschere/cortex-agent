'use client';

import { appApiBase } from '@/lib/apps/api-base';
import { compressImage } from '@/lib/views/compress-image';
import { isPendingUrl, previewUrl, stashBlob } from '@/lib/views/offline-files';
import {
  type FileAccept,
  MAX_FILES_PER_FIELD,
  type UploadedFile,
  acceptAttribute,
  checkUpload,
  parseFileValue,
  serializeFileValue,
} from '@/lib/views/upload-rules';
import { clsx } from 'clsx';
import { Camera, FileText, ImageIcon, Loader2, Paperclip, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import type { SubmitTarget } from '../ViewCanvas';

/**
 * El campo `file` de un formulario de vista. Fotos: «Tomar foto» (cámara
 * trasera) y «Elegir de la galería»; cualquier archivo: «Adjuntar archivo».
 * La foto se comprime en el navegador, se sube a /upload (con sesión o con el
 * token del enlace) y el valor del campo queda como JSON {url,name,mime,size}
 * (un arreglo si es múltiple, hasta 5). En preview y demo no se sube nada:
 * se guarda una URL local del navegador.
 */

export interface FileInputProps {
  value: string;
  onChange: (v: string) => void;
  accept: FileAccept;
  multiple?: boolean;
  target: SubmitTarget;
  blockId: string;
  field: string;
  disabled?: boolean;
  /** Modo operario: botones de 56 px. */
  large?: boolean;
}

/** La subida falló por falta de red (no porque el servidor la rechazara). */
export class OfflineUploadError extends Error {}

export function uploadFile(
  target: SubmitTarget,
  blockId: string,
  field: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<UploadedFile> {
  if (target.kind === 'preview' || target.kind === 'demo')
    return Promise.resolve({
      url: URL.createObjectURL(file),
      name: file.name,
      mime: file.type,
      size: file.size,
    });
  const form = new FormData();
  if (target.kind === 'public') form.set('token', target.token);
  form.set('blockId', blockId);
  form.set('field', field);
  form.set('file', file, file.name);
  const url =
    target.kind === 'app'
      ? `/api/views/${target.viewId}/upload`
      : target.kind === 'custom_app'
        ? `${appApiBase(target)}/screens/${target.screen}/upload`
        : '/api/views/public/upload';
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) =>
      e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onerror = () =>
      reject(new OfflineUploadError('Sin conexión. Revisa tu internet e inténtalo otra vez.'));
    xhr.onload = () => {
      let body: (Partial<UploadedFile> & { error?: string }) | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && body?.url) return resolve(body as UploadedFile);
      reject(new Error(body?.error ?? 'No se pudo subir el archivo.'));
    };
    xhr.send(form);
  });
}

export function FileInput({
  value,
  onChange,
  accept,
  multiple = false,
  target,
  blockId,
  field,
  disabled,
  large,
}: FileInputProps) {
  const id = useId();
  const cameraRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<{ name: string; pct: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const files = parseFileValue(value);
  const max = multiple ? MAX_FILES_PER_FIELD : 1;
  const full = files.length + busy.length >= max;

  async function handle(list: FileList | null) {
    if (!list?.length) return;
    setError(null);
    let current = files;
    const picked = Array.from(list).slice(0, max - current.length - busy.length);
    if (list.length > picked.length) setError(`Máximo ${max} archivo${max > 1 ? 's' : ''}.`);
    for (const original of picked) {
      const pre = checkUpload(original, accept);
      if (!pre.ok && !original.type.startsWith('image/')) {
        setError(pre.error);
        continue;
      }
      const file = original.type.startsWith('image/') ? await compressImage(original) : original;
      const check = checkUpload(file, accept);
      if (!check.ok) {
        setError(check.error);
        continue;
      }
      const slot = { name: file.name, pct: 0 };
      setBusy((b) => [...b, slot]);
      // Sin señal: la foto se guarda en el teléfono y sube al enviar el registro.
      const saveHere = async () => {
        const kept = await stashBlob(file as File);
        current = multiple ? [...current, kept] : [kept];
        onChange(serializeFileValue(current, multiple));
      };
      try {
        if (
          (target.kind === 'app' || target.kind === 'custom_app' || target.kind === 'public') &&
          typeof navigator !== 'undefined' &&
          !navigator.onLine
        ) {
          await saveHere();
          continue;
        }
        const done = await uploadFile(target, blockId, field, file, (pct) => {
          slot.pct = pct;
          setBusy((b) => [...b]);
        });
        current = multiple ? [...current, done] : [done];
        onChange(serializeFileValue(current, multiple));
      } catch (e) {
        if (e instanceof OfflineUploadError) await saveHere();
        else setError(e instanceof Error ? e.message : 'No se pudo subir el archivo.');
      } finally {
        setBusy((b) => b.filter((x) => x !== slot));
      }
    }
  }

  function remove(url: string) {
    onChange(
      serializeFileValue(
        files.filter((f) => f.url !== url),
        multiple,
      ),
    );
  }

  const btn = clsx(
    'inline-flex flex-1 items-center justify-center gap-2 rounded-xl border-2 border-primary/40 bg-primary/5 px-4 font-bold text-primary transition-colors hover:bg-primary/10 disabled:opacity-50',
    large ? 'min-h-14 text-base' : 'min-h-11 text-sm',
  );
  const off = disabled || full;

  return (
    <div className="flex flex-col gap-2">
      {!full && (
        <div className="flex flex-wrap gap-2">
          {accept === 'image' ? (
            <>
              <button
                type="button"
                className={btn}
                disabled={off}
                onClick={() => cameraRef.current?.click()}
              >
                <Camera className="h-5 w-5" aria-hidden />
                Tomar foto
              </button>
              <button
                type="button"
                className={btn}
                disabled={off}
                onClick={() => pickRef.current?.click()}
              >
                <ImageIcon className="h-5 w-5" aria-hidden />
                Elegir de la galería
              </button>
            </>
          ) : (
            <button
              type="button"
              className={btn}
              disabled={off}
              onClick={() => pickRef.current?.click()}
            >
              <Paperclip className="h-5 w-5" aria-hidden />
              Adjuntar archivo
            </button>
          )}
        </div>
      )}
      <input
        ref={cameraRef}
        id={`${id}-cam`}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          void handle(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={pickRef}
        id={`${id}-pick`}
        type="file"
        accept={acceptAttribute(accept)}
        multiple={multiple}
        hidden
        onChange={(e) => {
          void handle(e.target.files);
          e.target.value = '';
        }}
      />

      {(files.length > 0 || busy.length > 0) && (
        <ul className="flex flex-wrap gap-2">
          {files.map((f) => (
            <li key={f.url} className="relative">
              {f.mime.startsWith('image/') && (previewUrl(f.url) ?? !isPendingUrl(f.url)) ? (
                <img
                  src={previewUrl(f.url) ?? f.url}
                  alt={f.name}
                  className="h-20 w-20 rounded-lg border border-border object-cover"
                />
              ) : (
                <span className="flex h-20 w-28 flex-col items-center justify-center gap-1 rounded-lg border border-border p-1 text-center text-xs">
                  <FileText className="h-6 w-6" aria-hidden />
                  <span className="w-full truncate">{f.name}</span>
                </span>
              )}
              <button
                type="button"
                onClick={() => remove(f.url)}
                disabled={disabled}
                aria-label={`Quitar ${f.name}`}
                className="absolute -right-2 -top-2 flex h-8 w-8 items-center justify-center rounded-full bg-ink text-white shadow"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
              {isPendingUrl(f.url) && (
                <span className="mt-1 block max-w-[5rem] text-micro leading-tight text-amber">
                  Se sube al enviar
                </span>
              )}
            </li>
          ))}
          {busy.map((b) => (
            <li
              key={b.name + b.pct}
              className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-lg border border-border text-xs"
              aria-live="polite"
            >
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
              <span className="tabular">{b.pct}%</span>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-xs text-rose">
          {error}
        </p>
      )}
    </div>
  );
}

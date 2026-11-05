import { useRef, useState } from 'react';
import { cortex } from '@cortex/app-sdk';
import { Mic, Square } from 'lucide-react';
import { Boton, SelectorArchivo, avisar, mensajeDe } from './ui';

/**
 * Dictado por voz: graba con el micrófono y manda el audio a `voice.transcribe`.
 * Si el marco no deja usar el micrófono, se ofrece grabar con la grabadora del
 * teléfono (selector de archivo de audio). El texto se añade al campo.
 */
export function Dictado({ onTexto, grande }: { onTexto: (t: string) => void; grande?: boolean }) {
  const [grabando, setGrabando] = useState(false);
  const [trabajando, setTrabajando] = useState(false);
  const [sinMic, setSinMic] = useState(false);
  const rec = useRef<MediaRecorder | null>(null);
  const trozos = useRef<Blob[]>([]);

  const transcribir = async (audio: Blob) => {
    setTrabajando(true);
    try {
      const r = await cortex.voice.transcribe(audio);
      if (r.text.trim()) onTexto(r.text.trim());
      else avisar('No se entendió el audio. Intenta de nuevo.');
    } catch (e) {
      avisar(mensajeDe(e));
    } finally {
      setTrabajando(false);
    }
  };

  const empezar = async () => {
    try {
      const flujo = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(flujo);
      trozos.current = [];
      mr.ondataavailable = (e) => e.data.size && trozos.current.push(e.data);
      mr.onstop = () => {
        for (const p of flujo.getTracks()) p.stop();
        void transcribir(new Blob(trozos.current, { type: mr.mimeType || 'audio/webm' }));
      };
      rec.current = mr;
      mr.start();
      setGrabando(true);
    } catch {
      setSinMic(true);
    }
  };

  const parar = () => {
    rec.current?.stop();
    setGrabando(false);
  };

  if (sinMic) {
    return (
      <SelectorArchivo
        etiqueta={trabajando ? 'Transcribiendo…' : 'Grabar nota de voz'}
        accept="audio/*"
        camara="user"
        disabled={trabajando}
        onArchivos={(f) => f[0] && void transcribir(f[0])}
      />
    );
  }
  return (
    <Boton
      chico={!grande}
      tono={grabando ? 'malo' : undefined}
      disabled={trabajando}
      onClick={grabando ? parar : () => void empezar()}
      icono={grabando ? <Square size={16} /> : <Mic size={16} />}
    >
      {trabajando ? 'Transcribiendo…' : grabando ? 'Parar' : 'Dictar'}
    </Boton>
  );
}

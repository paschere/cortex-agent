import { useEffect, useState } from 'react';

/**
 * «Actualizado hace Xs»: cada lectura buena de datos (useCarga) marca la hora; la cabecera de cada
 * pantalla la muestra y avisa si el dato está viejo. No cambia nada de lo que se lee.
 */
let ultima = 0;
const oyentes = new Set<() => void>();

export function marcarCarga(): void {
  ultima = Date.now();
  for (const f of oyentes) f();
}

export function useVivo(): { hace: number | null } {
  const [, setN] = useState(0);
  useEffect(() => {
    const f = () => setN((n) => n + 1);
    oyentes.add(f);
    const t = setInterval(f, 5000);
    return () => {
      oyentes.delete(f);
      clearInterval(t);
    };
  }, []);
  return { hace: ultima ? Math.max(0, Math.round((Date.now() - ultima) / 1000)) : null };
}

export function textoHace(seg: number): string {
  if (seg < 5) return 'ahora mismo';
  if (seg < 60) return `hace ${Math.round(seg / 5) * 5} s`;
  const m = Math.floor(seg / 60);
  return m < 60 ? `hace ${m} min` : `hace ${Math.floor(m / 60)} h`;
}

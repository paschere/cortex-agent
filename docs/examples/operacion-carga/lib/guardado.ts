import { useCallback, useState } from 'react';

/**
 * Filtro guardado: recuerda la última elección de la persona en este aparato. El almacenamiento del
 * navegador puede no estar disponible dentro del marco; en ese caso simplemente no se recuerda.
 */
export function useGuardado<T extends string>(clave: string, inicial: T, validos?: readonly T[]): [T, (v: T) => void] {
  const leer = (): T => {
    try {
      const v = window.localStorage.getItem(`oc:${clave}`);
      if (v && (!validos || (validos as readonly string[]).includes(v))) return v as T;
    } catch {
      /* sin almacenamiento */
    }
    return inicial;
  };
  const [valor, setValor] = useState<T>(leer);
  const poner = useCallback(
    (v: T) => {
      setValor(v);
      try {
        window.localStorage.setItem(`oc:${clave}`, v);
      } catch {
        /* sin almacenamiento */
      }
    },
    [clave],
  );
  return [valor, poner];
}

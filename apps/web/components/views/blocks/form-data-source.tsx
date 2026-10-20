'use client';

import type { Suggestion } from '@cortex/agent-tools/src/trackers/autofill-shape';
import { createContext, useContext } from 'react';

/**
 * DE DÓNDE SALEN LAS OPCIONES Y LA LECTURA DE FOTOS DE UN FORMULARIO.
 *
 * Por omisión, de las rutas del servidor (relación, escaneo). El escaparate de
 * desarrollo (/v/formularios-showcase) pone aquí datos de mentira para poder
 * mirar y probar el formulario sin sesión ni base. Fuera de eso no se usa.
 */

export interface RelationOption {
  id: string;
  label: string;
  /** Un dato corto para reconocer la fila («Medellín · activo»). */
  detail?: string;
  /** Lo que traen los campos «traídos» de esta relación. */
  pick?: Record<string, string | number>;
}

export interface ScanResponse {
  suggestions: Record<string, Suggestion>;
  read: number;
  note: string | null;
}

export interface FormDataSource {
  relation?: {
    search: (field: string, q: string) => Promise<RelationOption[]>;
    create?: (field: string, label: string) => Promise<RelationOption>;
  };
  scan?: (image: Blob) => Promise<ScanResponse>;
}

const Ctx = createContext<FormDataSource | null>(null);

export function FormDataSourceProvider({
  value,
  children,
}: {
  value: FormDataSource;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFormDataSource(): FormDataSource | null {
  return useContext(Ctx);
}

export function canClassifyFinanceSource(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

export function classifySourceError(code: string | undefined): { status: number; error: string } {
  if (code === '42501') return { status: 403, error: 'No tienes permiso para clasificar fuentes.' };
  if (code === 'P0002')
    return { status: 404, error: 'La fuente no existe o no es visible en esta empresa.' };
  if (code === '40001')
    return {
      status: 409,
      error: 'La fuente cambió mientras la revisabas. Recarga e inténtalo de nuevo.',
    };
  if (code === '22023')
    return {
      status: 422,
      error: 'Esta combinación de tipo, dominio y rol financiero no es válida.',
    };
  return { status: 500, error: 'No se pudo guardar la clasificación.' };
}

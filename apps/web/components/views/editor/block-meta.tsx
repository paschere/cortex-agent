import { BLOCK_LABEL } from '@/lib/views/editor-shape';
import {
  CalendarDays,
  ChartColumn,
  ClipboardList,
  FileText,
  GalleryVerticalEnd,
  Hash,
  ImageIcon,
  LayoutGrid,
  Link2,
  ListFilter,
  type LucideIcon,
  Map as MapIcon,
  MapPinned,
  Mic,
  SquareKanban,
  Table2,
  Target,
  Type,
} from 'lucide-react';

/** El icono y el nombre de cada tipo de bloque, iguales en la paleta, el marco y el inspector. */
export const BLOCK_ICON: Record<string, LucideIcon> = {
  metric: Hash,
  table: Table2,
  chart: ChartColumn,
  board: SquareKanban,
  zones: MapPinned,
  form: ClipboardList,
  text: Type,
  gallery: GalleryVerticalEnd,
  calendar: CalendarDays,
  cards: ListFilter,
  map: MapIcon,
  detail: FileText,
  progress: Target,
  media: ImageIcon,
  links: Link2,
  voice: Mic,
};

export function blockIcon(type: string): LucideIcon {
  return BLOCK_ICON[type] ?? LayoutGrid;
}

export function blockLabel(type: string): string {
  return BLOCK_LABEL[type] ?? 'Bloque';
}

/** Lo que dice la paleta de cada plantilla: qué es, en una línea, sin tecnicismos. */
export const BLOCK_PITCH: Record<string, string> = {
  metric: 'Un número grande: un total, un conteo, un promedio.',
  table: 'Una lista con buscador, ordenada como quieras.',
  chart: 'Barras, línea en el tiempo o dona por categoría.',
  board: 'Tarjetas en columnas por estado; se pueden arrastrar.',
  zones: 'Un plano del lugar: cada zona con lo que hay adentro.',
  form: 'Para que alguien agregue una fila sin entrar a la tabla.',
  text: 'Un título o una explicación corta.',
  gallery: 'Tarjetas en rejilla, con foto y etiqueta: productos, inmuebles, pacientes.',
  calendar:
    'Citas, entregas o vencimientos por día, semana o mes, con la hora y el color del estado.',
  cards: 'Tarjetas grandes con buscador y chips: estado, hoy, esta semana, mías.',
  map: 'Un mapa con los registros que tienen lugar y, en una app, las personas en turno; desde ahí se asignan tareas.',
  detail: 'La pantalla de UN registro: datos, relacionados y su línea de tiempo.',
  progress: 'Barras de avance hacia una meta, en total o por sede, vendedor o ruta.',
  media: 'Una imagen, o un video de YouTube o Loom, un mapa o una presentación.',
  links: 'Botones que llevan a otra vista o a una página.',
  voice: 'Un panel grande para llenar un formulario hablando, manos libres.',
};

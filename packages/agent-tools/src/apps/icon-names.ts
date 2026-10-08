/**
 * Los íconos que una app puede usar: nombres de lucide de esta lista, o un
 * emoji. Sin servidor ni lucide: lo comparten las herramientas (que normalizan
 * lo que el modelo escribe) y el navegador (que los dibuja).
 *
 * Cualquier otro nombre —«LayoutDashboard» antes de estar aquí, «layout-grid»,
 * «icon»— terminaba pintado como TEXTO encima del título de la pantalla.
 */
export const APP_ICON_NAMES = [
  'LayoutPanelTop',
  'LayoutDashboard',
  'LayoutGrid',
  'Home',
  'ClipboardPlus',
  'ClipboardList',
  'ClipboardCheck',
  'ListChecks',
  'BadgeCheck',
  'CheckCircle2',
  'AlertTriangle',
  'BarChart3',
  'LineChart',
  'PieChart',
  'Table2',
  'FileText',
  'Folder',
  'Inbox',
  'Camera',
  'ScanLine',
  'QrCode',
  'Truck',
  'Plane',
  'Ship',
  'Car',
  'Route',
  'Navigation',
  'Map',
  'MapPin',
  'Package',
  'Boxes',
  'Warehouse',
  'Store',
  'ShoppingCart',
  'Receipt',
  'Wallet',
  'DollarSign',
  'Users',
  'User',
  'Building2',
  'Briefcase',
  'Calendar',
  'CalendarClock',
  'Clock',
  'Timer',
  'Bell',
  'MessageSquare',
  'Phone',
  'Mail',
  'Wrench',
  'Hammer',
  'Settings',
  'Tag',
  'Star',
  'Heart',
  'Search',
  'Stethoscope',
  'GraduationCap',
  'Utensils',
  'Leaf',
  'Zap',
  'Fuel',
] as const;

export type AppIconName = (typeof APP_ICON_NAMES)[number];

export const DEFAULT_APP_ICON: AppIconName = 'LayoutPanelTop';

const BY_KEY = new Map<string, AppIconName>(APP_ICON_NAMES.map((n) => [n.toLowerCase(), n]));

/** Parecidos que el modelo escribe y que no están tal cual en la lista. */
const ALIASES: Record<string, AppIconName> = {
  dashboard: 'LayoutDashboard',
  layout: 'LayoutPanelTop',
  clipboard: 'ClipboardList',
  barchart: 'BarChart3',
  barchart2: 'BarChart3',
  chart: 'BarChart3',
  piechart2: 'PieChart',
  checkcircle: 'CheckCircle2',
  circlecheck: 'CheckCircle2',
  check: 'CheckCircle2',
  alert: 'AlertTriangle',
  triangleAlert: 'AlertTriangle',
  trianglealert: 'AlertTriangle',
  calendardays: 'Calendar',
  calendarcheck: 'Calendar',
  plane: 'Plane',
  planelanding: 'Plane',
  planetakeoff: 'Plane',
  box: 'Package',
  building: 'Building2',
  file: 'FileText',
  list: 'ListChecks',
  listtodo: 'ListChecks',
  table: 'Table2',
  settings2: 'Settings',
  usercircle: 'User',
  mappinned: 'MapPin',
};

/** Emoji u otro símbolo que no es un nombre: se deja como está. */
function isSymbol(raw: string): boolean {
  return !/^[A-Za-z][A-Za-z0-9_\- ]*$/.test(raw);
}

/**
 * Lo que se guarda: un nombre de la lista, un emoji, o el ícono por defecto.
 * Nunca un nombre que el navegador no sepa dibujar.
 */
export function normalizeAppIcon(raw: string | null | undefined): string {
  const value = (raw ?? '').trim().slice(0, 60);
  if (!value) return DEFAULT_APP_ICON;
  if (isSymbol(value)) return value;
  const key = value.replace(/[-_ ]/g, '').toLowerCase();
  return BY_KEY.get(key) ?? ALIASES[key] ?? DEFAULT_APP_ICON;
}

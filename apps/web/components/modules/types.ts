/**
 * Las acciones de servidor que piden las pantallas de módulos, pasadas como
 * props: así la página de verdad y la de muestra (/v/modulos-showcase) dibujan
 * los mismos componentes con acciones distintas.
 */
export interface ModuleActionResult {
  ok: boolean;
  note: string;
}

export interface ModuleActions {
  toggle: (key: string, enabled: boolean) => Promise<ModuleActionResult>;
  previewPreset: (
    preset: string,
  ) => Promise<{ ok: boolean; note: string; on: string[]; off: string[] }>;
  applyPreset: (preset: string) => Promise<ModuleActionResult>;
}

/** Un preset, como lo dibuja la pantalla. */
export interface PresetOption {
  key: string;
  label: string;
  examples: string;
}

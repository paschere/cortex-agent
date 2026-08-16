import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listTools } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import { CAPABILITY_GROUPS, FAMILY_META, familyOf, groupOfFamily } from './tool-taxonomy';

/**
 * LA TAXONOMÍA ES UNA COPIA A MANO DEL REGISTRO, Y LAS COPIAS DERIVAN EN
 * SILENCIO. Ese es el punto entero de este archivo.
 *
 * Cuando una familia nueva no se mapea, nada se rompe: `familyMeta` inventa un
 * nombre con la clave en title case y un resumen en inglés, y `groupOfFamily`
 * la deja caer en «Otras herramientas». Todo se dibuja, nada falla, y el
 * resultado es que las diecisiete herramientas de cartera y papeles —cartera
 * incluida, que es la pregunta más de empresa que contesta el producto—
 * estuvieron meses en el cajón de sastre de dos pantallas distintas sin que
 * saliera un error en ningún sitio.
 */
describe('la taxonomía contra el registro real', () => {
  const families = [
    ...new Set(
      listTools()
        .map((tool) => tool.id)
        .filter((id) => !id.startsWith('test.'))
        .map(familyOf),
    ),
  ].sort();

  it('toda familia registrada tiene su ficha en español', () => {
    expect(families.filter((family) => !FAMILY_META[family])).toEqual([]);
  });

  it('ninguna familia registrada cae en «Otras herramientas»', () => {
    expect(families.filter((family) => groupOfFamily(family) === 'other')).toEqual([]);
  });

  it('un grupo sin ninguna familia detrás no debería existir', () => {
    // «Otras» es la red de seguridad y `mcp`/`custom` no vienen del registro;
    // los demás tienen que estar poblados o son una sección que nunca se dibuja.
    const exempt = new Set(['other', 'mcp', 'custom']);
    const used = new Set(families.map(groupOfFamily));
    const empty = CAPABILITY_GROUPS.map((g) => g.id).filter(
      (id) => !exempt.has(id) && !used.has(id),
    );
    expect(empty).toEqual([]);
  });
});

/**
 * Los dos mapas de iconos son `Record<string, LucideIcon>` con una caída a
 * `Wrench` cuando el nombre no está. Esa caída es correcta —una pantalla no se
 * cae por un icono— y también es la razón por la que «Acciones propuestas» y
 * «Lo que espera tu permiso» llevaban tiempo dibujadas con una llave inglesa:
 * nadie se entera. Se leen los archivos como texto a propósito, porque
 * importarlos aquí arrastraría el bundle de cliente a un test de Node.
 */
describe('los nombres de icono existen en las dos pantallas que los dibujan', () => {
  const iconNames = (relative: string) => {
    const source = readFileSync(join(process.cwd(), relative), 'utf8');
    const map = /const ICONS: Record<string, typeof Wrench> = \{([\s\S]*?)\n\};/.exec(source);
    if (!map?.[1]) throw new Error(`No encontré el mapa de iconos en ${relative}`);
    return new Set(map[1].match(/^\s{2}([A-Z]\w+),$/gm)?.map((line) => line.trim().slice(0, -1)));
  };

  const catalog = iconNames('app/(app)/tools/_components/ToolsCatalog.tsx');
  const door = iconNames('components/chat/Capabilities.tsx');

  it('el catálogo de /tools dibuja familias y grupos, así que necesita todos', () => {
    const wanted = [
      ...Object.values(FAMILY_META).map((meta) => meta.icon),
      ...CAPABILITY_GROUPS.map((group) => group.icon),
    ];
    expect([...new Set(wanted.filter((name) => !catalog.has(name)))]).toEqual([]);
  });

  it('la puerta del chat sólo dibuja grupos, y los necesita todos', () => {
    const wanted = CAPABILITY_GROUPS.map((group) => group.icon);
    expect([...new Set(wanted.filter((name) => !door.has(name)))]).toEqual([]);
  });
});

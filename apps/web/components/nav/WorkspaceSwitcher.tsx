'use client';

import {
  type WorkspaceListPayload,
  buildWorkspaceMenu,
  roleLabel,
  workspaceInitial,
} from '@/lib/workspace-switch';
import type { ActiveOrganization } from '@cortex/core';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { clsx } from 'clsx';
import { Check, ChevronsUpDown, Loader2, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * EN QUÉ EMPRESA ESTÁS, Y CÓMO TE VAS A OTRA.
 *
 * ===========================================================================
 * POR QUÉ ESTO ES LO PRIMERO QUE FALTABA
 * ===========================================================================
 * Una cuenta puede pertenecer a varios espacios de trabajo desde que existe el
 * plugin de organizaciones, y hasta hoy el shell no pintaba el nombre de
 * NINGUNO. Alguien invitado a dos empresas abría Cartera y leía una cifra sin
 * poder saber de quién era. El fallo no se ve —no hay error, no hay pantalla
 * rota—, y por eso el nombre va aquí abajo SIEMPRE visible y no dentro del
 * menú que hay que abrir para verlo.
 *
 * ===========================================================================
 * EL NOMBRE LLEGA CON EL HTML; LOS DEMÁS ESPACIOS, AL ABRIR
 * ===========================================================================
 * `active` baja como prop desde `AppShell`, que es de servidor y ya tiene
 * `user.organization` en la mano. Pedirlo con un `fetch` al montar habría
 * costado que el rail apareciera entero y el nombre del inquilino medio
 * segundo después — es decir, un instante en el que la pantalla no dice de
 * quién son las cifras que ya está enseñando.
 *
 * La lista de los DEMÁS sí se pide al abrir el menú, y ahí el reparto es el
 * correcto: casi nadie abre esto en una sesión, y una consulta más por carga
 * de página para dibujar un menú que nadie desplegó es peor negocio que un
 * spinner de 200ms dentro del menú que sí se desplegó.
 *
 * ===========================================================================
 * CAMBIAR DE ESPACIO RECARGA DE VERDAD, Y NO ES PEREZA
 * ===========================================================================
 * `window.location.assign('/')` en vez de `router.refresh()`, por tres razones
 * que se suman:
 *
 *   1. `router.refresh()` vuelve a pedir el árbol de SERVIDOR pero conserva el
 *      estado de CLIENTE: el panel abierto con la cartera del inquilino
 *      anterior, el hilo de chat en vuelo, el borrador del compositor, los
 *      contadores del rail que ya se habían pintado. Media pantalla del
 *      inquilino viejo encima de la nueva es exactamente el fallo que este
 *      componente existe para cerrar, y además uno mucho más difícil de notar
 *      que no haber cambiado.
 *   2. La DIRECCIÓN casi nunca sobrevive al cambio. `/clients/<uuid>`,
 *      `/chat/<conversación>`, `/reports/<id>`: son filas de otro inquilino, y
 *      refrescar en el sitio deja a la persona en un 404 o en un límite de
 *      acceso justo después de una acción que salió bien. Por eso se va a `/`,
 *      que redirige a Inicio — la única pantalla que existe igual en los dos.
 *   3. Una recarga entera es lo que la gente ESPERA de cambiar de empresa, y
 *      cuesta menos que la ambigüedad: nadie se queda preguntándose si el
 *      número que tiene delante ya es el nuevo.
 *
 * Crear un espacio hace lo mismo y por lo mismo: el endpoint deja la sesión
 * apuntando al recién creado, así que la pantalla que se está viendo pasa a
 * ser la de otro inquilino en el instante en que responde.
 *
 * ===========================================================================
 * TECLADO Y LECTORES DE PANTALLA: RADIX, NO UNA REIMPLEMENTACIÓN
 * ===========================================================================
 * `@radix-ui/react-dropdown-menu` ya está en el proyecto y lo usan el menú de
 * memoria del chat y las tarjetas de flujos. Trae `aria-expanded` y
 * `aria-haspopup` en el disparador, flechas para recorrer, `Escape` para
 * cerrar y el foco devuelto al disparador al cerrarse. El formulario de crear
 * es un `Dialog` de Radix por lo mismo — un `<input>` dentro de un menú pelea
 * con la búsqueda por teclas del propio menú, y el diálogo además atrapa el
 * foco mientras se escribe.
 */

/** Lo que el rail le pasa a este componente. */
export interface WorkspaceSwitcherProps {
  /** El espacio activo según el servidor. Se pinta antes de preguntar nada. */
  active: ActiveOrganization;
  /** El rail contraído (72px) o asomándose desde el chat (56px). */
  collapsed: boolean;
  /**
   * Que el menú está abierto, para quien dibuje el rail.
   *
   * Existe por el rail del chat, que se asoma con el ratón y se cierra al
   * salir: mover el cursor hacia el menú SALE del rail —el desplegable vive en
   * un portal fuera de él—, así que sin este aviso la columna se encogería
   * debajo de su propio menú abierto.
   */
  onOpenChange?: (open: boolean) => void;
}

/** Un POST del que sólo interesan dos cosas: si salió, y qué decir si no. */
async function post(url: string, body: unknown, fallback: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { error?: unknown };
    return typeof data.error === 'string' && data.error ? data.error : fallback;
  } catch {
    return 'No hubo conexión. Vuelve a intentarlo.';
  }
}

export function WorkspaceSwitcher({ active, collapsed, onOpenChange }: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<WorkspaceListPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  /** El espacio al que se está yendo. Marca la fila y bloquea el resto. */
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Una sola vez, al primer despliegue. No se reintenta solo en cada apertura
  // porque un endpoint caído se convertiría en una petición por clic; el
  // reintento es explícito y está en el propio menú.
  useEffect(() => {
    if (!open || data || loading || loadError) return;
    setLoading(true);
    let alive = true;
    void fetch('/api/organizations')
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as WorkspaceListPayload;
      })
      .then((payload) => {
        if (alive) setData(payload);
      })
      .catch(() => {
        if (alive) setLoadError(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, data, loading, loadError]);

  const menu = buildWorkspaceMenu(active, data);

  async function switchTo(id: string) {
    if (switching) return;
    setSwitching(id);
    setError(null);
    const failed = await post(
      '/api/organizations/active',
      { organizationId: id },
      'No se pudo cambiar de espacio.',
    );
    if (failed) {
      setSwitching(null);
      setError(failed);
      return;
    }
    // A propósito no se limpia `switching`: la página se está yendo, y apagar
    // el «Cambiando…» antes de que se vaya sería un parpadeo que dice que ya
    // terminó cuando lo que viene es la carga entera.
    window.location.assign('/');
  }

  return (
    <div className="min-w-0">
      <DropdownMenu.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChange?.(next);
        }}
      >
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            title={collapsed ? menu.active.name : undefined}
            aria-label={`Espacio de trabajo: ${menu.active.name}`}
            className={clsx(
              'group flex w-full items-center rounded-sm text-sm transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              'hover:bg-rail-2 data-[state=open]:bg-rail-2 motion-reduce:transition-none',
              collapsed ? 'justify-center p-1' : 'gap-2 px-2 py-1.5',
            )}
          >
            <span
              aria-hidden="true"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-sm bg-primary/25 font-mono text-xs font-bold text-white"
            >
              {workspaceInitial(menu.active.name)}
            </span>
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate font-semibold text-rail-ink">
                    {menu.active.name}
                  </span>
                  <span className="block truncate text-micro text-rail-ink-faint">
                    {switching ? 'Cambiando…' : 'Espacio de trabajo'}
                  </span>
                </span>
                {/*
                  EL DOBLE CHEVRON SÓLO CUANDO HAY ENTRE QUÉ ELEGIR.
                  Con un único espacio esto no es un selector, y dibujarle las
                  flechas de un selector sería prometer una lista que no existe
                  — el menú sigue abriéndose, porque dentro está «crear otro»,
                  pero no se anuncia como una elección. Mientras no se sabe
                  (nadie lo ha abierto todavía) tampoco se dibujan: afirmar que
                  hay varios antes de preguntar es la misma mentira al revés.
                */}
                {menu.state === 'choice' && (
                  <ChevronsUpDown
                    aria-hidden="true"
                    strokeWidth={1.75}
                    className="h-3.5 w-3.5 shrink-0 text-rail-ink-faint"
                  />
                )}
                {switching && (
                  <Loader2
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 animate-spin text-rail-ink-faint"
                  />
                )}
              </>
            )}
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="top"
            align="start"
            sideOffset={8}
            className="scroll-slim z-50 max-h-[70vh] w-[17rem] overflow-y-auto rounded-card border border-border bg-surface p-1.5 shadow-pop"
          >
            <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-micro font-semibold uppercase tracking-field text-ink-faint">
              Estás en
            </DropdownMenu.Label>
            <div className="flex items-center gap-2 px-2.5 pb-1.5">
              <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
                {menu.active.name}
              </span>
              <span className="shrink-0 text-micro text-ink-faint">
                {roleLabel(menu.active.role)}
              </span>
            </div>

            <div className="my-1 h-px bg-border" aria-hidden />

            {loading && (
              <div className="flex items-center gap-2 px-2.5 py-3 text-xs text-ink-faint">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Buscando tus espacios…
              </div>
            )}

            {loadError && (
              <div className="px-2.5 py-2.5">
                <p className="text-xs leading-snug text-rose">
                  No se pudieron cargar tus otros espacios.
                </p>
                <button
                  type="button"
                  onClick={() => setLoadError(false)}
                  className="mt-1 text-xs font-semibold text-primary underline underline-offset-2"
                >
                  Volver a intentarlo
                </button>
              </div>
            )}

            {menu.state === 'alone' && (
              // Ni lista de uno ni desplegable vacío: la frase que contesta la
              // pregunta que trajo a alguien hasta aquí.
              <p className="px-2.5 py-2 text-xs leading-snug text-ink-faint">
                Es el único espacio de esta cuenta.
              </p>
            )}

            {menu.others.map((workspace) => {
              const busy = switching === workspace.id;
              return (
                <DropdownMenu.Item
                  key={workspace.id}
                  disabled={switching !== null}
                  // El menú se queda abierto: si el cambio falla, el error se
                  // lee donde se pidió el cambio.
                  onSelect={(event) => {
                    event.preventDefault();
                    void switchTo(workspace.id);
                  }}
                  className="flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-2 text-sm outline-none transition-colors duration-150 data-[disabled]:cursor-default data-[highlighted]:bg-primary-soft data-[disabled]:opacity-50 motion-reduce:transition-none"
                >
                  <span className="grid h-4 w-4 shrink-0 place-items-center">
                    {busy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="grid h-4 w-4 place-items-center rounded-[3px] bg-surface-2 font-mono text-micro font-bold text-ink-muted"
                      >
                        {workspaceInitial(workspace.name)}
                      </span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium text-ink">
                    {workspace.name}
                  </span>
                  <span className="shrink-0 text-micro text-ink-faint">
                    {busy ? 'cambiando…' : roleLabel(workspace.role)}
                  </span>
                </DropdownMenu.Item>
              );
            })}

            {error && (
              <p
                role="alert"
                className="mx-1 my-1 rounded-card border border-rose/30 bg-rose-soft px-2.5 py-2 text-xs leading-snug text-rose"
              >
                {error}
              </p>
            )}

            {(menu.create.can || menu.create.reason) && (
              <div className="my-1 h-px bg-border" aria-hidden />
            )}

            {menu.create.can && (
              <DropdownMenu.Item
                onSelect={() => setCreating(true)}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-2 text-sm outline-none transition-colors duration-150 data-[highlighted]:bg-primary-soft motion-reduce:transition-none"
              >
                <Plus className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
                <span className="font-medium text-ink">Crear otro espacio</span>
              </DropdownMenu.Item>
            )}

            {/* Sin cupo no hay botón apagado que invite a pulsarlo y no explique
                nada: hay la razón, con el número que dijo el servidor. */}
            {!menu.create.can && menu.create.reason && (
              <p className="px-2.5 py-2 text-xs leading-snug text-ink-faint">
                {menu.create.reason}
              </p>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {/* El error también fuera del menú: cerrarlo no puede hacer desaparecer
          la única señal de que el cambio no ocurrió. Contraído no hay ancho
          para una frase, y el rail se ensancha con un roce. */}
      {error && !collapsed && (
        <p role="alert" className="px-2 pt-1 text-micro leading-snug text-rose">
          {error}
        </p>
      )}

      {/*
        EL DIÁLOGO NO CIERRA EL CAJÓN DEL MÓVIL al cancelarse, y por eso no
        recibe el `onNavigate` que sí llevan las filas del rail: cancelar es
        volver a donde estabas, y cerrarle a alguien el menú entero porque se
        arrepintió de crear un espacio es cobrarle el arrepentimiento. Cuando
        se confirma no hace falta cerrar nada — la página se recarga entera.
      */}
      {creating && <CreateWorkspaceDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

/**
 * Pedir el nombre y entrar.
 *
 * Un diálogo y no un `window.prompt`: el prompt del navegador no se puede
 * etiquetar, no dice qué se está creando y bloquea la pestaña entera. Y no un
 * `<input>` dentro del menú, porque el menú de Radix se lleva las teclas para
 * su propia búsqueda por letras y escribir «Acme» dentro navegaría entre las
 * filas en vez de rellenar el campo.
 */
function CreateWorkspaceDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const clean = name.trim();
    if (!clean || saving) return;
    setSaving(true);
    setError(null);
    const failed = await post(
      '/api/organizations',
      { name: clean },
      'No se pudo crear el espacio.',
    );
    if (failed) {
      setSaving(false);
      setError(failed);
      return;
    }
    // El endpoint deja la sesión apuntando al espacio nuevo, así que todo lo
    // que hay detrás de este diálogo ya es de otro inquilino. Misma recarga
    // honesta que al cambiar; el porqué está arriba del archivo.
    window.location.assign('/');
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && !saving && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-card border border-border bg-surface shadow-pop outline-none">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <Dialog.Title className="text-sm font-bold text-ink">
                Nuevo espacio de trabajo
              </Dialog.Title>
              <Dialog.Description className="text-micro text-ink-faint">
                Empieza vacío y separado: sus clientes, su cartera y su memoria no se mezclan con
                los de aquí.
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Cerrar"
              disabled={saving}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-card text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="space-y-3 px-5 py-4">
            <label className="block">
              <span className="text-micro font-semibold uppercase tracking-field text-ink-faint">
                Nombre
              </span>
              <input
                // El foco entra aquí y no en el botón de cerrar: lo único que
                // hay que hacer en este diálogo es escribir un nombre.
                // biome-ignore lint/a11y/noAutofocus: es un diálogo modal de un solo campo.
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder="Acme SAS"
                maxLength={120}
                className="mt-1.5 w-full rounded-card border border-border bg-surface px-3 py-2 text-sm text-ink transition placeholder:text-ink-faint focus:border-primary focus:outline-none"
              />
            </label>

            {error && (
              <p
                role="alert"
                className="rounded-card border border-rose/30 bg-rose-soft px-3 py-2 text-xs text-rose"
              >
                {error}
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-card px-3.5 py-1.5 text-xs font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={saving || !name.trim()}
              className="inline-flex items-center gap-1.5 rounded-card bg-primary px-4 py-1.5 text-xs font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong disabled:opacity-50"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              {saving ? 'Creando y entrando…' : 'Crear y entrar'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

'use client';

import { ViewChart } from '@/components/views/ViewChart';
import { MetricBlock } from '@/components/views/blocks/Metric';
import { ViewCover } from '@/components/views/blocks/ViewChrome';
import { BrandScope, ViewBrandProvider } from '@/components/views/blocks/brand';
import { Card } from '@/components/views/blocks/theme';
import {
  CORTEX_PRIMARY,
  brandTokens,
  contrast,
  dominantColors,
  hexToRgb,
  normalizeHex,
} from '@/lib/branding/colors';
import { MAX_BRAND_NAME, type ViewBrand } from '@/lib/branding/shape';
import type { ComputedBlock } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { Check, ImagePlus, Loader2, Palette, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, useTransition } from 'react';
import { saveBrandAction } from '../brand-actions';

/**
 * LA MARCA DE LA EMPRESA: logo, colores y nombre para mostrar (migración 0170).
 *
 * Lo que se elige aquí es el aspecto por defecto de TODAS las vistas — adentro,
 * en el enlace que se le manda a un cliente y en papel. Por eso la vista
 * previa no es una maqueta: son los mismos componentes del lienzo (la portada,
 * una cifra con su KPI, un gráfico, un botón) envueltos en la marca que se está
 * eligiendo, con el contraste ya resuelto como lo resolverá la vista.
 *
 * EL LOGO SE REDUCE EN EL NAVEGADOR. Se dibuja en un canvas de 512 px como
 * mucho y se guarda como PNG (conserva la transparencia): una foto de 8 MB
 * del celular sube como 80 KB, y el servidor nunca recibe un SVG ni un archivo
 * que diga ser imagen sin serlo. Del mismo dibujo, reducido a 64 px, salen los
 * colores que se proponen como color de la marca.
 */

const LOGO_MAX_PX = 512;

const SAMPLE_METRIC: Extract<ComputedBlock, { type: 'metric' }> = {
  id: 'muestra',
  width: 'third',
  type: 'metric',
  title: 'Ventas',
  value: 268_400_000,
  display: '$ 268.400.000',
  rows: 142,
  goal: null,
  tone: 'primary',
  caption: null,
  source: 'Ventas',
  compare: {
    period: 'month',
    currentLabel: 'Este mes',
    previousLabel: 'vs. mes anterior',
    previous: 241_200_000,
    previousDisplay: '$ 241.200.000',
    delta: 0.113,
    direction: 'up',
    good: true,
    series: [
      { label: 'may', value: 182 },
      { label: 'jun', value: 201 },
      { label: 'jul', value: 194 },
      { label: 'ago', value: 226 },
      { label: 'sep', value: 241 },
      { label: 'oct', value: 268 },
    ],
  },
};

const SAMPLE_CHART: Extract<ComputedBlock, { type: 'chart' }> = {
  id: 'canales',
  width: 'third',
  type: 'chart',
  title: 'Pedidos por canal',
  chart: 'donut',
  points: [
    { label: 'WhatsApp', value: 61, display: '61' },
    { label: 'Vendedores', value: 44, display: '44' },
    { label: 'Tienda web', value: 23, display: '23' },
  ],
  total: '128',
  tone: 'primary',
  source: 'Ventas',
};

/** Reduce una imagen a PNG de 512 px como mucho y propone sus colores. */
async function prepareLogo(file: File): Promise<{ blob: Blob; url: string; colors: string[] }> {
  const source = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('No se pudo leer esa imagen.'));
      el.src = source;
    });
    const scale = Math.min(1, LOGO_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight, 1));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Este navegador no deja preparar la imagen.');
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('No se pudo preparar el logo.'))),
        'image/png',
      ),
    );
    // Los colores, de una copia chiquita: sobra para saber cuáles mandan.
    const small = document.createElement('canvas');
    const sw = Math.max(1, Math.round((w / Math.max(w, h)) * 64));
    const sh = Math.max(1, Math.round((h / Math.max(w, h)) * 64));
    small.width = sw;
    small.height = sh;
    const sctx = small.getContext('2d');
    sctx?.drawImage(img, 0, 0, sw, sh);
    const colors = sctx ? dominantColors(sctx.getImageData(0, 0, sw, sh).data, 4) : [];
    return { blob, url: URL.createObjectURL(blob), colors };
  } finally {
    URL.revokeObjectURL(source);
  }
}

export function BrandPanel({
  initial,
  canEdit,
  workspaceName,
}: {
  initial: ViewBrand & { displayName: string | null };
  canEdit: boolean;
  workspaceName: string;
}) {
  const [name, setName] = useState(initial.displayName ?? '');
  const [primary, setPrimary] = useState(initial.primary ?? '');
  const [secondary, setSecondary] = useState(initial.secondary ?? '');
  const [logoUrl, setLogoUrl] = useState(initial.logoUrl);
  const [logoBlob, setLogoBlob] = useState<Blob | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  /** Si hay un logo GUARDADO (quitarlo pide borrarlo en el servidor). */
  const [savedLogo, setSavedLogo] = useState(Boolean(initial.logoUrl));
  const [suggested, setSuggested] = useState<string[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, startSave] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const ids = useId();

  // Lo que se dibuja con URL.createObjectURL se suelta al cambiarlo o al salir.
  useEffect(
    () => () => {
      if (logoUrl?.startsWith('blob:')) URL.revokeObjectURL(logoUrl);
    },
    [logoUrl],
  );

  const primaryHex = normalizeHex(primary);
  const secondaryHex = normalizeHex(secondary);
  const draft: ViewBrand = useMemo(
    () => ({
      name: name.trim() || workspaceName,
      logoUrl: removeLogo ? null : logoUrl,
      primary: primaryHex,
      secondary: secondaryHex,
    }),
    [name, workspaceName, removeLogo, logoUrl, primaryHex, secondaryHex],
  );

  // Qué hizo el cálculo de contraste con el color, dicho en palabras.
  const note = useMemo(() => {
    if (!primaryHex) return null;
    const t = brandTokens(primaryHex, secondaryHex);
    const raw = hexToRgb(primaryHex);
    if (!t || !raw) return null;
    const ratio = contrast(t.button, t.buttonInk);
    const adjusted = contrast(raw, [255, 255, 255]) < 4.5;
    return {
      ratio: ratio.toFixed(1).replace('.', ','),
      ink: t.buttonInk[0] > 128 ? 'blanco' : 'oscuro',
      adjusted,
    };
  }, [primaryHex, secondaryHex]);

  const dirty =
    name !== (initial.displayName ?? '') ||
    (primaryHex ?? '') !== (initial.primary ?? '') ||
    (secondaryHex ?? '') !== (initial.secondary ?? '') ||
    logoBlob !== null ||
    removeLogo;

  async function onFile(file: File | undefined) {
    if (!file) return;
    setMessage(null);
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      setMessage({ ok: false, text: 'Usa un PNG, JPG o WebP. Los SVG no se aceptan.' });
      return;
    }
    setPreparing(true);
    try {
      const ready = await prepareLogo(file);
      setLogoBlob(ready.blob);
      setLogoUrl(ready.url);
      setRemoveLogo(false);
      setSuggested(ready.colors);
      // Sin color elegido todavía, el que más pesa en el logo es la propuesta.
      if (!primaryHex && ready.colors[0]) setPrimary(ready.colors[0]);
      if (!secondaryHex && ready.colors[1]) setSecondary(ready.colors[1]);
    } catch (err) {
      setMessage({
        ok: false,
        text: err instanceof Error ? err.message : 'No se pudo leer el logo.',
      });
    } finally {
      setPreparing(false);
    }
  }

  function save() {
    setMessage(null);
    const form = new FormData();
    form.set('displayName', name);
    form.set('primary', primaryHex ?? '');
    form.set('secondary', secondaryHex ?? '');
    if (logoBlob) form.set('logo', new File([logoBlob], 'logo.png', { type: 'image/png' }));
    if (removeLogo) form.set('removeLogo', '1');
    startSave(async () => {
      const res = await saveBrandAction(form);
      if (!res.ok) {
        setMessage({ ok: false, text: res.error });
        return;
      }
      setLogoBlob(null);
      if (res.logoVersion) {
        setLogoUrl(`/api/branding/logo?v=${res.logoVersion}`);
        setSavedLogo(true);
      }
      if (removeLogo) {
        setLogoUrl(null);
        setRemoveLogo(false);
        setSavedLogo(false);
      }
      setMessage({ ok: true, text: 'Guardado. Las vistas ya usan esta marca.' });
    });
  }

  return (
    <section
      aria-labelledby={`${ids}-title`}
      className="rounded-card border border-border bg-surface p-5 shadow-card sm:p-6"
    >
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={`${ids}-title`} className="flex items-center gap-2 text-lg font-bold text-ink">
            <Palette className="h-5 w-5 text-primary" aria-hidden /> La marca
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-muted">
            El logo y los colores con los que salen las vistas: adentro, en los enlaces que
            compartes y al imprimir. Cada vista puede elegir otro tono si lo necesita.
          </p>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            {message && (
              <span
                role={message.ok ? 'status' : 'alert'}
                className={clsx(
                  'inline-flex items-center gap-1 text-xs font-semibold',
                  message.ok ? 'text-emerald' : 'text-rose',
                )}
              >
                {message.ok && <Check className="h-3.5 w-3.5" aria-hidden />}
                {message.text}
              </span>
            )}
            <button
              type="button"
              onClick={save}
              disabled={!dirty || saving || preparing}
              className="cortex-primary-button inline-flex h-10 items-center gap-2 rounded-pill bg-primary px-5 text-sm font-semibold text-white transition-all duration-150 hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-45"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Guardar marca
            </button>
          </div>
        )}
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        {/* Los controles */}
        <fieldset disabled={!canEdit} className="min-w-0 space-y-5 disabled:opacity-80">
          <div>
            <span className="field-label mb-2 block">Logo</span>
            <div className="flex items-center gap-4">
              <div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-sm border border-dashed border-border-strong bg-white p-2">
                {draft.logoUrl ? (
                  <img
                    src={draft.logoUrl}
                    alt={`Logo de ${draft.name}`}
                    className="max-h-full max-w-full object-contain"
                  />
                ) : (
                  <ImagePlus className="h-6 w-6 text-ink-faint" aria-hidden />
                )}
              </div>
              <div className="min-w-0 space-y-2">
                <input
                  ref={fileRef}
                  id={`${ids}-logo`}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  onChange={(e) => {
                    void onFile(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
                <label
                  htmlFor={`${ids}-logo`}
                  className={clsx(
                    'inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-4 text-xs font-semibold text-ink shadow-card transition-colors hover:bg-surface-2',
                    !canEdit && 'pointer-events-none opacity-50',
                  )}
                >
                  {preparing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <ImagePlus className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {draft.logoUrl ? 'Cambiar logo' : 'Subir logo'}
                </label>
                {draft.logoUrl && canEdit && (
                  <button
                    type="button"
                    onClick={() => {
                      setLogoBlob(null);
                      setLogoUrl(null);
                      setRemoveLogo(savedLogo);
                    }}
                    className="ml-2 inline-flex items-center gap-1 text-xs font-semibold text-ink-muted hover:text-rose"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden /> Quitar
                  </button>
                )}
                <p className="text-micro text-ink-faint">
                  PNG, JPG o WebP. Mejor con fondo transparente.
                </p>
              </div>
            </div>
          </div>

          <label className="block">
            <span className="field-label mb-1.5 block">Nombre para mostrar</span>
            <input
              value={name}
              maxLength={MAX_BRAND_NAME}
              onChange={(e) => setName(e.target.value)}
              placeholder={workspaceName}
              className="h-10 w-full rounded-pill border border-border-strong bg-surface px-4 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
            />
          </label>

          <ColorField
            label="Color principal"
            value={primary}
            onChange={setPrimary}
            fallback={CORTEX_PRIMARY}
            hint="Botones, acentos, gráficos."
          />
          <ColorField
            label="Color secundario"
            value={secondary}
            onChange={setSecondary}
            fallback="#7dd3fc"
            hint="Opcional: la segunda serie de los gráficos y la franja."
          />

          {suggested.length > 0 && canEdit && (
            <div>
              <span className="mb-2 flex items-center gap-1.5 text-micro font-semibold text-ink-muted">
                <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden /> Colores de tu logo
              </span>
              <div className="flex flex-wrap gap-2">
                {suggested.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => (primaryHex === c ? setSecondary(c) : setPrimary(c))}
                    title={`Usar ${c}`}
                    className="inline-flex h-8 items-center gap-2 rounded-pill border border-border bg-surface pl-1 pr-3 text-micro font-semibold text-ink shadow-card transition-colors hover:border-border-strong"
                  >
                    <span
                      className="h-6 w-6 rounded-pill border border-border"
                      style={{ background: c }}
                    />
                    <span className="tabular font-mono">{c}</span>
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-micro text-ink-faint">
                Un toque lo pone como principal; otro, sobre el mismo, como secundario.
              </p>
            </div>
          )}

          {note && (
            <p className="rounded-sm bg-surface-2 px-3 py-2.5 text-micro leading-relaxed text-ink-muted">
              Texto {note.ink} sobre el color: contraste{' '}
              <span className="tabular font-mono font-semibold text-ink">{note.ratio}:1</span>.
              {note.adjusted &&
                ' Es un color claro: los textos y enlaces usan una versión más oscura para que se lean; botones y gráficos lo usan tal cual.'}
            </p>
          )}
        </fieldset>

        {/* La vista previa, con los mismos componentes del lienzo */}
        <div className="min-w-0 rounded-card border border-border bg-canvas p-4 sm:p-5">
          <p className="field-label mb-3">Así se verá una vista</p>
          <ViewBrandProvider brand={draft}>
            <BrandScope>
              <ViewCover
                title="Cómo va la empresa"
                subtitle="Ventas, cartera y despachos, al día."
                theme={{ accent: 'primary', density: 'comfortable', header: 'plain', cover: null }}
                brand={draft}
              />
              <div className="grid gap-4 xl:grid-cols-2">
                <MetricBlock block={SAMPLE_METRIC} />
                <Card title={SAMPLE_CHART.title}>
                  <ViewChart block={SAMPLE_CHART} />
                </Card>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className="cortex-primary-button inline-flex h-10 items-center rounded-pill bg-primary px-5 text-sm font-semibold text-white">
                  Enviar
                </span>
                <span className="inline-flex h-8 items-center rounded-pill bg-primary-soft px-3 text-micro font-semibold text-primary-ink">
                  Etiqueta
                </span>
                <span className="text-sm font-semibold text-primary">Un enlace</span>
              </div>
            </BrandScope>
          </ViewBrandProvider>
        </div>
      </div>
    </section>
  );
}

function ColorField({
  label,
  value,
  onChange,
  fallback,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  fallback: string;
  hint: string;
}) {
  const id = useId();
  const hex = normalizeHex(value);
  return (
    <div>
      <label htmlFor={id} className="field-label mb-1.5 block">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label}: elegir en la paleta`}
          value={hex ?? fallback}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-12 shrink-0 cursor-pointer rounded-sm border border-border-strong bg-surface p-1"
        />
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={label === 'Color principal' ? 'Índigo de Cortex' : 'Sin color'}
          spellCheck={false}
          className={clsx(
            'tabular h-10 w-full rounded-pill border bg-surface px-4 font-mono text-sm text-ink outline-none transition-colors placeholder:font-sans placeholder:text-ink-faint focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/30',
            value && !hex ? 'border-rose' : 'border-border-strong',
          )}
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            className="shrink-0 text-micro font-semibold text-ink-muted hover:text-ink"
          >
            Quitar
          </button>
        )}
      </div>
      <p className={clsx('mt-1 text-micro', value && !hex ? 'text-rose' : 'text-ink-faint')}>
        {value && !hex ? 'Usa un color como #1F6FEB.' : hint}
      </p>
    </div>
  );
}

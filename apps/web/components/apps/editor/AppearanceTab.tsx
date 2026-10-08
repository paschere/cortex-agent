'use client';

import { BrandScope, ViewBrandProvider } from '@/components/views/blocks/brand';
import { colorReport, companyColorChoices } from '@/lib/apps/app-brand';
import { saveAppearanceAction } from '@/lib/apps/appearance-actions';
import { type SquareMode, prepareImage, samplePixels } from '@/lib/apps/image-prep';
import { dominantColors, normalizeHex } from '@/lib/branding/colors';
import { clsx } from 'clsx';
import { Check, ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { type AppEditorData, BTN_PRIMARY, BTN_SECONDARY, CARD, ErrorLine, INPUT } from './shared';

/**
 * «APARIENCIA» (0215): la marca PROPIA de la app, encima de la de la empresa.
 *
 * Todo lo que se deje vacío se hereda de la empresa (se dice al lado de cada
 * campo). A la derecha, una vista previa en un celular con los mismos
 * componentes del marco de la app, pintados con el contraste ya resuelto como
 * lo resolverá la app real, en claro y en oscuro (los números se muestran).
 *
 * Las imágenes se reducen aquí, en el navegador: un SVG se dibuja y se vuelve
 * PNG (nunca se sube un SVG), el logo queda en 512 px como mucho y el ícono es
 * un cuadrado blanco de 512 px, recortado al centro o con el logo entero.
 */

type FontChoice = 'system' | 'serif' | 'rounded';
const FONTS: Array<{ value: FontChoice; label: string; stack: string; sample: string }> = [
  {
    value: 'system',
    label: 'Moderna',
    stack: 'var(--font-sans), ui-sans-serif, system-ui, sans-serif',
    sample: 'Registrar atención',
  },
  {
    value: 'serif',
    label: 'Editorial',
    stack: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif",
    sample: 'Registrar atención',
  },
  {
    value: 'rounded',
    label: 'Redondeada',
    stack:
      "ui-rounded, 'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Quicksand, Nunito, system-ui, sans-serif",
    sample: 'Registrar atención',
  },
];

interface Picked {
  blob: Blob;
  url: string;
}

function ratio(n: number): string {
  return n.toFixed(1).replace('.', ',');
}

export function AppearanceTab({ data }: { data: AppEditorData }) {
  const { app, brand, companyBrand } = data;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [primary, setPrimary] = useState(brand.primary ?? '');
  const [accent, setAccent] = useState(brand.accent ?? '');
  const [shortName, setShortName] = useState(brand.shortName ?? '');
  const [font, setFont] = useState<FontChoice>(brand.font ?? 'system');
  const [welcomeTitle, setWelcomeTitle] = useState(brand.welcome?.title ?? '');
  const [welcomeText, setWelcomeText] = useState(brand.welcome?.text ?? '');

  const savedUrl = (kind: 'logo' | 'icon' | 'welcome') => {
    const ref = brand.files?.[kind];
    return ref ? `/api/apps/${app.id}/asset/${kind}?v=${ref.v}` : null;
  };
  const [logo, setLogo] = useState<Picked | null>(null);
  const [icon, setIcon] = useState<Picked | null>(null);
  const [welcomeImg, setWelcomeImg] = useState<Picked | null>(null);
  const [removed, setRemoved] = useState<Record<string, boolean>>({});
  const [squareMode, setSquareMode] = useState<SquareMode>('contain');
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [suggested, setSuggested] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const logoInput = useRef<HTMLInputElement>(null);
  const welcomeInput = useRef<HTMLInputElement>(null);

  // Las URLs de vista previa locales se sueltan al cambiarlas o salir.
  useEffect(
    () => () => {
      for (const p of [logo, icon, welcomeImg]) if (p) URL.revokeObjectURL(p.url);
    },
    [logo, icon, welcomeImg],
  );

  // El ícono se rehace si cambia el modo de cuadrado.
  useEffect(() => {
    if (!logoFile) return;
    let cancelled = false;
    prepareImage(logoFile, { max: 512, square: squareMode })
      .then((p) => {
        if (!cancelled) setIcon({ blob: p.blob, url: p.url });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [logoFile, squareMode]);

  async function pickLogo(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) {
      setError('Usa un PNG, JPG, WebP o SVG.');
      return;
    }
    setBusy(true);
    try {
      const prepared = await prepareImage(file, { max: 512 });
      setLogo({ blob: prepared.blob, url: prepared.url });
      setLogoFile(file);
      setRemoved((r) => ({ ...r, logo: false, icon: false }));
      const pixels = await samplePixels(file).catch(() => null);
      setSuggested(pixels ? dominantColors(pixels, 3) : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo leer esa imagen.');
    } finally {
      setBusy(false);
    }
  }

  async function pickWelcome(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      setError('La imagen de bienvenida tiene que ser PNG, JPG o WebP.');
      return;
    }
    setBusy(true);
    try {
      const prepared = await prepareImage(file, { max: 1000, jpeg: true });
      setWelcomeImg({ blob: prepared.blob, url: prepared.url });
      setRemoved((r) => ({ ...r, welcome: false }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo leer esa imagen.');
    } finally {
      setBusy(false);
    }
  }

  const primaryHex = normalizeHex(primary);
  const accentHex = normalizeHex(accent);
  const report = colorReport(primaryHex);
  const accentReport = colorReport(accentHex);
  const effectivePrimary = primaryHex ?? companyBrand.primary;
  const effectiveAccent = accentHex ?? companyBrand.secondary;

  const logoShown = removed.logo ? null : (logo?.url ?? savedUrl('logo') ?? companyBrand.logoUrl);
  const iconShown = removed.icon ? null : (icon?.url ?? savedUrl('icon') ?? logoShown);
  const welcomeShown = removed.welcome ? null : (welcomeImg?.url ?? savedUrl('welcome'));

  const dirty =
    (primaryHex ?? '') !== (brand.primary ?? '') ||
    (accentHex ?? '') !== (brand.accent ?? '') ||
    shortName.trim() !== (brand.shortName ?? '') ||
    font !== (brand.font ?? 'system') ||
    welcomeTitle.trim() !== (brand.welcome?.title ?? '') ||
    welcomeText.trim() !== (brand.welcome?.text ?? '') ||
    Boolean(logo || icon || welcomeImg) ||
    Object.values(removed).some(Boolean);

  const colorProblem =
    (primary.trim() && !primaryHex) || (accent.trim() && !accentHex)
      ? 'Usa colores como #1F6FEB.'
      : null;

  function save() {
    setError(null);
    setSaved(false);
    start(async () => {
      const form = new FormData();
      form.set(
        'fields',
        JSON.stringify({
          primary: primaryHex ?? '',
          accent: accentHex ?? '',
          shortName: shortName.trim(),
          font,
          welcome: { title: welcomeTitle.trim(), text: welcomeText.trim() },
        }),
      );
      if (logo) form.set('logo', new File([logo.blob], 'logo.png', { type: 'image/png' }));
      if (icon) form.set('icon', new File([icon.blob], 'icon.png', { type: 'image/png' }));
      if (welcomeImg)
        form.set('welcome', new File([welcomeImg.blob], 'welcome.jpg', { type: 'image/jpeg' }));
      for (const kind of ['logo', 'icon', 'welcome'] as const)
        if (removed[kind]) form.set(`remove_${kind}`, '1');
      const res = await saveAppearanceAction(app.id, form);
      if (!res.ok) return setError(res.error);
      setLogo(null);
      setIcon(null);
      setWelcomeImg(null);
      setLogoFile(null);
      setRemoved({});
      setSaved(true);
      router.refresh();
    });
  }

  const choices = [...new Set([...companyColorChoices(companyBrand), ...suggested])];
  const previewBrand = {
    name: app.name,
    logoUrl: logoShown,
    primary: effectivePrimary,
    secondary: effectiveAccent,
  };
  const label = 'text-micro font-semibold uppercase tracking-field text-ink-faint';

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-4">
        <section className={clsx(CARD, 'space-y-3')}>
          <h2 className="text-sm font-bold text-ink">Logo e ícono</h2>
          <p className="text-xs text-ink-muted">
            Si no subes uno, la app usa el logo de la empresa
            {companyBrand.logoUrl ? '' : ' (aún no tiene) y las iniciales de la app'}.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-3">
              <div className="grid h-16 w-16 place-items-center overflow-hidden rounded-card border border-border bg-white p-1">
                {logoShown ? (
                  <img
                    src={logoShown}
                    alt="Logo"
                    className="max-h-full max-w-full object-contain"
                  />
                ) : (
                  <span className="text-xs text-ink-faint">Sin logo</span>
                )}
              </div>
              <div className="grid h-16 w-16 place-items-center overflow-hidden rounded-[22%] border border-border bg-white">
                {iconShown ? (
                  <img src={iconShown} alt="Ícono" className="h-full w-full object-contain" />
                ) : (
                  <span className="text-xs text-ink-faint">Ícono</span>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={logoInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                className="sr-only"
                onChange={(e) => {
                  void pickLogo(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => logoInput.current?.click()}
                className={BTN_SECONDARY}
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <ImagePlus className="h-3.5 w-3.5" aria-hidden />
                )}
                Subir logo
              </button>
              {logoShown && (logo || savedUrl('logo')) && (
                <button
                  type="button"
                  onClick={() => {
                    setLogo(null);
                    setIcon(null);
                    setLogoFile(null);
                    setRemoved((r) => ({ ...r, logo: true, icon: true }));
                  }}
                  className={BTN_SECONDARY}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden /> Quitar
                </button>
              )}
            </div>
          </div>
          <fieldset className="flex flex-wrap items-center gap-2">
            <legend className={clsx(label, 'mb-1')}>Ícono cuadrado</legend>
            {(
              [
                ['contain', 'Logo entero'],
                ['cover', 'Recortar al centro'],
              ] as const
            ).map(([value, text]) => (
              <button
                key={value}
                type="button"
                aria-pressed={squareMode === value}
                onClick={() => setSquareMode(value)}
                className={clsx(
                  'inline-flex h-8 items-center rounded-pill border px-3 text-xs font-semibold transition-colors',
                  squareMode === value
                    ? 'border-primary bg-primary-soft text-primary-ink'
                    : 'border-border bg-surface text-ink-muted hover:text-ink',
                )}
              >
                {text}
              </button>
            ))}
            <span className="text-micro text-ink-faint">
              Se usa al instalar la app y en los avisos.
            </span>
          </fieldset>
        </section>

        <section className={clsx(CARD, 'space-y-4')}>
          <h2 className="text-sm font-bold text-ink">Colores</h2>
          {(
            [
              ['Color principal', primary, setPrimary, report, companyBrand.primary],
              ['Color de acento', accent, setAccent, accentReport, companyBrand.secondary],
            ] as const
          ).map(([name, value, set, rep, inherited]) => (
            <div key={name} className="space-y-1.5">
              <span className={label}>{name}</span>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="color"
                  value={normalizeHex(value) ?? inherited ?? '#4338ca'}
                  onChange={(e) => set(e.target.value)}
                  aria-label={name}
                  className="h-11 w-11 cursor-pointer rounded-sm border border-border bg-surface p-0.5"
                />
                <input
                  value={value}
                  onChange={(e) => set(e.target.value)}
                  placeholder={inherited ?? 'Como la empresa'}
                  maxLength={9}
                  aria-label={`${name} en hexadecimal`}
                  className={clsx(INPUT, 'w-32 font-mono')}
                />
                {value && (
                  <button type="button" onClick={() => set('')} className={BTN_SECONDARY}>
                    Heredar de la empresa
                  </button>
                )}
              </div>
              {rep.valid && (
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-ink-muted">
                  <span className={rep.light >= 4.5 ? 'text-emerald' : 'text-rose'}>
                    Claro {ratio(rep.light)}:1
                  </span>
                  <span className={rep.dark >= 4.5 ? 'text-emerald' : 'text-rose'}>
                    Oscuro {ratio(rep.dark)}:1
                  </span>
                  <span className={rep.button >= 4.5 ? 'text-emerald' : 'text-rose'}>
                    Botón {ratio(rep.button)}:1
                  </span>
                  <span>
                    {rep.passesRaw
                      ? 'Pasa AA tal cual.'
                      : `Se ajusta solo para leerse (${rep.usedLight} en claro, ${rep.usedDark} en oscuro).`}
                  </span>
                </p>
              )}
            </div>
          ))}
          {choices.length > 0 && (
            <div className="space-y-1.5">
              <span className={label}>Colores de la empresa y del logo</span>
              <div className="flex flex-wrap gap-2">
                {choices.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setPrimary(c)}
                    aria-label={`Usar ${c} como color principal`}
                    title={c}
                    className="grid h-11 w-11 place-items-center rounded-pill border border-border-strong"
                    style={{ background: c }}
                  >
                    {primaryHex === c && (
                      <Check className="h-4 w-4 text-white mix-blend-difference" aria-hidden />
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className={clsx(CARD, 'space-y-3')}>
          <h2 className="text-sm font-bold text-ink">Nombre y letra</h2>
          <label className="block space-y-1">
            <span className={label}>Nombre corto (bajo el ícono instalado, 12 letras)</span>
            <input
              value={shortName}
              onChange={(e) => setShortName(e.target.value)}
              maxLength={12}
              placeholder={app.name.slice(0, 12)}
              className={clsx(INPUT, 'w-48')}
            />
          </label>
          <fieldset className="grid gap-2 sm:grid-cols-3">
            <legend className={clsx(label, 'mb-1')}>Tipografía</legend>
            {FONTS.map((f) => (
              <label
                key={f.value}
                className={clsx(
                  'flex min-h-11 cursor-pointer flex-col gap-0.5 rounded-card border px-3 py-2',
                  font === f.value ? 'border-primary bg-primary-soft' : 'border-border bg-surface',
                )}
              >
                <input
                  type="radio"
                  name="font"
                  checked={font === f.value}
                  onChange={() => setFont(f.value)}
                  className="sr-only"
                />
                <span className="text-micro font-semibold text-ink-muted">{f.label}</span>
                <span className="text-sm font-semibold text-ink" style={{ fontFamily: f.stack }}>
                  {f.sample}
                </span>
              </label>
            ))}
          </fieldset>
        </section>

        <section className={clsx(CARD, 'space-y-3')}>
          <h2 className="text-sm font-bold text-ink">Pantalla de bienvenida</h2>
          <p className="text-xs text-ink-muted">
            Lo primero que ve quien abre el enlace de la app, antes de pedir su código.
          </p>
          <label className="block space-y-1">
            <span className={label}>Título</span>
            <input
              value={welcomeTitle}
              onChange={(e) => setWelcomeTitle(e.target.value)}
              maxLength={80}
              placeholder={`Entrar a ${app.name}`}
              className={clsx(INPUT, 'w-full')}
            />
          </label>
          <label className="block space-y-1">
            <span className={label}>Texto</span>
            <textarea
              value={welcomeText}
              onChange={(e) => setWelcomeText(e.target.value)}
              maxLength={400}
              rows={3}
              placeholder="Qué es esta app y quién debería entrar."
              className="w-full resize-y rounded-sm border border-border bg-surface px-3 py-2 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-primary"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={welcomeInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              onChange={(e) => {
                void pickWelcome(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => welcomeInput.current?.click()}
              className={BTN_SECONDARY}
            >
              <ImagePlus className="h-3.5 w-3.5" aria-hidden /> Imagen (opcional)
            </button>
            {welcomeShown && (
              <button
                type="button"
                onClick={() => {
                  setWelcomeImg(null);
                  setRemoved((r) => ({ ...r, welcome: true }));
                }}
                className={BTN_SECONDARY}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Quitar imagen
              </button>
            )}
          </div>
        </section>

        <ErrorLine error={error ?? colorProblem} />
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={pending || busy || !dirty || Boolean(colorProblem)}
            onClick={save}
            className={BTN_PRIMARY}
          >
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            Guardar apariencia
          </button>
          {saved && !dirty && (
            <output className="text-xs font-medium text-emerald">
              Guardado. Quien ya instaló la app ve el cambio al abrirla de nuevo.
            </output>
          )}
        </div>
      </div>

      <aside aria-label="Vista previa en un celular" className="lg:sticky lg:top-4 lg:self-start">
        <p className={clsx(label, 'mb-2')}>Vista previa</p>
        <div className="mx-auto w-[260px] rounded-[2rem] border-4 border-ink/80 bg-canvas p-2 shadow-pop">
          <ViewBrandProvider brand={previewBrand}>
            <BrandScope className="overflow-hidden rounded-[1.4rem] bg-canvas">
              <div style={{ fontFamily: FONTS.find((f) => f.value === font)?.stack }}>
                <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2">
                  <span className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-sm bg-white">
                    {iconShown ? (
                      <img src={iconShown} alt="" className="h-full w-full object-contain" />
                    ) : (
                      <span className="text-sm">{app.icon}</span>
                    )}
                  </span>
                  <span className="truncate text-xs font-bold text-ink">{app.name}</span>
                </div>
                <div className="space-y-2 p-3">
                  <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
                    {welcomeShown && (
                      <img src={welcomeShown} alt="" className="h-20 w-full object-cover" />
                    )}
                    <div className="space-y-1.5 p-3">
                      <p className="text-sm font-bold text-ink">
                        {welcomeTitle.trim() || `Entrar a ${app.name}`}
                      </p>
                      {welcomeText.trim() && (
                        <p className="text-micro text-ink-muted">{welcomeText.trim()}</p>
                      )}
                      <div className="h-8 rounded-sm border border-border-strong bg-surface" />
                      <div className="cortex-primary-button grid h-9 place-items-center rounded-pill bg-primary text-xs font-semibold text-white">
                        Enviarme el código
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-card border border-border bg-surface p-2.5">
                      <p className="font-mono text-lg font-extrabold text-ink">12</p>
                      <p className="text-micro text-ink-muted">Hoy llegan 12</p>
                    </div>
                    <div className="rounded-card bg-primary-soft p-2.5 text-primary-ink">
                      <p className="text-xs font-bold">Registrar</p>
                      <p className="text-micro">Acceso directo</p>
                    </div>
                  </div>
                </div>
                <div className="flex border-t border-border bg-surface">
                  {['Inicio', 'Lista', 'Más'].map((t, i) => (
                    <span
                      key={t}
                      className={clsx(
                        'flex-1 py-2 text-center text-micro font-semibold',
                        i === 0 ? 'text-primary' : 'text-ink-faint',
                      )}
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            </BrandScope>
          </ViewBrandProvider>
        </div>
        <p className="mt-2 text-center text-micro text-ink-faint">
          Nombre instalado: «{(shortName.trim() || app.name).slice(0, 12)}»
        </p>
      </aside>
    </div>
  );
}

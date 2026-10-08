import {
  type CoCalendarYear,
  calendarFor,
  digitIndex,
  dueByDigit,
  nextMonth,
  nextTaxBusinessDay,
  nthBusinessDay,
} from './calendar-co';
import {
  type GeneratedObligation,
  ICA_CITY_LABEL,
  type ObligationKind,
  type TaxProfile,
  lastDigit,
  lastTwoDigits,
  monthLong,
} from './shape';

/**
 * EL MOTOR: DEL PERFIL TRIBUTARIO A LAS FECHAS DEL AÑO. PURO.
 *
 * Recibe el perfil (NIT y casillas) y un año de calendario, y devuelve cada
 * obligación con su fecha, su fuente y si hay que confirmarla. No lee la base,
 * no mira el reloj. El «año» es el del calendario de la DIAN: el de 2026 trae
 * la renta del año gravable 2025 y también lo que vence en enero de 2027 por
 * periodos de 2026 (IVA de noviembre–diciembre, retención de diciembre).
 *
 * Lo que el motor NO sabe calcular no se rellena: va a `gaps`, en una frase
 * que la pantalla muestra tal cual («las fechas de ICA de Cali no están en
 * Cortex: pídeselas a tu contador»).
 */

export interface TaxCalendarResult {
  year: number;
  obligations: GeneratedObligation[];
  gaps: string[];
}

type ProfileForEngine = Pick<
  TaxProfile,
  | 'nit'
  | 'personType'
  | 'granContribuyente'
  | 'regimenSimple'
  | 'ivaPeriodicity'
  | 'agenteRetencion'
  | 'icaCity'
  | 'icaPeriodicity'
  | 'exogena'
  | 'activosExterior'
  | 'camaraComercio'
  | 'nominaElectronica'
  | 'pila'
  | 'facturacionElectronica'
> &
  Partial<Pick<TaxProfile, 'impuestoPatrimonio' | 'vinculadosExterior' | 'rubLastChange'>>;

const BIMESTERS = ['ene–feb', 'mar–abr', 'may–jun', 'jul–ago', 'sep–oct', 'nov–dic'];
const CUATRIMESTERS = ['ene–abr', 'may–ago', 'sep–dic'];

/** Posición en las tablas por pareja de último dígito (1-2, 3-4, 5-6, 7-8, 9-0). */
function pairIndex(digit: number): number {
  return Math.floor(digitIndex(digit) / 2);
}

/** Posición en la tabla de renta de personas naturales (01-02 … 99-00). */
function naturalPairIndex(two: number): number {
  const n = two === 0 ? 100 : two;
  return Math.ceil(n / 2) - 1;
}

/** Posición en la tabla general de exógena (01-05 … 96-00). */
function fiveRangeIndex(two: number): number {
  const n = two === 0 ? 100 : two;
  return Math.ceil(n / 5) - 1;
}

/**
 * PILA, Decreto 1990 de 2016: los dos últimos dígitos → día hábil del mes.
 * 00-07 → 2.º, 08-14 → 3.º, … 94-99 → 16.º.
 */
export function pilaBusinessDay(two: number): number {
  const bounds = [7, 14, 21, 28, 35, 42, 49, 56, 63, 69, 75, 81, 87, 93, 99];
  const i = bounds.findIndex((b) => two <= b);
  return 2 + (i === -1 ? bounds.length - 1 : i);
}

export function buildTaxCalendar(profile: ProfileForEngine, year: number): TaxCalendarResult {
  const cal = calendarFor(year);
  const gaps: string[] = [];
  if (!cal) {
    return {
      year,
      obligations: [],
      gaps: [`Cortex todavía no tiene las fechas del calendario tributario de ${year}.`],
    };
  }
  const nit = profile.nit;
  const d1 = lastDigit(nit);
  const d2 = lastTwoDigits(nit);
  const out: GeneratedObligation[] = [];

  const push = (
    o: Omit<GeneratedObligation, 'year' | 'ruleVersion' | 'needsConfirmation' | 'sourceNote'> & {
      needsConfirmation?: boolean;
      sourceNote?: string | null;
    },
  ) => {
    out.push({
      ...o,
      year,
      ruleVersion: cal.ruleVersion,
      needsConfirmation: cal.allNeedConfirmation || Boolean(o.needsConfirmation),
      sourceNote:
        o.sourceNote ??
        (cal.verifiedAgainst
          ? cal.verifiedAgainst
          : 'Calculada con la regla del Decreto 2229 de 2023'),
    });
  };
  const byDigit = (month: string) => dueByDigit(cal, month, d1);
  const ag = year - 1; // año gravable de lo que se declara en el año

  // --- Renta -----------------------------------------------------------------
  // En el Régimen Simple la declaración anual consolidada reemplaza la renta.
  if (!profile.regimenSimple) {
    if (profile.personType === 'juridica' && profile.granContribuyente) {
      const plan: Array<[string, string, string]> = [
        ['gc-c1', `${year}-02`, 'primera cuota'],
        ['gc-dec', `${year}-04`, 'declaración y segunda cuota'],
        ['gc-c3', `${year}-06`, 'tercera cuota'],
      ];
      for (const [code, month, what] of plan) {
        const due = byDigit(month);
        if (!due) continue;
        push({
          key: `renta:${code}`,
          kind: 'renta',
          period: `Año gravable ${ag}`,
          title: `Renta ${ag} — ${what} (gran contribuyente)`,
          authority: 'DIAN',
          form: '110',
          dueDate: due,
          requiresPayment: true,
        });
      }
    } else if (profile.personType === 'juridica') {
      const plan: Array<[string, string, string]> = [
        ['pj-dec', `${year}-05`, 'declaración y primera cuota'],
        ['pj-c2', `${year}-07`, 'segunda cuota'],
      ];
      for (const [code, month, what] of plan) {
        const due = byDigit(month);
        if (!due) continue;
        push({
          key: `renta:${code}`,
          kind: 'renta',
          period: `Año gravable ${ag}`,
          title: `Renta ${ag} — ${what}`,
          authority: 'DIAN',
          form: '110',
          dueDate: due,
          requiresPayment: true,
        });
      }
    } else {
      const due = cal.rentaNaturales[naturalPairIndex(d2)];
      if (due)
        push({
          key: 'renta:pn',
          kind: 'renta',
          period: `Año gravable ${ag}`,
          title: `Renta ${ag} — declaración de persona natural`,
          authority: 'DIAN',
          form: '210',
          dueDate: due,
          requiresPayment: true,
        });
    }
  }

  // --- Activos en el exterior: el mismo día que la renta o el Simple ---------
  if (profile.activosExterior) {
    const due = profile.regimenSimple
      ? cal.simpleDeclaracion[pairIndex(d1)]
      : profile.personType === 'natural'
        ? cal.rentaNaturales[naturalPairIndex(d2)]
        : byDigit(profile.granContribuyente ? `${year}-04` : `${year}-05`);
    if (due)
      push({
        key: 'activos_exterior:anual',
        kind: 'activos_exterior',
        period: `Activos al 1 de enero de ${year}`,
        title: `Declaración de activos en el exterior ${year}`,
        authority: 'DIAN',
        form: '160',
        dueDate: due,
        requiresPayment: false,
        sourceNote: `${cal.verifiedAgainst || 'Regla del Decreto 2229 de 2023'}. Aplica si los activos en el exterior al 1 de enero superan 2.000 UVT`,
      });
  }

  // --- Régimen Simple ----------------------------------------------------------
  if (profile.regimenSimple) {
    const dec = cal.simpleDeclaracion[pairIndex(d1)];
    if (dec)
      push({
        key: 'simple_declaracion:anual',
        kind: 'simple_declaracion',
        period: `Año gravable ${ag}`,
        title: `Régimen Simple ${ag} — declaración anual consolidada`,
        authority: 'DIAN',
        form: '260',
        dueDate: dec,
        requiresPayment: true,
      });
    const anticipoMonths = [
      `${year}-05`,
      `${year}-06`,
      `${year}-07`,
      `${year}-09`,
      `${year}-11`,
      `${year + 1}-01`,
    ];
    anticipoMonths.forEach((month, i) => {
      const due = byDigit(month);
      if (!due) return;
      push({
        key: `simple_anticipo:b${i + 1}`,
        kind: 'simple_anticipo',
        period: `Bimestre ${i + 1} (${BIMESTERS[i]} ${year})`,
        title: `Anticipo del Régimen Simple — bimestre ${i + 1} (${BIMESTERS[i]})`,
        authority: 'DIAN',
        form: '2593',
        dueDate: due,
        requiresPayment: true,
        sourceNote: `${cal.verifiedAgainst || 'Regla del Decreto 2229 de 2023'}. Las personas naturales del Simple con ingresos de hasta 3.500 UVT no pagan anticipos`,
      });
    });
  }

  // --- IVA ---------------------------------------------------------------------
  if (profile.ivaPeriodicity !== 'none') {
    if (profile.regimenSimple) {
      // En el Simple el IVA se declara una vez al año, en febrero (año anterior).
      const due = cal.simpleIvaAnual[pairIndex(d1)];
      if (due)
        push({
          key: 'iva:simple-anual',
          kind: 'iva',
          period: `Año ${ag}`,
          title: `IVA ${ag} — declaración anual del Régimen Simple`,
          authority: 'DIAN',
          form: '300',
          dueDate: due,
          requiresPayment: true,
        });
    } else if (profile.ivaPeriodicity === 'bimestral') {
      for (let i = 0; i < 6; i++) {
        const due = byDigit(nextMonth(`${year}-01`, 2 * i + 2));
        if (!due) continue;
        push({
          key: `iva:b${i + 1}`,
          kind: 'iva',
          period: `Bimestre ${i + 1} (${BIMESTERS[i]} ${year})`,
          title: `IVA bimestral — bimestre ${i + 1} (${BIMESTERS[i]} ${year})`,
          authority: 'DIAN',
          form: '300',
          dueDate: due,
          requiresPayment: true,
        });
      }
    } else {
      for (let i = 0; i < 3; i++) {
        const due = byDigit(nextMonth(`${year}-01`, 4 * i + 4));
        if (!due) continue;
        push({
          key: `iva:c${i + 1}`,
          kind: 'iva',
          period: `Cuatrimestre ${i + 1} (${CUATRIMESTERS[i]} ${year})`,
          title: `IVA cuatrimestral — cuatrimestre ${i + 1} (${CUATRIMESTERS[i]} ${year})`,
          authority: 'DIAN',
          form: '300',
          dueDate: due,
          requiresPayment: true,
        });
      }
    }
  }

  // --- Retención en la fuente: el mes M vence en el mes M+1 -------------------
  if (profile.agenteRetencion) {
    for (let m = 1; m <= 12; m++) {
      const due = byDigit(nextMonth(`${year}-01`, m));
      if (!due) continue;
      const period = `${year}-${String(m).padStart(2, '0')}`;
      push({
        key: `retencion:${period}`,
        kind: 'retencion',
        period: `${monthLong(m)[0]?.toUpperCase()}${monthLong(m).slice(1)} ${year}`,
        title: `Retención en la fuente — ${monthLong(m)} ${year}`,
        authority: 'DIAN',
        form: '350',
        dueDate: due,
        requiresPayment: true,
      });
    }
  }

  // --- Exógena (año gravable anterior) ----------------------------------------
  if (profile.exogena) {
    if (!cal.exogena) {
      gaps.push(
        `Los plazos de información exógena de ${year} los fija una resolución de la DIAN que Cortex todavía no tiene.`,
      );
    } else {
      const due = profile.granContribuyente
        ? cal.exogena.gc[digitIndex(d1)]
        : cal.exogena.general[fiveRangeIndex(d2)];
      if (due)
        push({
          key: 'exogena:anual',
          kind: 'exogena',
          period: `Año gravable ${ag}`,
          title: `Información exógena ${ag}`,
          authority: 'DIAN',
          form: null,
          dueDate: due,
          requiresPayment: false,
          sourceNote: cal.exogena.verifiedAgainst,
        });
    }
  }

  // --- Nómina electrónica: 10.º día hábil del mes siguiente --------------------
  if (profile.nominaElectronica) {
    cal.nomina.forEach((due, i) => {
      const m = i + 1;
      push({
        key: `nomina_electronica:${year}-${String(m).padStart(2, '0')}`,
        kind: 'nomina_electronica',
        period: `Nómina de ${monthLong(m)} ${year}`,
        title: `Nómina electrónica — transmitir ${monthLong(m)} ${year}`,
        authority: 'DIAN',
        form: null,
        dueDate: due,
        requiresPayment: false,
        needsConfirmation: cal.nominaUnverifiedMonths.includes(m),
        sourceNote: 'Resolución DIAN 000013 de 2021: décimo día hábil del mes siguiente',
      });
    });
  }

  // --- PILA: por los dos últimos dígitos, en el mes del pago -------------------
  if (profile.pila) {
    const n = pilaBusinessDay(d2);
    for (let m = 1; m <= 12; m++) {
      const month = `${year}-${String(m).padStart(2, '0')}`;
      // Abril de 2026: no se confirmó si el Día Cívico (17) cuenta como no
      // hábil para la PILA. Desde el 11.º día hábil la fecha depende de eso.
      const civicDoubt = year === 2026 && m === 4 && n >= 11;
      push({
        key: `pila:${month}`,
        kind: 'pila',
        period: `${monthLong(m)[0]?.toUpperCase()}${monthLong(m).slice(1)} ${year}`,
        title: `Seguridad social (PILA) — planilla de ${monthLong(m)}`,
        authority: 'Operador de PILA',
        form: null,
        dueDate: nthBusinessDay(month, n),
        requiresPayment: true,
        needsConfirmation: civicDoubt,
        sourceNote: `Decreto 1990 de 2016: ${n}.º día hábil del mes por los dos últimos dígitos del NIT`,
      });
    }
  }

  // --- Cámara de Comercio --------------------------------------------------------
  if (profile.camaraComercio) {
    push({
      key: `camara_comercio:${year}`,
      kind: 'camara_comercio',
      period: `Matrícula ${year}`,
      title: `Renovar la matrícula mercantil ${year}`,
      authority: 'Cámara de Comercio',
      form: null,
      dueDate: cal.camaraComercio,
      requiresPayment: true,
      sourceNote: 'Código de Comercio, art. 33: dentro de los tres primeros meses del año',
    });
  }

  // --- Impuesto al patrimonio (0197): declaración y dos cuotas ----------------
  // La fecha sale de la regla por último dígito (mayo y septiembre); todo por
  // confirmar: quién está obligado cambió con la emergencia económica de
  // diciembre de 2025 y no se verificó contra el calendario de la DIAN.
  if (profile.impuestoPatrimonio) {
    const plan: Array<[string, string, string]> = [
      ['dec', `${year}-05`, 'declaración y primera cuota'],
      ['c2', `${year}-09`, 'segunda cuota'],
    ];
    for (const [code, month, what] of plan) {
      const due = byDigit(month);
      if (!due) continue;
      push({
        key: `patrimonio:${code}`,
        kind: 'patrimonio',
        period: `Patrimonio al 1 de enero de ${year}`,
        title: `Impuesto al patrimonio ${year} — ${what}`,
        authority: 'DIAN',
        form: '420',
        dueDate: due,
        requiresPayment: true,
        needsConfirmation: true,
        sourceNote:
          'Ley 2277 de 2022 (art. 292-3 ET): personas naturales con patrimonio líquido de 72.000 UVT o más al 1 de enero. Fecha calculada por último dígito; confirma con tu contador si aplica y cuándo vence',
      });
    }
  }

  // --- Precios de transferencia (0197): declaración informativa -------------
  if (profile.vinculadosExterior && profile.personType === 'juridica') {
    const due = byDigit(`${year}-09`);
    if (due)
      push({
        key: 'precios_transferencia:dec',
        kind: 'precios_transferencia',
        period: `Año gravable ${ag}`,
        title: `Precios de transferencia ${ag} — declaración informativa`,
        authority: 'DIAN',
        form: '120',
        dueDate: due,
        requiresPayment: false,
        needsConfirmation: true,
        sourceNote:
          'Art. 260-5 ET: aplica con operaciones con vinculados del exterior si el patrimonio bruto es de 100.000 UVT o más o los ingresos de 61.000 UVT o más. Fecha calculada por último dígito en septiembre; la documentación comprobatoria tiene otra fecha: confirma con tu contador',
      });
  }

  // --- RUB (0197): dentro del mes siguiente a cada cambio ---------------------
  if (profile.personType === 'juridica') {
    const change = profile.rubLastChange ?? null;
    const changeYear = change ? Number(change.slice(0, 4)) : null;
    if (change && changeYear !== null) {
      const next = nextMonth(change.slice(0, 7), 1);
      const [ny, nm] = next.split('-').map(Number) as [number, number];
      const monthEnd = new Date(Date.UTC(ny, nm, 0)).toISOString().slice(0, 10);
      // Último día del mes siguiente; si es sábado, domingo o festivo, el hábil que sigue.
      const due = nextTaxBusinessDay(monthEnd);
      if (Number(monthEnd.slice(0, 4)) === year)
        push({
          key: `rub:${change}`,
          kind: 'rub',
          period: `Cambio del ${change}`,
          title: 'Actualizar el registro de beneficiarios finales (RUB)',
          authority: 'DIAN',
          form: null,
          dueDate: due,
          requiresPayment: false,
          needsConfirmation: true,
          sourceNote:
            'Resolución DIAN 000164 de 2021 (mod. 000037 de 2022): se actualiza dentro del mes siguiente a cualquier cambio de beneficiarios finales. Confirma la fecha con tu contador',
        });
    } else {
      gaps.push(
        'El registro de beneficiarios finales (RUB) no tiene fecha fija: se actualiza dentro del mes siguiente a cada cambio de socios o beneficiarios finales. Anota en el perfil la fecha del último cambio y armo el vencimiento.',
      );
    }
  }

  // --- ICA -----------------------------------------------------------------------
  if (profile.icaCity) pushIca(profile, cal, d1, push, gaps);

  // --- Facturación electrónica ------------------------------------------------------
  if (profile.facturacionElectronica) {
    gaps.push(
      'La factura electrónica se transmite al expedirla: no tiene fecha de calendario. Para no perder las recibidas, activa «Descargar facturas electrónicas recibidas de la DIAN» en Procesos.',
    );
  }

  out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.key.localeCompare(b.key));
  return { year, obligations: out, gaps };
}

function pushIca(
  profile: ProfileForEngine,
  cal: CoCalendarYear,
  d1: number,
  push: (
    o: Omit<GeneratedObligation, 'year' | 'ruleVersion' | 'needsConfirmation' | 'sourceNote'> & {
      needsConfirmation?: boolean;
      sourceNote?: string | null;
    },
  ) => void,
  gaps: string[],
): void {
  const city = profile.icaCity;
  if (!city) return;
  const label = ICA_CITY_LABEL[city];
  const ica = cal.ica;
  const year = cal.year;
  const common = {
    kind: 'ica' as ObligationKind,
    form: null,
    requiresPayment: true,
    // Municipal y verificado sólo en fuentes secundarias: siempre por confirmar.
    needsConfirmation: true,
    sourceNote: ica?.verifiedAgainst ?? null,
  };
  if (!ica || city === 'otra' || city === 'cali' || city === 'barranquilla') {
    gaps.push(
      city === 'otra'
        ? 'Cortex no tiene el calendario de ICA de tu ciudad: pídele las fechas a tu contador y anótalas como vencimientos.'
        : `Las fechas de ICA de ${label} de ${year} no están en Cortex (no se encontraron publicadas): pídeselas a tu contador.`,
    );
    return;
  }
  if (city === 'bogota') {
    if (profile.icaPeriodicity === 'anual') {
      if (ica.bogotaAnual)
        push({
          ...common,
          key: `ica:bog-anual-${year}`,
          period: `Año gravable ${year}`,
          title: `ICA Bogotá ${year} — declaración anual`,
          authority: 'Secretaría de Hacienda de Bogotá',
          dueDate: ica.bogotaAnual,
        });
      else gaps.push(`La fecha del ICA anual de Bogotá de ${year} no está en Cortex.`);
      return;
    }
    (ica.bogotaBimestral ?? []).forEach((due, i) => {
      push({
        ...common,
        key: `ica:bog-b${i + 1}`,
        period: `Bimestre ${i + 1} (${BIMESTERS[i]} ${year})`,
        title: `ICA Bogotá — bimestre ${i + 1} (${BIMESTERS[i]} ${year})`,
        authority: 'Secretaría de Hacienda de Bogotá',
        dueDate: due,
      });
    });
    return;
  }
  // Medellín
  if (profile.icaPeriodicity === 'bimestral') {
    (ica.medellinBimestral ?? []).forEach((due, i) => {
      push({
        ...common,
        key: `ica:med-b${i + 1}`,
        period: `Bimestre ${i + 1} (${BIMESTERS[i]} ${year})`,
        title: `ICA Medellín (régimen simplificado) — bimestre ${i + 1}`,
        authority: 'Secretaría de Hacienda de Medellín',
        dueDate: due,
      });
    });
    return;
  }
  const due = ica.medellinAnual?.[digitIndex(d1)];
  if (due)
    push({
      ...common,
      key: `ica:med-anual-${year - 1}`,
      period: `Año gravable ${year - 1}`,
      title: `ICA Medellín ${year - 1} — declaración anual`,
      authority: 'Secretaría de Hacienda de Medellín',
      dueDate: due,
    });
}

/** Sólo las obligaciones (lo que guarda la sincronización). */
export function generateObligations(
  profile: ProfileForEngine,
  year: number,
): GeneratedObligation[] {
  return buildTaxCalendar(profile, year).obligations;
}

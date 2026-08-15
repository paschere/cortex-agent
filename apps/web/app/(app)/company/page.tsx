import { PageHeader } from '@/components/ui/page-header';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  COMPANY_SECTIONS,
  adaptDirectoryPerson,
  buildOrgLine,
  hydrateCompanyFacts,
  listCompanyFacts,
  listDirectory,
  renderCompanyFactsBlock,
} from '@cortex/agent-tools';
import { IdCard } from 'lucide-react';
import { CompanyBoard } from './_components/CompanyBoard';
import { ReportingLine } from './_components/ReportingLine';
import type { FactView, SectionView } from './_components/types';

/**
 * Datos de la empresa.
 *
 * ===========================================================================
 * QUÉ ES ESTA PANTALLA Y POR QUÉ NO SE PARECE A UN FORMULARIO
 * ===========================================================================
 * Todo lo que se escriba aquí entra ENTERO en el prompt de cada respuesta que
 * Cortex da en el chat, en Google Chat, por MCP y en cada rutina desatendida. No
 * es un perfil de empresa que alguien consulta: es lo que Cortex cree, y por eso
 * la pantalla tiene que enseñar dos cosas que un formulario normal no enseña.
 *
 *   QUÉ SABE Y QUÉ LE FALTA. Cada sección lleva sus campos SUGERIDOS que nadie
 *   ha respondido todavía, como fichas en las que se puede pulsar. Ahí está el
 *   estado vacío del producto: no un cartel que diga «no hay datos», sino los
 *   ocho renglones que faltan, cada uno a un clic de existir.
 *
 *   CUÁNTO CUESTA. El medidor de arriba no es decoración ni una barra de
 *   progreso: la ficha compite por el mismo contexto que los documentos del
 *   cerebro, así que se dice en caracteres, se mueve mientras alguien teclea, y
 *   se pasa de rojo antes de que el guardado lo rechace. NUNCA SE TRUNCA EN
 *   SILENCIO — un límite aplicado donde nadie lo ve es peor que no tenerlo.
 *
 * ===========================================================================
 * VER ES DE TODOS, ESCRIBIR ES DE ADMIN. Y VIVE FUERA DE `/admin/*`
 * ===========================================================================
 * Ésta es la decisión de la pantalla. Las otras seis filas de «La empresa» son
 * de administración —quién entra, qué se auditó, qué se permitió— y esconderlas
 * no le quita nada a nadie. Esta no: es la EXPLICACIÓN de las respuestas que
 * recibe todo el día cualquiera del equipo. Escondérsela deja como única forma
 * de saber por qué Cortex contestó lo que contestó preguntárselo a Cortex, que
 * es justamente el testigo cuya versión se quiere contrastar.
 *
 * Por eso la ruta es `/company` y no `/admin/company`: aquel layout hace
 * `notFound()` a quien no es admin, y heredarlo habría decidido lo contrario sin
 * discutirlo. El permiso de escritura se hace cumplir en `actions.ts`, que
 * comprueba el rol en cada acción — esconder el botón no esconde la ruta.
 *
 * Todas las lecturas pasan por el handle con alcance.
 */

export const dynamic = 'force-dynamic';

export default async function CompanyPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  const [rows, directory] = await Promise.all([
    hydrateCompanyFacts(db, await listCompanyFacts(db)),
    listDirectory(db),
  ]);

  const facts: FactView[] = rows.map((r) => ({
    id: r.id,
    section: r.section,
    label: r.label,
    value: r.value,
    updatedByName: r.updated_by_name ?? null,
    updatedOn: r.updated_at.slice(0, 10),
  }));

  const sections: SectionView[] = COMPANY_SECTIONS.map((s) => ({
    key: s.key,
    name: s.name,
    blurb: s.blurb,
    suggested: [...s.suggested],
  }));

  // EL BLOQUE DE VERDAD, RENDERIZADO POR LA MISMA FUNCIÓN QUE LO INYECTA.
  //
  // Se baja como texto para que quien quiera pueda leer literalmente lo que
  // Cortex recibe. No es una previsualización aproximada ni una reconstrucción:
  // es `renderCompanyFactsBlock` sobre las mismas filas, la misma llamada que
  // hace `buildSystemPrompt`. Una previsualización que se pareciera al bloque
  // sin serlo sería peor que no tener ninguna — se leería como una garantía.
  const block = renderCompanyFactsBlock(
    rows.map((r) => ({ section: r.section, label: r.label, value: r.value })),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Datos de la empresa"
        subtitle="Lo que Cortex sabe de ustedes sin que se lo cuenten cada vez. Va entero en cada respuesta, en el chat, en Google Chat y en las rutinas."
        icon={<IdCard className="h-5 w-5" aria-hidden />}
      />
      <CompanyBoard
        facts={facts}
        sections={sections}
        canEdit={user.role === 'org_admin'}
        block={block}
        // EL NOMBRE DEL ESPACIO DE TRABAJO, COMO SEMILLA Y NADA MÁS. Es lo que
        // alguien tecleó al registrarse, así que no se propone como razón
        // social —eso sería devolverle su propia respuesta con un sello— pero
        // sí ahorra teclearlo otra vez en el buscador, y ahí es editable.
        seedName={user.organization.name}
      />

      {/*
        DEBAJO DE LA FICHA Y NO DENTRO DE ELLA, y ésa es la decisión.

        La sección «Quién es quién» de arriba la escribe una persona a mano y
        contesta quién DECIDE qué —incluida la gente que no tiene cuenta—. Este
        bloque se deriva de `users.manager_id` y contesta quién RESPONDE ante
        quién entre los que sí la tienen. Se pensó derivar la una de la otra y se
        descartó por lo mismo que este módulo se negó a contar empleados desde
        `users`: la jerarquía sólo cubre a quien tiene cuenta, así que venderla
        como el «Quién es quién» de la empresa sería una cifra exacta con una
        respuesta falsa. Van juntas y separadas, cada una diciendo lo que es.

        Y no entra en el bloque del prompt: la ficha tiene un presupuesto de
        4.000 caracteres que se paga en CADA turno de CADA superficie, y una
        lista de nombres sería lo primero que habría que recortar. Cortex la
        consulta cuando hace falta, con `directory.line`.
      */}
      <ReportingLine
        line={buildOrgLine(directory.map(adaptDirectoryPerson))}
        total={directory.length}
        canEdit={user.role === 'org_admin'}
      />
    </div>
  );
}

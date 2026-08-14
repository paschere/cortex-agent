/**
 * La ficha de la empresa (migración 0104).
 *
 * Barril estrecho, como el de `goals/` y el de `payments/`. Sale lo que la
 * pantalla, el prompt y la herramienta necesitan de verdad.
 *
 * `renderCompanyFactsBlock` sale por aquí a propósito y es la pieza que hace que
 * esto valga algo: la importa `apps/web/lib/system-prompt.ts`, que es EL único
 * sitio donde se arma un prompt de Cortex, y por tanto la ficha llega a la web,
 * a Google Chat y a MCP por construcción y no por acordarse.
 */

export {
  COMPANY_FACTS_BUDGET,
  COMPANY_FACTS_MAX,
  COMPANY_FACT_LABEL_MAX,
  COMPANY_FACT_VALUE_MAX,
  COMPANY_SECTIONS,
  COMPANY_SECTION_KEYS,
  UnknownCompanySectionError,
  companyFactsBudget,
  companySectionByKey,
  renderCompanyFactsBlock,
  weighCompanyFact,
  weighCompanyFacts,
} from './shape';
export type { CompanyFact, CompanyFactsBudget, CompanySection } from './shape';

export {
  COMPANY_FACT_COLUMNS,
  deleteCompanyFact,
  hydrateCompanyFacts,
  listCompanyFacts,
  loadCompanyFactsContext,
  writeCompanyFact,
} from './store';
export type { CompanyFactRow, WriteCompanyFactInput } from './store';

// Una sola herramienta, y de lectura. El porqué de que no haya una de escritura
// está argumentado entero en la cabecera de ./tools.ts, y es la decisión del
// módulo: el objeto que editaría ES el límite que la gobierna.
export { companyFacts } from './tools';

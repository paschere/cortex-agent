// Side-effect registration of the clients tools, plus the pure core and the
// store the web screens read through.
//
// This module is the axis the rest of Cortex hangs off. Nothing here stores new
// memory: the mail, the transcripts, the documents and the deadlines were
// already saved by the modules that own them. What this adds is the noun that
// makes them reachable together — see the header of migration 0075.
export { clientsSearch } from './search';
export { clientsDirectory } from './directory';
export { clientsOverview, resolveClient } from './overview';
export { clientsRegister, domainWarning } from './register';
export { clientsLink } from './link';

export {
  APPLYING_METHODS,
  CLIENT_COLUMNS,
  CLIENT_SERVICES,
  CLIENT_STATUSES,
  CONTACT_COLUMNS,
  CUSTOMS_ROLES,
  CUSTOMS_ROLE_LABEL,
  DOMAIN_COLUMNS,
  ENTITY_KIND_LABEL,
  InvalidNitError,
  LINK_COLUMNS,
  LINK_ENTITY_KINDS,
  LINK_METHODS,
  LINK_STATES,
  LINK_STATE_LABEL,
  METHOD_CONFIDENCE,
  METHOD_LABEL,
  METHOD_SENTENCE,
  PUBLIC_EMAIL_DOMAINS,
  SERVICE_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  adaptClient,
  adaptContact,
  adaptLink,
  clientSchema,
  contactSchema,
  formatNit,
  fullNit,
  isPublicDomain,
  linkSchema,
  matchByText,
  methodApplies,
  nameKey,
  nitDv,
  normalizeDomain,
  normalizeEmail,
  normalizeNit,
  parseNit,
  strictNameKey,
} from './shape';
// Renamed on the way out: ./outlook exports a `domainOf` of its own, and two
// barrels exporting one name is an ambiguity TypeScript refuses. The function
// keeps its plain name inside the module.
export { domainOf as clientDomainOf } from './shape';
export type {
  Candidate,
  Client,
  ClientRow,
  ClientService,
  ClientStatus,
  Contact,
  ContactRow,
  CustomsRole,
  DomainRow,
  Link,
  LinkEntityKind,
  LinkMethod,
  LinkRow,
  LinkState,
  MatchResult,
  MatchableClient,
  ParsedNit,
} from './shape';

export {
  addDomain,
  applyOrPropose,
  clientForEmail,
  clientOverview,
  confirmLink,
  findClientByName,
  findClientByNit,
  getClient,
  listClients,
  listContacts,
  listDomains,
  listLinks,
  listProposals,
  matchCommitmentsToClients,
  registerClient,
  rejectLink,
  removeDomain,
  searchClients,
  unlinkedCounterparties,
  updateClient,
  upsertContact,
} from './store';
export type {
  ClientInput,
  ClientOverview,
  ContactInput,
  CounterpartyBacklog,
  CounterpartyMatchResult,
  EmailOwner,
  LinkInput,
  LinkOutcome,
  LinkTarget,
  ListClientsOptions,
  ListLinksOptions,
  OverviewCommitment,
  RegisterResult,
  SearchHit,
} from './store';

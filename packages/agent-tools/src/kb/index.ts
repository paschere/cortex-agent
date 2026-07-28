export { parseDocument } from './parsers';
export type { ParseResult } from './parsers';
export { chunkText } from './chunker';
export type { Chunk } from './chunker';
export { embed } from './embedder';
export { kbSearch } from './search';
export { kbListSpaces } from './list-spaces';
export { kbCreateDocument } from './create-document';
export { kbContext } from './context';
export {
  assertCanWriteToSpace,
  ensurePersonalSpace,
  getVisibleDocument,
  getVisibleSpace,
  isOrgAdmin,
  listVisibleSpaces,
  resolveSpaceByName,
  searchSpaces,
} from './spaces';
export type { Space, SpaceHit, SpaceKind, SearchSpacesOptions } from './spaces';

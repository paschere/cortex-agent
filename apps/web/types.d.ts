// Re-declare pdf-parse sub-path import used by @zipdev/agent-tools/kb/parsers
// when TypeScript processes the workspace source directly.
declare module 'pdf-parse/lib/pdf-parse.js' {
  import type PdfParse from 'pdf-parse';
  const parse: typeof PdfParse;
  export default parse;
}

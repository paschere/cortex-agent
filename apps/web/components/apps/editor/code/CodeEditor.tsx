'use client';

import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { sql } from '@codemirror/lang-sql';
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { type Diagnostic, lintGutter, lintKeymap, setDiagnostics } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { useEffect, useRef } from 'react';

/**
 * EL EDITOR DE CÓDIGO (CodeMirror 6) de las apps con código.
 *
 * Se carga con `next/dynamic` desde CodeTab: ni CodeMirror ni sus lenguajes
 * entran en el bundle de las pantallas de la app. Los colores salen de las
 * variables de la paleta (`--surface`, `--ink`, `--primary`…), así que el claro
 * y el oscuro del espacio de trabajo se siguen solos, sin segundo tema.
 */

export interface EditorMark {
  line: number;
  col: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface CodeEditorProps {
  path: string;
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  marks: EditorMark[];
  /** Mover el cursor a esta posición (el `nonce` distingue dos saltos al mismo sitio). */
  jump?: { line: number; col: number; nonce: number } | null;
}

const v = (name: string, alpha?: number) =>
  alpha === undefined ? `rgb(var(--${name}))` : `rgb(var(--${name}) / ${alpha})`;

const theme = EditorView.theme({
  '&': {
    color: v('ink'),
    backgroundColor: v('surface'),
    fontSize: '12px',
    height: '100%',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    lineHeight: '1.6',
  },
  '.cm-content': { caretColor: v('primary'), padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: v('primary') },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: v('primary', 0.22) },
  '.cm-activeLine': { backgroundColor: v('surface-2', 0.55) },
  '.cm-gutters': {
    backgroundColor: v('surface-2'),
    color: v('ink-faint'),
    border: 'none',
    borderRight: `1px solid ${v('border')}`,
  },
  '.cm-activeLineGutter': { backgroundColor: v('primary-soft'), color: v('primary-ink') },
  '.cm-foldPlaceholder': { backgroundColor: v('surface-2'), border: 'none', color: v('ink-muted') },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: v('primary', 0.18),
    outline: `1px solid ${v('primary', 0.4)}`,
  },
  '.cm-selectionMatch': { backgroundColor: v('highlight', 0.5) },
  '.cm-searchMatch': { backgroundColor: v('highlight', 0.55), outline: `1px solid ${v('amber')}` },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: v('amber', 0.45) },
  '.cm-panels': { backgroundColor: v('surface-2'), color: v('ink'), borderColor: v('border') },
  '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${v('border')}` },
  '.cm-panel.cm-search': { fontSize: '11px', padding: '6px 8px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontSize: '11px' },
  '.cm-textfield': {
    backgroundColor: v('surface'),
    color: v('ink'),
    border: `1px solid ${v('border')}`,
    borderRadius: '999px',
    padding: '2px 8px',
  },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: v('surface'),
    color: v('ink'),
    border: `1px solid ${v('border')}`,
    borderRadius: '999px',
    padding: '2px 8px',
  },
  '.cm-tooltip': {
    backgroundColor: v('surface'),
    color: v('ink'),
    border: `1px solid ${v('border-strong')}`,
    borderRadius: '8px',
    boxShadow: 'var(--shadow-pop)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: v('primary-soft'),
    color: v('primary-ink'),
  },
  '.cm-tooltip-lint': { maxWidth: '28rem' },
  '.cm-diagnostic-error': { borderLeft: `3px solid ${v('rose')}` },
  '.cm-diagnostic-warning': { borderLeft: `3px solid ${v('amber')}` },
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: `underline wavy ${v('rose')}`,
    textUnderlineOffset: '3px',
  },
  '.cm-lintRange-warning': {
    backgroundImage: 'none',
    textDecoration: `underline wavy ${v('amber')}`,
    textUnderlineOffset: '3px',
  },
});

const highlight = HighlightStyle.define([
  {
    tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword],
    color: v('primary-strong'),
  },
  { tag: [t.string, t.special(t.string), t.regexp], color: v('emerald') },
  { tag: [t.number, t.bool, t.null, t.atom], color: v('amber') },
  { tag: [t.comment, t.lineComment, t.blockComment], color: v('ink-faint'), fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.namespace], color: v('sky') },
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.definition(t.function(t.variableName)),
    ],
    color: v('primary-ink'),
  },
  { tag: [t.propertyName, t.attributeName], color: v('ink') },
  { tag: [t.tagName, t.angleBracket], color: v('rose') },
  { tag: [t.definition(t.variableName), t.variableName], color: v('ink') },
  { tag: [t.operator, t.punctuation, t.bracket], color: v('ink-muted') },
  { tag: t.heading, fontWeight: '700', color: v('primary-ink') },
  { tag: t.invalid, color: v('rose') },
]);

function languageFor(path: string): Extension {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'ts':
    case 'mts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'jsx':
      return javascript({ jsx: true });
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript();
    case 'css':
      return css();
    case 'json':
      return json();
    case 'sql':
      return sql();
    default:
      return [];
  }
}

function toDiagnostics(state: EditorState, marks: EditorMark[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const m of marks) {
    if (m.line < 1 || m.line > state.doc.lines) continue;
    const line = state.doc.line(m.line);
    const from = Math.min(line.to, line.from + Math.max(0, m.col - 1));
    // Subraya la palabra que empieza ahí (o, si no hay, un carácter).
    const word = /^[\w$.@-]+|^["'`][^"'`]*["'`]?/.exec(state.doc.sliceString(from, line.to));
    const to = Math.min(line.to, from + Math.max(1, word?.[0].length ?? 1));
    out.push({
      from: Math.min(from, Math.max(line.from, to - 1)),
      to: Math.max(to, from),
      severity: m.severity,
      message: m.message,
    });
  }
  return out;
}

export default function CodeEditor({
  path,
  value,
  onChange,
  onSave,
  marks,
  jump,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Un estado por archivo: conserva deshacer, cursor y plegado al cambiar de pestaña.
  const states = useRef(new Map<string, EditorState>());
  const current = useRef(path);
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };
  const marksRef = useRef(marks);
  marksRef.current = marks;

  const create = (p: string, doc: string) => {
    const state = EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        lintGutter(),
        history(),
        drawSelection(),
        indentOnInput(),
        indentUnit.of('  '),
        EditorState.tabSize.of(2),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        syntaxHighlighting(highlight),
        theme,
        languageFor(p),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              cb.current.onSave();
              return true;
            },
          },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          ...lintKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cb.current.onChange(u.state.doc.toString());
        }),
        EditorView.contentAttributes.of({
          'aria-label': `Contenido de ${p}`,
          spellcheck: 'false',
          autocapitalize: 'off',
          autocorrect: 'off',
        }),
      ],
    });
    return state.update(setDiagnostics(state, toDiagnostics(state, marksRef.current))).state;
  };

  // Montaje único.
  // biome-ignore lint/correctness/useExhaustiveDependencies: el montaje es una vez; lo demás se sincroniza abajo.
  useEffect(() => {
    if (!host.current) return;
    const ev = new EditorView({ state: create(path, value), parent: host.current });
    view.current = ev;
    current.current = path;
    return () => {
      ev.destroy();
      view.current = null;
      states.current.clear();
    };
  }, []);

  // Cambio de archivo, o contenido que cambió por fuera (recargar, traer de GitHub, renombrar).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `create` es estable en la práctica.
  useEffect(() => {
    const ev = view.current;
    if (!ev) return;
    if (current.current !== path) {
      states.current.set(current.current, ev.state);
      current.current = path;
      const cached = states.current.get(path);
      ev.setState(cached && cached.doc.toString() === value ? cached : create(path, value));
      return;
    }
    if (ev.state.doc.toString() !== value) {
      ev.dispatch({ changes: { from: 0, to: ev.state.doc.length, insert: value } });
    }
  }, [path, value]);

  // Las marcas del último registro.
  useEffect(() => {
    const ev = view.current;
    if (!ev) return;
    ev.dispatch(setDiagnostics(ev.state, toDiagnostics(ev.state, marks)));
  }, [marks]);

  // Saltar a una línea (clic en un error).
  useEffect(() => {
    const ev = view.current;
    if (!ev || !jump || jump.line < 1 || jump.line > ev.state.doc.lines) return;
    const line = ev.state.doc.line(jump.line);
    const pos = Math.min(line.to, line.from + Math.max(0, jump.col - 1));
    ev.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    });
    ev.focus();
  }, [jump]);

  return (
    <div
      ref={host}
      className="h-full min-h-0 overflow-hidden rounded-card border border-border bg-surface focus-within:border-primary"
    />
  );
}

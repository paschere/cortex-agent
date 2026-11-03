'use client';

import { clsx } from 'clsx';
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  Folder,
  FolderOpen,
  Pencil,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';

/** El árbol de archivos del proyecto: carpetas que se pliegan, puntos de «sin guardar», errores y quién tocó cada uno. */

export interface TreeNode {
  name: string;
  path: string;
  folder: boolean;
  children: TreeNode[];
}

/** De rutas planas a árbol: carpetas primero, luego archivos, cada grupo en orden alfabético. */
export function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', folder: true, children: [] };
  for (const p of paths) {
    const parts = p.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/');
      const isFile = i === parts.length - 1;
      let next = node.children.find((c) => c.name === part && c.folder === !isFile);
      if (!next) {
        next = { name: part, path, folder: !isFile, children: [] };
        node.children.push(next);
      }
      node = next;
    });
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) =>
      a.folder === b.folder ? a.name.localeCompare(b.name) : a.folder ? -1 : 1,
    );
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

export interface FileTreeProps {
  paths: string[];
  selected: string | null;
  dirty: Set<string>;
  /** Cantidad de errores del último registro por archivo. */
  errors: Record<string, number>;
  /** Archivos cuyo último autor es Cortex. */
  byCortex: Set<string>;
  disabled?: boolean;
  onSelect: (path: string) => void;
  onNew: (folder: string) => void;
  onRename: (path: string, folder: boolean) => void;
  onDelete: (path: string, folder: boolean) => void;
}

const ACTION =
  'rounded p-1 text-ink-faint opacity-0 hover:text-primary focus:opacity-100 group-hover:opacity-100 disabled:hidden';

export function FileTree(props: FileTreeProps) {
  const {
    paths,
    selected,
    dirty,
    errors,
    byCortex,
    disabled,
    onSelect,
    onNew,
    onRename,
    onDelete,
  } = props;
  const tree = useMemo(() => buildTree(paths), [paths]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (path: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  /** Una carpeta plegada muestra lo pendiente de lo que contiene. */
  const within = (folder: string, set: Set<string>) =>
    [...set].some((p) => p.startsWith(`${folder}/`));
  const errorsWithin = (folder: string) =>
    Object.entries(errors).reduce((n, [p, c]) => (p.startsWith(`${folder}/`) ? n + c : n), 0);

  function row(node: TreeNode, depth: number) {
    const pad = { paddingLeft: `${depth * 12 + 6}px` };
    if (node.folder) {
      const open = !collapsed.has(node.path);
      const Chevron = open ? ChevronDown : ChevronRight;
      const FolderIcon = open ? FolderOpen : Folder;
      return (
        <li key={`d:${node.path}`}>
          <div className="group flex items-center rounded hover:bg-surface" style={pad}>
            <button
              type="button"
              onClick={() => toggle(node.path)}
              aria-expanded={open}
              className="flex min-w-0 flex-1 items-center gap-1 py-1 text-left text-ink-muted"
            >
              <Chevron className="h-3 w-3 shrink-0" aria-hidden />
              <FolderIcon className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">{node.name}</span>
              {!open && within(node.path, dirty) && <span className="text-amber">●</span>}
              {!open && errorsWithin(node.path) > 0 && <span className="text-rose">●</span>}
            </button>
            <button
              type="button"
              aria-label={`Archivo nuevo en ${node.path}`}
              title="Archivo nuevo aquí"
              disabled={disabled}
              onClick={() => onNew(node.path)}
              className={ACTION}
            >
              <FilePlus2 className="h-3 w-3" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={`Renombrar carpeta ${node.path}`}
              title="Renombrar carpeta"
              disabled={disabled}
              onClick={() => onRename(node.path, true)}
              className={ACTION}
            >
              <Pencil className="h-3 w-3" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={`Borrar carpeta ${node.path}`}
              title="Borrar carpeta"
              disabled={disabled}
              onClick={() => onDelete(node.path, true)}
              className={clsx(ACTION, 'hover:!text-rose')}
            >
              <Trash2 className="h-3 w-3" aria-hidden />
            </button>
          </div>
          {open && <ul>{node.children.map((c) => row(c, depth + 1))}</ul>}
        </li>
      );
    }
    const errs = errors[node.path] ?? 0;
    return (
      <li key={`f:${node.path}`} className="group flex items-center rounded">
        <button
          type="button"
          onClick={() => onSelect(node.path)}
          title={node.path}
          style={{ paddingLeft: `${depth * 12 + 20}px` }}
          className={clsx(
            'flex min-w-0 flex-1 items-center gap-1 truncate rounded py-1 pr-1 text-left',
            selected === node.path
              ? 'bg-primary-soft text-primary-ink'
              : 'text-ink hover:bg-surface',
          )}
        >
          <span className="truncate">{node.name}</span>
          {dirty.has(node.path) && (
            <span className="text-amber" title="Sin guardar">
              ●
            </span>
          )}
          {errs > 0 && (
            <span
              className="rounded-pill bg-rose-soft px-1.5 text-micro font-semibold text-rose"
              title={`${errs} error(es) en la última compilación`}
            >
              {errs}
            </span>
          )}
          {byCortex.has(node.path) && (
            <Sparkles className="h-3 w-3 shrink-0 text-sky" aria-label="Lo escribió Cortex" />
          )}
        </button>
        <button
          type="button"
          aria-label={`Renombrar ${node.path}`}
          title="Renombrar o mover"
          disabled={disabled}
          onClick={() => onRename(node.path, false)}
          className={ACTION}
        >
          <Pencil className="h-3 w-3" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`Borrar ${node.path}`}
          title="Borrar"
          disabled={disabled}
          onClick={() => onDelete(node.path, false)}
          className={clsx(ACTION, 'hover:!text-rose')}
        >
          <Trash2 className="h-3 w-3" aria-hidden />
        </button>
      </li>
    );
  }

  return (
    <ul className="max-h-[32rem] overflow-auto rounded-card border border-border bg-surface-2 p-1.5 font-mono text-[11px]">
      {tree.length === 0 && <li className="px-2 py-1 text-ink-faint">Sin archivos todavía.</li>}
      {tree.map((n) => row(n, 0))}
    </ul>
  );
}

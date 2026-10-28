/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * A JupyterLab code cell with no kernel: the same `CodeCell` widget,
 * CodeMirror factory, extensions and languages jupyter-react's `Cell` builds,
 * over a standalone model, editable at once. jupyter-react's `Cell` waits for
 * its kernel before it builds anything; this one stands in for it while the
 * kernel connects or when it fails, so the overlay looks the same either
 * way (the JupyterLab theme's CodeMirror, prompt, colours and font).
 *
 * @module jupyter/sourceCell
 */

import type { YCodeCell } from '@jupyter/ydoc';
import { createStandaloneCell } from '@jupyter/ydoc';
import { Cell, CodeCell, CodeCellModel } from '@jupyterlab/cells';
import {
  CodeMirrorEditorFactory,
  EditorExtensionRegistry,
  EditorLanguageRegistry,
  EditorThemeRegistry,
  ybinding,
} from '@jupyterlab/codemirror';
import { RenderMimeRegistry } from '@jupyterlab/rendermime';
import { Lumino } from '@datalayer/jupyter-react';
import { useEffect, useId, useRef, useState } from 'react';

let factory: CodeMirrorEditorFactory | undefined;

/** The editor factory jupyter-react's `CellAdapter` builds (its themes, default extensions, the model's binding, the default languages), made once. */
function editorFactory(): CodeMirrorEditorFactory {
  if (factory !== undefined) return factory;
  const themes = new EditorThemeRegistry();
  for (const theme of EditorThemeRegistry.getDefaultThemes()) themes.addTheme(theme);
  const extensions = new EditorExtensionRegistry();
  for (const extension of EditorExtensionRegistry.getDefaultExtensions({ themes }))
    extensions.addExtension(extension);
  extensions.addExtension({
    name: 'shared-model-binding',
    factory: (options) => {
      const sharedModel = options.model.sharedModel as YCodeCell;
      return EditorExtensionRegistry.createImmutableExtension(
        ybinding({ ytext: sharedModel.ysource, undoManager: sharedModel.undoManager ?? undefined }),
      );
    },
  });
  const languages = new EditorLanguageRegistry();
  for (const language of EditorLanguageRegistry.getDefaultLanguages())
    languages.addLanguage(language);
  factory = new CodeMirrorEditorFactory({ extensions, languages });
  return factory;
}

/** The props of `<SourceCell>`. */
export interface SourceCellProps {
  /** The source the cell starts with; later changes are the cell's own. */
  readonly source: string;
  /** Each edit, with the whole source. */
  readonly onChange: (source: string) => void;
  /** The language's MIME type; Python's by default. */
  readonly mimeType?: string;
  /** Focus the editor once mounted. */
  readonly autoFocus?: boolean;
}

/**
 * A JupyterLab `CodeCell` over a standalone model, with no kernel and no
 * session: the source editable in the JupyterLab CodeMirror, its outputs
 * left to the caller. Inside jupyter-react's theme it looks as its `Cell` does.
 */
export function SourceCell({
  source,
  onChange,
  mimeType = 'text/x-ipython',
  autoFocus,
}: SourceCellProps) {
  const changed = useRef(onChange);
  changed.current = onChange;
  const initial = useRef({ source, mimeType, autoFocus });
  const id = useId();
  // Made in an effect, disposed in its cleanup (a strict mode's second mount makes another).
  const [cell, setCell] = useState<CodeCell>();
  useEffect(() => {
    const { source, mimeType, autoFocus } = initial.current;
    const factory = editorFactory();
    const sharedModel = createStandaloneCell({
      cell_type: 'code',
      source,
      metadata: {},
    }) as YCodeCell;
    const codeCell = new CodeCell({
      rendermime: new RenderMimeRegistry(),
      model: new CodeCellModel({ sharedModel }),
      contentFactory: new Cell.ContentFactory({
        editorFactory: factory.newInlineEditor.bind(factory),
      }),
    });
    codeCell.addClass('dla-Jupyter-Cell');
    codeCell.initializeState();
    codeCell.model.mimeType = mimeType;
    codeCell.model.contentChanged.connect((model) =>
      changed.current(model.sharedModel.getSource()),
    );
    setCell(codeCell);
    let frame = 0;
    if (autoFocus === true) frame = requestAnimationFrame(() => codeCell.editor?.focus());
    return () => {
      cancelAnimationFrame(frame);
      setCell(undefined);
      // After Lumino's own deferred detach.
      queueMicrotask(() =>
        queueMicrotask(() => {
          try {
            codeCell.dispose();
          } catch {
            // Its host is gone already: nothing left to tidy.
          }
        }),
      );
    };
  }, []);
  return (
    <div
      data-cells-source-cell=""
      style={{ position: 'relative' }}
      className="dla-Jupyter-SourceCell"
    >
      {cell !== undefined && (
        <Lumino id={`cells-source-cell-${id}`} height="auto">
          {cell}
        </Lumino>
      )}
    </div>
  );
}

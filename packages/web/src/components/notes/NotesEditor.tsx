"use client";

import { useEffect, useRef, useCallback } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, highlightActiveLine, placeholder as cmPlaceholder } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { wikilinkPlugin } from "./wikilinkPlugin";

interface NotesEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  onWikilinkClick?: (target: string) => void;
  onSave?: () => void;
  onQuickSwitch?: () => void;
}

const baseTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
  },
  ".cm-content": {
    fontFamily: "var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace",
    padding: "16px 0",
    caretColor: "var(--vk-accent)",
    lineHeight: "1.6",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--vk-accent)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "rgba(139, 92, 246, 0.25) !important",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--vk-text-muted)",
    border: "none",
    paddingRight: "8px",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--vk-text-normal)",
  },
  ".cm-activeLine": {
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  ".cm-line": {
    padding: "0 16px",
  },
  ".cm-placeholder": {
    color: "var(--vk-text-muted)",
    fontStyle: "italic",
    padding: "0 16px",
  },
});

export function NotesEditor({
  value,
  onChange,
  readOnly = false,
  placeholder = "Select a note to start editing",
  onWikilinkClick,
  onSave,
  onQuickSwitch,
}: NotesEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onQuickSwitchRef = useRef(onQuickSwitch);
  const onWikilinkClickRef = useRef(onWikilinkClick);
  const readOnlyCompartment = useRef(new Compartment());

  // Keep refs up to date
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onQuickSwitchRef.current = onQuickSwitch;
  onWikilinkClickRef.current = onWikilinkClick;

  const handleSave = useCallback(() => {
    onSaveRef.current?.();
    return true;
  }, []);

  const handleQuickSwitch = useCallback(() => {
    onQuickSwitchRef.current?.();
    return true;
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const isMac = typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);
    const modKey = isMac ? "Meta" : "Control";

    const state = EditorState.create({
      doc: value,
      extensions: [
        baseTheme,
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        EditorState.allowMultipleSelections.of(true),
        readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
        bracketMatching(),
        highlightActiveLine(),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        wikilinkPlugin,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        EditorView.domEventHandlers({
          click(event, view) {
            const pos = view.posAtCoords(event);
            if (pos == null) return false;

            const line = view.state.doc.lineAt(pos);
            const lineText = line.text;
            const lineOffset = pos - line.from;

            // Check for wikilink click
            const wikilinkRegex = /\[\[([^\]]+)\]\]/g;
            let match: RegExpExecArray | null;
            while ((match = wikilinkRegex.exec(lineText)) !== null) {
              const start = match.index;
              const end = start + match[0].length;
              if (lineOffset >= start && lineOffset <= end) {
                onWikilinkClickRef.current?.(match[1].trim());
                return true;
              }
            }
            return false;
          },
        }),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          {
            key: `${modKey}-s`,
            run: () => handleSave(),
            preventDefault: true,
          },
          {
            key: `${modKey}-k`,
            run: () => handleQuickSwitch(),
            preventDefault: true,
          },
        ]),
        EditorView.lineWrapping,
        placeholder ? cmPlaceholder(placeholder) : [],
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // We intentionally only run this once per mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external value changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const currentValue = view.state.doc.toString();
    if (currentValue !== value) {
      view.dispatch({
        changes: { from: 0, to: currentValue.length, insert: value },
      });
    }
  }, [value]);

  // Sync readOnly
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

  return (
    <div
      ref={containerRef}
      className="h-full min-h-0 w-full bg-[var(--vk-bg-main)] text-[var(--vk-text-normal)]"
    />
  );
}

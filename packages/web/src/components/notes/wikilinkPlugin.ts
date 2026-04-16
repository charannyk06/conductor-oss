import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type EditorState, RangeSetBuilder } from "@codemirror/state";

const wikilinkDecoration = Decoration.mark({
  class: "cm-wikilink",
  attributes: { style: "background-color: rgba(139, 92, 246, 0.15); border-radius: 3px; padding: 1px 3px; cursor: pointer; color: #cdb4ff;" },
});

const tagDecoration = Decoration.mark({
  class: "cm-tag",
  attributes: { style: "background-color: rgba(248, 147, 30, 0.12); border-radius: 3px; padding: 1px 3px; color: #f6c56f;" },
});

function buildDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = state.doc;

  // Process the full document text for wikilinks and tags
  const text = doc.toString();
  const lines = text.split("\n");

  let offset = 0;
  const decorations: { from: number; to: number; deco: Decoration }[] = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];

    // Find wikilinks: [[target]]
    const wikilinkRegex = /\[\[([^\]]+)\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = wikilinkRegex.exec(line)) !== null) {
      const from = offset + match.index;
      const to = from + match[0].length;
      decorations.push({ from, to, deco: wikilinkDecoration });
    }

    // Find inline tags: #tag (but not # heading at start of line)
    const tagRegex = /(^|[\s(])(#[a-zA-Z][\w/-]*)/g;
    while ((match = tagRegex.exec(line)) !== null) {
      // Check it's not a heading
      const fullMatch = match[2];
      const prefix = match[1];
      if (prefix === "" && match.index === 0) {
        // Check if it's followed by a space (heading)
        const afterHash = line.substring(match.index + 1);
        if (afterHash.startsWith(" ")) continue;
      }
      // It's a tag if the prefix is whitespace or paren or start-of-line, and it's not # followed by space
      const tagFrom = offset + match.index + match[1].length;
      const tagTo = tagFrom + fullMatch.length;
      decorations.push({ from: tagFrom, to: tagTo, deco: tagDecoration });
    }

    offset += line.length + 1; // +1 for newline
  }

  // Sort decorations by position
  decorations.sort((a, b) => a.from - b.from);

  for (const { from, to, deco } of decorations) {
    builder.add(from, to, deco);
  }

  return builder.finish();
}

export const wikilinkPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view.state);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.state);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

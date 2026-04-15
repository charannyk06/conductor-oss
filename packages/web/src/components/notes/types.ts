export type ViewMode = "split" | "edit" | "preview";

export type NoteFile = {
  path: string;
  displayPath: string;
  name: string;
  source: string | null;
  sizeBytes: number | null;
  modifiedAt: string | null;
  kind: string;
};

export type NotesIndexPayload = {
  editor: string;
  notesRoot: string | null;
  syncManagedByEditor: boolean;
  writable: boolean;
  files: NoteFile[];
  tags?: TagMap;
};

export type NoteFilePayload = {
  path: string;
  displayPath: string;
  content: string;
  size: number;
  truncated: boolean;
  modifiedAt: string | null;
  writable: boolean;
};

export type SaveNotePayload = {
  ok: boolean;
  path: string;
  displayPath: string;
  modifiedAt: string | null;
  savedBytes: number;
  created: boolean;
};

export type NotesTreeNode = {
  name: string;
  path: string;
  isDirectory: boolean;
  file?: NoteFile;
  children: NotesTreeNode[];
};

export type BacklinkInfo = {
  path: string;
  displayPath: string;
  name: string;
  context: string;
};

export type GraphNode = {
  id: string;
  name: string;
  tags?: string[];
};

export type GraphEdge = {
  source: string;
  target: string;
};

export type TagMap = Record<string, string[]>;

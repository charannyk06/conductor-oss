export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewLogEntry {
  id: string;
  kind: "console" | "network" | "pageerror";
  level: string;
  message: string;
  timestamp: string;
  url?: string | null;
  method?: string | null;
  status?: number | null;
  resourceType?: string | null;
}

export interface PreviewFrameInfo {
  id: string;
  name: string;
  url: string;
  parentId: string | null;
  isMain: boolean;
}

export interface PreviewDomNode {
  selector: string;
  tag: string;
  text: string;
  role: string | null;
  name: string | null;
  interactive: boolean;
  id: string | null;
  classes: string[];
  htmlPreview: string;
  bounds: PreviewBounds | null;
}

export interface PreviewElementSelection extends PreviewDomNode {
  frameId: string;
  frameName: string;
  frameUrl: string;
  attributes: Record<string, string>;
}

export interface PreviewStatusResponse {
  connected: boolean;
  candidateUrls: string[];
  currentUrl: string | null;
  title: string | null;
  frames: PreviewFrameInfo[];
  activeFrameId: string | null;
  selectedElement: PreviewElementSelection | null;
  consoleLogs: PreviewLogEntry[];
  networkLogs: PreviewLogEntry[];
  lastError: string | null;
  screenshotKey: string;
}

export interface PreviewDomResponse {
  frameId: string | null;
  nodes: PreviewDomNode[];
  truncated: boolean;
}

export type PreviewCommandRequest =
  | { command: "connect"; url: string }
  | { command: "navigate"; url: string }
  | { command: "reload" }
  | { command: "selectFrame"; frameId: string | null }
  | { command: "clickAtPoint"; x: number; y: number }
  | { command: "selectAtPoint"; x: number; y: number }
  | { command: "selectBySelector"; selector: string; frameId?: string | null };

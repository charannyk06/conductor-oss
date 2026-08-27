export type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: string[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  items?: JsonSchema;
};

export type WebMcpToolAnnotations = {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
};

export type WebMcpExecutionContext = {
  signal?: AbortSignal;
};

export type WebMcpToolDefinition<TArgs = unknown> = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: WebMcpToolAnnotations;
  execute(args: TArgs, context?: WebMcpExecutionContext): Promise<string> | string;
};

export type WebMcpRegistrationOptions = {
  signal?: AbortSignal;
};

export type WebMcpModelContext = {
  registerTool: (
    tool: WebMcpToolDefinition,
    options?: WebMcpRegistrationOptions,
  ) => void | Promise<void>;
};

export type WebMcpCompatibility = {
  supported: boolean;
  reason: string;
  toolRegistrationAvailable: boolean;
  modelContext: WebMcpModelContext | null;
};

declare global {
  interface Document {
    modelContext?: WebMcpModelContext;
  }

  interface Navigator {
    modelContext?: WebMcpModelContext;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export function jsonToolResult(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

export type BoundedStringResult = {
  value: string | null;
  error: string | null;
};

export function readBoundedString(
  value: unknown,
  fieldName: string,
  maxLength: number,
): BoundedStringResult {
  if (typeof value !== "string") {
    return { value: null, error: null };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { value: null, error: null };
  }
  if (trimmed.length > maxLength) {
    return {
      value: null,
      error: `${fieldName} must be at most ${maxLength} characters.`,
    };
  }
  return { value: trimmed, error: null };
}

export function detectWebMcpCompatibility(
  doc?: Pick<Document, "modelContext">,
  nav?: Pick<Navigator, "modelContext">,
): WebMcpCompatibility {
  if (!doc) {
    return {
      supported: false,
      reason: "Document context is unavailable.",
      toolRegistrationAvailable: false,
      modelContext: null,
    };
  }

  const modelContext = doc.modelContext ?? nav?.modelContext;
  if (!modelContext) {
    return {
      supported: false,
      reason: "document.modelContext and legacy navigator.modelContext are unavailable in this browser build.",
      toolRegistrationAvailable: false,
      modelContext: null,
    };
  }

  if (typeof modelContext.registerTool !== "function") {
    return {
      supported: false,
      reason: "document.modelContext.registerTool is unavailable in this browser build.",
      toolRegistrationAvailable: false,
      modelContext: null,
    };
  }

  return {
    supported: true,
    reason: "Browser-native WebMCP tool registration is available.",
    toolRegistrationAvailable: true,
    modelContext,
  };
}

export async function registerWebMcpTools(
  modelContext: WebMcpModelContext,
  tools: WebMcpToolDefinition[],
): Promise<() => void> {
  const controller = new AbortController();
  try {
    await Promise.all(tools.map((tool) => modelContext.registerTool(tool, { signal: controller.signal })));
  } catch (error) {
    controller.abort(error);
    throw error;
  }

  return () => {
    controller.abort(new Error("WebMCP tool registration disposed."));
  };
}

export function confirmedMutationRejected(
  toolName: string,
  effect: string,
): string {
  return jsonToolResult({
    ok: false,
    tool: toolName,
    error: `Rejected because ${effect} requires confirmed: true.`,
    requiresConfirmation: true,
  });
}

export function requireConfirmedMutation(
  args: { confirmed?: boolean } | null | undefined,
  toolName: string,
  effect: string,
): string | null {
  if (args?.confirmed === true) {
    return null;
  }
  return confirmedMutationRejected(toolName, effect);
}

export type HumanConfirmationRequest = {
  toolName: string;
  effect: string;
};

export type HumanConfirmationHandler = (
  request: HumanConfirmationRequest,
) => boolean | Promise<boolean>;

export function browserHumanConfirmation(request: HumanConfirmationRequest): boolean {
  if (typeof globalThis.confirm !== "function") {
    return false;
  }
  return globalThis.confirm(
    `Conductor WebMCP wants to ${request.effect}. Approve this one action?`,
  );
}

export async function requireHumanConfirmation(
  handler: HumanConfirmationHandler,
  toolName: string,
  effect: string,
): Promise<string | null> {
  if (await handler({ toolName, effect })) {
    return null;
  }
  return jsonToolResult({
    ok: false,
    tool: toolName,
    error: `Rejected because a person did not approve ${effect}.`,
    requiresHumanApproval: true,
  });
}

export async function executeToolSafely<TArgs>(
  toolName: string,
  handler: (args: TArgs) => Promise<unknown> | unknown,
  args: TArgs,
): Promise<string> {
  try {
    return jsonToolResult(await handler(args));
  } catch (error) {
    return jsonToolResult({
      ok: false,
      tool: toolName,
      error: errorMessage(error),
    });
  }
}

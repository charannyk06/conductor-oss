if (typeof window === "undefined") {
	(globalThis as Record<string, unknown>).window = globalThis;
}

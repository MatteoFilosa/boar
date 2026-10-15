// The renderer's modules read `window` when they load (platform.ts): the logic
// under test needs nothing from it, so the global object stands in.
const g = globalThis as { window?: unknown }
g.window ??= globalThis

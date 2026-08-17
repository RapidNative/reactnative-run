import { greet } from "./lib/greet";

export default function main(): string {
  return greet("world");
}

// Make the module observable from tests without a DOM.
(globalThis as any).__PLAIN_APP__ = main();

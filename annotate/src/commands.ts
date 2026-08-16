import type { CommandRegistry } from "./types";

export function createCommandRegistry(): CommandRegistry {
  const commands = new Map<string, (arg?: unknown) => unknown>();
  return {
    register(name, run) {
      commands.set(name, run);
      return () => {
        if (commands.get(name) === run) commands.delete(name);
      };
    },
    execute(name, arg) {
      const run = commands.get(name);
      if (!run) throw new Error(`Unknown command: ${name}`);
      return run(arg);
    },
    has: (name) => commands.has(name),
    list: () => [...commands.keys()].sort(),
  };
}

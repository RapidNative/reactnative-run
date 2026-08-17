export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(quiet: boolean): Logger {
  const stamp = () => new Date().toTimeString().slice(0, 8);
  return {
    info: (msg) => {
      if (!quiet) console.log(`\x1b[2m${stamp()}\x1b[0m ${msg}`);
    },
    warn: (msg) => console.warn(`\x1b[2m${stamp()}\x1b[0m \x1b[33m${msg}\x1b[0m`),
    error: (msg) => console.error(`\x1b[2m${stamp()}\x1b[0m \x1b[31m${msg}\x1b[0m`),
  };
}

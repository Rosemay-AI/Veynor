/**
 * Argv parser for Veynor commands.
 *
 * Supports both syntaxes:
 *   veynor <cmd> --flag=value      (--key=value)
 *   veynor <cmd> --flag value      (--key value)
 *
 * Also handles short forms:
 *   -y, -yes       → flags.yes = true
 *   -h, -help      → flags.help = true
 *   -v, -version   → flags.version = true
 */

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      // Handle --key=value
      const eq = a.indexOf("=");
      if (eq > 0) {
        const key = a.slice(2, eq);
        const value = a.slice(eq + 1);
        flags[key] = value;
        continue;
      }
      // Handle --key value (or bare --flag)
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (a === "-y" || a === "-yes") {
      flags["yes"] = true;
    } else if (a === "-h" || a === "-help" || a === "--help") {
      flags["help"] = true;
    } else if (a === "-v" || a === "-version" || a === "--version") {
      flags["version"] = true;
    } else {
      positional.push(a);
    }
  }
  return { cmd: positional[0] ?? null, flags, positional: positional.slice(1) };
}

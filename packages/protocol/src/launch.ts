/** Split a launch command into argv without executing a shell program. */
export function parseLaunchCommand(input: string): { command: string; args: string[] } {
  if (/[\0\r\n]/.test(input)) throw new Error("Enter a single launch command without null characters or line breaks.");
  const words: string[] = [];
  let word = "";
  let quote = "";
  let started = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c === "\\" && quote !== "'" && (input[i + 1] === '"' || (!quote && (input[i + 1] === "'" || /\s/.test(input[i + 1] ?? ""))))) {
      word += input[++i];
      started = true;
    } else if (quote) {
      if (c === quote) quote = "";
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      if (/[|&;<>`$]/.test(c)) throw new Error("Use an executable and arguments; shell operators and variable expansion are not supported.");
      word += c;
      started = true;
    }
  }
  if (quote) throw new Error("Close the quote in the launch command.");
  if (started) words.push(word);
  const command = words.shift();
  if (!command || /^[A-Za-z_]\w*=/.test(command)) throw new Error("Enter an executable followed by its ACP arguments.");
  return { command, args: words };
}

export function formatLaunchCommand(command: string, args: string[]): string {
  return [command, ...args].map((word) => /^[\w./:@%+=,\\-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`).join(" ");
}

import { loadConfig } from "../config.js";

const landmarks = ["1706.03762", "2106.09685", "2006.11239", "1512.03385", "2010.11929"];

export async function readerEval(args: string[]): Promise<number> {
  const papers = args.filter((arg) => !arg.startsWith("--"));
  const quiz = args.includes("--paper-quiz");
  const agent = args.find((arg) => arg.startsWith("--agent="))?.slice(8);
  const cfg = loadConfig();
  let failed = false;
  for (const paper of papers.length ? papers : landmarks) {
    try {
      const response = await fetch(`http://127.0.0.1:${cfg.port}/reader/eval`, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
        body: JSON.stringify({ paper, quiz, agent }),
        signal: AbortSignal.timeout(135_000),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      failed = true;
      console.error(`${paper}: ${(error as Error).message}. Bridge: 127.0.0.1:${cfg.port}`);
    }
  }
  return failed ? 1 : 0;
}

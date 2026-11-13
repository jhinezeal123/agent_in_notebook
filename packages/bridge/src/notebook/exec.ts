// Outputs of terminal commands and kernel snippets, kept so read_output can
// page through a result that was shortened.

import type { CellOutput } from "@ainb/protocol";

/** Outputs of the latest Bash / run_code results, by run id, for read_output. */
export class RecentRuns {
  private readonly runs = new Map<string, CellOutput[]>();
  private seq = 0;

  constructor(private readonly keep = 8) {}

  add(outputs: CellOutput[]): string {
    const id = `run-${++this.seq}`;
    this.runs.set(id, outputs);
    while (this.runs.size > this.keep) this.runs.delete(this.runs.keys().next().value!);
    return id;
  }

  get(id: string): CellOutput[] | undefined {
    return this.runs.get(id);
  }
}

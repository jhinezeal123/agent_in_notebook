// The agent works on the notebook's machine: the notebook is an .ipynb file
// in the working directory, kept in step with the browser both ways, and the
// machine's other files are read and changed with the usual file tools.

import { describe, expect, it } from "vitest";
import { callTool } from "../src/notebook/tools.js";
import { FakeNotebook, TINY_PNG } from "./fixtures/fake-extension.js";
import { context } from "./fixtures/tool-context.js";

const long = { waitMs: 60_000 };
const file = "/content/test.ipynb";
const fileCells = (nb: FakeNotebook, path = file) => JSON.parse(nb.vm.read(path)!).cells as any[];
const writes = (nb: FakeNotebook) => nb.vm.ops.filter((o) => o === "fs:write").length;

describe("the notebook as a file on its machine", () => {
  it("writes the notebook into the working directory with its cells, ids and outputs, and keeps it current", async () => {
    const nb = new FakeNotebook([{ type: "markdown", source: "# Title" }, { type: "code", source: "print(1)\nplot()" }]);
    nb.cells[1]!.outputs = [{ kind: "stream", name: "stdout", text: "1\n" }, { kind: "display", text: "<Figure>", image: { mime: "image/png", data: TINY_PNG } }];
    nb.cells[1]!.executionCount = 3;
    const ctx = context(nb, { overrides: long });
    expect((await callTool(ctx, "Glob", { pattern: "*.ipynb" })).text).toBe(file);
    const doc = JSON.parse(nb.vm.read(file)!);
    expect([doc.nbformat, doc.nbformat_minor, doc.metadata.kernelspec.name]).toEqual([4, 5, "python3"]);
    expect(doc.cells.map((c: any) => [c.id, c.cell_type, c.source.join("")])).toEqual([
      ["c1", "markdown", "# Title"],
      ["c2", "code", "print(1)\nplot()"],
    ]);
    expect(doc.cells[1].execution_count).toBe(3);
    expect(doc.cells[1].outputs).toEqual([
      { name: "stdout", output_type: "stream", text: ["1\n"] },
      { data: { "image/png": TINY_PNG, "text/plain": ["<Figure>"] }, metadata: {}, output_type: "display_data" },
    ]);
    // Written again only when the notebook changed.
    const before = writes(nb);
    await callTool(ctx, "Glob", { pattern: "*.ipynb" });
    expect(writes(nb)).toBe(before);
    nb.cells[0]!.source = "# New title";
    expect((await callTool(ctx, "Grep", { pattern: "New title" })).text).toBe(file);
    expect(writes(nb)).toBe(before + 1);
  });

  it("brings what a command did to the file into the notebook in the browser", async () => {
    const nb = new FakeNotebook([{ type: "code", source: "a = 1" }, { type: "code", source: "b = 2" }, { type: "markdown", source: "notes" }]);
    nb.vm.scripts.set("edit", (vm) => {
      const doc = JSON.parse(vm.read(file)!);
      doc.cells[0].source = ["a = 100"];
      doc.cells.splice(2, 1);
      doc.cells.reverse();
      doc.cells.push({ cell_type: "code", metadata: {}, outputs: [], execution_count: null, source: ["c = 3"] });
      vm.write(file, JSON.stringify(doc));
      return "edited\n";
    });
    const res = await callTool(context(nb, { overrides: long }), "Bash", { command: "script edit" });
    expect(nb.cells.map((c) => [c.id, c.source])).toEqual([
      ["c2", "b = 2"],
      ["c1", "a = 100"],
      ["c4", "c = 3"],
    ]);
    expect(res.text).toMatch(
      /^exit code 0 · .*\nedited\n\nThe notebook file \/content\/test\.ipynb changed on the machine; this reached the notebook in the browser:\nApplied: cell c1 changed; cell c3 deleted; cell c2 moved to index 0; new code cell c4 inserted at index 2\.$/,
    );
    // The file holds the notebook again, the new cell under its id.
    expect(fileCells(nb).map((c) => c.id)).toEqual(["c2", "c1", "c4"]);
  });

  it("puts a command's change up for review; meanwhile the file shows the notebook as it is", async () => {
    const nb = new FakeNotebook([{ type: "code", source: "a = 1" }]);
    nb.vm.scripts.set("edit", (vm) => {
      const doc = JSON.parse(vm.read(file)!);
      doc.cells[0].source = ["a = 2"];
      doc.cells[0].outputs = [{ output_type: "stream", name: "stdout", text: ["fake\n"] }];
      vm.write(file, JSON.stringify(doc));
      return "";
    });
    const res = await callTool(context(nb, { settings: { review: true }, overrides: long }), "Bash", { command: "script edit" });
    expect(res.text).toMatch(/Awaiting the user's review: Change to cell c1 \(review_id "r1-\d+"\)/);
    expect(res.text).toMatch(/changes to them were not applied/);
    expect(nb.cells[0]!.source).toBe("a = 1");
    expect(fileCells(nb)[0].source).toEqual(["a = 1"]);
    expect(fileCells(nb)[0].outputs).toEqual([]);
  });

  it("keeps the user's version of a cell changed in the browser while a command changed it too", async () => {
    const nb = new FakeNotebook([{ type: "code", source: "a = 1" }, { type: "code", source: "b = 2" }]);
    nb.vm.scripts.set("edit", (vm) => {
      nb.cells[0]!.source = "a = 'user'";
      const doc = JSON.parse(vm.read(file)!);
      doc.cells[0].source = ["a = 'agent'"];
      doc.cells[1].source = ["b = 'agent'"];
      vm.write(file, JSON.stringify(doc));
      return "";
    });
    const res = await callTool(context(nb, { overrides: long }), "Bash", { command: "script edit" });
    expect(nb.cells.map((c) => c.source)).toEqual(["a = 'user'", "b = 'agent'"]);
    expect(res.text).toMatch(/Change to cell c1: not applied, the user edited cell c1 meanwhile/);
    expect(fileCells(nb).map((c) => c.source.join(""))).toEqual(["a = 'user'", "b = 'agent'"]);
  });

  it("writes the file again when a command breaks it", async () => {
    const nb = new FakeNotebook([{ type: "code", source: "a = 1" }]);
    nb.vm.scripts.set("break", (vm) => (vm.write(file, "{oops"), ""));
    const res = await callTool(context(nb, { overrides: long }), "Bash", { command: "script break" });
    expect(res.text).toMatch(/changed into something that is not a notebook \(It is not valid JSON: .*\)\. The notebook did not change; the file was written again from it\./);
    expect(fileCells(nb)[0].source).toEqual(["a = 1"]);
  });

  it("edits the notebook through its path: Edit, NotebookEdit and Write, within the mode", async () => {
    const nb = new FakeNotebook([{ type: "code", source: "x = 1" }, { type: "code", source: "y = 2" }]);
    const ctx = context(nb, { overrides: long });
    expect((await callTool(ctx, "Edit", { file_path: file, old_string: "x = 1", new_string: "x = 10" })).text).toBe("Applied: cell c1 changed.");
    expect((await callTool(ctx, "Edit", { file_path: file, old_string: "nope", new_string: "z" })).text).toMatch(/old_string was not found in any cell/);
    await callTool(ctx, "NotebookEdit", { notebook_path: file, cell_id: "c1", edit_mode: "insert", cell_type: "markdown", new_source: "## Notes" });
    await callTool(ctx, "NotebookEdit", { notebook_path: file, cell_id: "c2", edit_mode: "move", index: 0 });
    expect(nb.cells.map((c) => [c.id, c.source])).toEqual([
      ["c2", "y = 2"],
      ["c1", "x = 10"],
      ["c3", "## Notes"],
    ]);
    // The file follows each change.
    expect(fileCells(nb).map((c) => c.id)).toEqual(["c2", "c1", "c3"]);

    // Edit cell mode: only the target cell changes; the rest of a Write is refused.
    const cellMode = context(nb, { settings: { scope: "cell" }, overrides: { ...long, targets: () => ["c1"] } });
    const doc = JSON.parse(nb.vm.read(file)!);
    doc.cells[1].source = ["x = 11"];
    doc.cells[0].source = ["y = 22"];
    const res = await callTool(cellMode, "Write", { file_path: "test.ipynb", content: JSON.stringify(doc) });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/^Applied: cell c1 changed\.\nChange to cell c2: not applied\. Mode is 'Edit cell'/);
    expect(nb.cells.map((c) => c.source)).toEqual(["y = 2", "x = 11", "## Notes"]);
    expect(fileCells(nb)[0].source).toEqual(["y = 2"]);
    expect((await callTool(ctx, "Write", { file_path: file, content: "not json" })).text).toMatch(/content must be the notebook as \.ipynb JSON/);
  });

  it("waits for the user's review of an edit and reports a rejection", async () => {
    const nb = new FakeNotebook([{ type: "code", source: "x = 1" }]);
    const ctx = context(nb, { settings: { review: true }, overrides: { ...long, awaitReview: async () => "rejected" } });
    const res = await callTool(ctx, "Edit", { file_path: file, old_string: "x = 1", new_string: "x = 2" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/^Change to cell c1: the user REJECTED it/);
  });

  it("gives the notebook file another name when the path holds a file the bridge did not write", async () => {
    const nb = new FakeNotebook([{ type: "code", source: "x = 1" }]);
    nb.vm.write(file, "the user's own file");
    const ctx = context(nb, { overrides: long });
    expect((await callTool(ctx, "notebook_info", {})).text).toContain("Notebook file: /content/test.agent.ipynb");
    await callTool(ctx, "Glob", { pattern: "*" });
    expect(nb.vm.read(file)).toBe("the user's own file");
    expect(fileCells(nb, "/content/test.agent.ipynb")[0].source).toEqual(["x = 1"]);
  });

  it("in VS Code, leads the notebook's own path to the editor and never writes that file", async () => {
    const nb = new FakeNotebook([{ type: "code", source: "x = 1" }]);
    nb.platform = "vscode";
    nb.vm.write(file, "saved by VS Code");
    const ctx = context(nb, { overrides: long });
    expect((await callTool(ctx, "notebook_info", {})).text).toContain(`Notebook file: ${file}`);
    await callTool(ctx, "Glob", { pattern: "*" });
    await callTool(ctx, "Edit", { file_path: file, old_string: "x = 1", new_string: "x = 2" });
    expect(nb.cells[0]!.source).toBe("x = 2");
    expect(nb.vm.read(file)).toBe("saved by VS Code");
    expect(nb.vm.read("/content/test.agent.ipynb")).toBeUndefined();
  });

  it("reads the notebook while a cell runs; the machine waits for the cell", async () => {
    const nb = new FakeNotebook([{ type: "code", source: "train()" }]);
    nb.busy = true;
    const ctx = context(nb, { overrides: long });
    expect((await callTool(ctx, "Read", { file_path: "test.ipynb" })).text).toMatch(
      /^\/content\/test\.ipynb: the notebook open in the browser, 1 cell, shown as cells\.\n\n### cell \[0\] id=c1 code/,
    );
    const glob = await callTool(ctx, "Glob", { pattern: "*" });
    expect(glob.isError).toBe(true);
    expect(glob.text).toMatch(/kernel is busy running a cell/);
  });
});

describe("the machine through the notebook server's terminal", () => {
  it("is worked while a cell runs: terminal, files and the notebook file", async () => {
    const nb = new FakeNotebook([{ type: "code", source: "train()" }]);
    nb.serverTerminals = true;
    nb.vm.write("/content/train.log", "epoch 1 loss 0.9\n");
    const ctx = context(nb, { overrides: long });
    await callTool(ctx, "notebook_info", {});
    nb.busy = true;
    expect((await callTool(ctx, "Read", { file_path: "train.log" })).text).toBe("     1\tepoch 1 loss 0.9");
    expect((await callTool(ctx, "Bash", { command: "echo still here" })).text).toMatch(/^exit code 0 · .*\nstill here$/);
    nb.cells[0]!.source = "train(epochs=2)";
    expect((await callTool(ctx, "Grep", { pattern: "epochs=2" })).text).toBe(file);
    expect(nb.executed).toEqual([]);
  });

  it("starts the terminal where the kernel works, with the kernel's PATH first", async () => {
    const nb = new FakeNotebook([]);
    await callTool(context(nb, { overrides: long }), "Bash", { command: "echo hi" });
    expect(nb.vm.started).toEqual([{ cwd: "/content", env: { PATH: "/opt/venv/bin:/usr/local/bin:/usr/bin" } }]);
  });

  it("reaches the machine of a notebook whose kernel is not Python", async () => {
    const nb = new FakeNotebook([]);
    nb.language = "R";
    nb.serverTerminals = true;
    expect((await callTool(context(nb, { overrides: long }), "Bash", { command: "echo from R" })).text).toMatch(/\nfrom R$/);
  });
});

describe("a notebook with no runtime connected", () => {
  it("is still read and edited through its file's path; the machine waits for a runtime", async () => {
    const nb = new FakeNotebook([{ type: "code", source: "x = 1" }]);
    nb.connected = false;
    const ctx = context(nb, { overrides: long });
    expect((await callTool(ctx, "notebook_info", {})).text).toContain("Notebook file: /content/test.ipynb");
    expect((await callTool(ctx, "Edit", { file_path: "test.ipynb", old_string: "x = 1", new_string: "x = 2" })).text).toBe("Applied: cell c1 changed.");
    expect(nb.cells[0]!.source).toBe("x = 2");
    const bash = await callTool(ctx, "Bash", { command: "ls" });
    expect(bash.isError).toBe(true);
    expect(bash.text).toBe("Colab is not connected to a runtime. Ask the user to connect it (the Connect button), then try again. The notebook file itself can still be read and edited.");
    // Once connected, the file is written in the working directory.
    nb.connected = true;
    await callTool(ctx, "Glob", { pattern: "*" });
    expect(fileCells(nb)[0].source).toEqual(["x = 2"]);
  });
});

describe("files on the notebook's machine", () => {
  it("reads, edits and writes files, relative to the working directory", async () => {
    const nb = new FakeNotebook([]);
    nb.vm.write("/content/train.py", "lr = 0.1\nepochs = 3\n");
    const ctx = context(nb, { overrides: long });
    expect((await callTool(ctx, "Read", { file_path: "train.py" })).text).toBe("     1\tlr = 0.1\n     2\tepochs = 3");
    expect((await callTool(ctx, "Read", { file_path: "/content/train.py", offset: 2 })).text).toBe("     2\tepochs = 3");
    expect((await callTool(ctx, "Edit", { file_path: "train.py", old_string: "lr = 0.1", new_string: "lr = 0.01" })).text).toBe("Edited /content/train.py.");
    expect(nb.vm.read("/content/train.py")).toBe("lr = 0.01\nepochs = 3\n");
    expect((await callTool(ctx, "Write", { file_path: "~/notes/a.txt", content: "hi" })).text).toBe("Wrote /root/notes/a.txt (2 bytes).");
    expect(nb.vm.read("/root/notes/a.txt")).toBe("hi");
    expect((await callTool(ctx, "Grep", { pattern: "epochs", output_mode: "content" })).text).toBe("/content/train.py:2:epochs = 3");
    expect((await callTool(ctx, "Read", { file_path: "missing.txt" })).text).toBe("File does not exist: /content/missing.txt");

    // Write mode: files can be read, not changed.
    const write = context(nb, { settings: { scope: "write" }, overrides: long });
    expect((await callTool(write, "Read", { file_path: "train.py" })).isError).toBeUndefined();
    const refused = await callTool(write, "Edit", { file_path: "train.py", old_string: "3", new_string: "4" });
    expect(refused.text).toMatch(/changes to files on the notebook's machine are not allowed/);
    expect(nb.vm.read("/content/train.py")).toBe("lr = 0.01\nepochs = 3\n");
  });

  it("reads other notebooks as cells and edits them by cell", async () => {
    const nb = new FakeNotebook([]);
    const other = {
      cells: [{ cell_type: "code", id: "k1", metadata: { tags: ["keep"] }, execution_count: 1, outputs: [{ output_type: "stream", name: "stdout", text: ["hi\n"] }], source: ["print('hi')"] }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    };
    nb.vm.write("/content/other.ipynb", JSON.stringify(other));
    const ctx = context(nb, { overrides: long });
    expect((await callTool(ctx, "Read", { file_path: "other.ipynb" })).text).toBe(
      "/content/other.ipynb: a notebook file, 1 cell, shown as cells.\n\n### cell [0] id=k1 code exec=1\nprint('hi')\n--- output ---\nhi",
    );
    await callTool(ctx, "Edit", { file_path: "other.ipynb", old_string: "'hi'", new_string: "'bye'" });
    await callTool(ctx, "NotebookEdit", { notebook_path: "other.ipynb", cell_id: "k1", edit_mode: "insert", cell_type: "markdown", new_source: "done" });
    const cells = JSON.parse(nb.vm.read("/content/other.ipynb")!).cells;
    expect(cells[0]).toEqual({ ...other.cells[0], source: ["print('bye')"] });
    expect(cells[1]).toMatchObject({ cell_type: "markdown", source: ["done"] });
    expect(cells[1].id).toMatch(/^[0-9a-f]{8}$/);
  });
});

import { describe, expect, it } from "vitest";
import { notebookKey } from "../src/identity.js";

describe("notebookKey", () => {
  it("ignores Colab's query and #scrollTo, keeps the legacy fileId", () => {
    const a = notebookKey("colab", "https://colab.research.google.com/drive/1AbC?usp=sharing#scrollTo=xyz");
    expect(a).toBe("colab:/drive/1AbC");
    expect(notebookKey("colab", "https://colab.research.google.com/drive/1AbC")).toBe(a);
    expect(notebookKey("colab", "https://colab.research.google.com/drive/2Other")).not.toBe(a);
    expect(notebookKey("colab", "https://colab.research.google.com/notebook#fileId=XYZ&scrollTo=a")).toBe("colab:/notebook#XYZ");
  });

  it("names a Kaggle notebook by its code path, edit or run view alike", () => {
    expect(notebookKey("kaggle", "https://www.kaggle.com/code/alice/my-nb/edit")).toBe("kaggle:/code/alice/my-nb");
    expect(notebookKey("kaggle", "https://www.kaggle.com/code/alice/my-nb/edit/run/123?x=1")).toBe("kaggle:/code/alice/my-nb");
  });

  it("tells Jupyter documents apart by server and path", () => {
    expect(notebookKey("jupyter", "http://localhost:8888/notebooks/a.ipynb", "a.ipynb")).toBe("jupyter:localhost:8888:a.ipynb");
    expect(notebookKey("jupyter", "http://localhost:8888/lab", "dir/b.ipynb")).toBe("jupyter:localhost:8888:dir/b.ipynb");
    expect(notebookKey("jupyter", "http://localhost:8888/notebooks/a.ipynb")).toBe("jupyter:localhost:8888:/notebooks/a.ipynb");
  });

  it("survives a malformed URL", () => {
    expect(notebookKey("jupyter", "not a url", "x.ipynb")).toBe("jupyter:not a url:x.ipynb");
  });
});

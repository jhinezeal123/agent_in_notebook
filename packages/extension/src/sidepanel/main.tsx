import { render } from "preact";
import { App } from "./app.js";
import { client } from "./client.js";
import { PanelHostContext } from "./host.js";

render(<PanelHostContext.Provider value={client}><App /></PanelHostContext.Provider>, document.getElementById("root")!);

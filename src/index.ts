import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCostrictProvider } from "./provider.ts";

export default function costrict(pi: ExtensionAPI): void {
  pi.registerProvider(createCostrictProvider({
    baseUrl: process.env.COSTRICT_BASE_URL,
    pluginVersion: process.env.COSTRICT_PLUGIN_VERSION,
    vscodeVersion: process.env.COSTRICT_VSCODE_VERSION,
    allowHttp: process.env.COSTRICT_ALLOW_HTTP === "1",
  }));
}

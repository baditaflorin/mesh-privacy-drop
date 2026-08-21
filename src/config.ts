import { createMeshConfig } from "@baditaflorin/mesh-common";

export const config = createMeshConfig({
  appName: "mesh-privacy-drop",
  description: "A short-lived encrypted file drop that transfers directly between browsers.",
  accentHex: "#a855f7",
  version: __APP_VERSION__,
  commit: __GIT_COMMIT__,
});

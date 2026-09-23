import { fileURLToPath } from "node:url";

import { formatProviderAcceptanceError, runChatGPTAcceptance } from "./provider-acceptance.js";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runChatGPTAcceptance().then(() => {
    process.stdout.write("\nChatGPT provider acceptance passed: fixture state and test outcome were independently verified.\n");
  }).catch((error: unknown) => {
    process.stderr.write(`${formatProviderAcceptanceError(error)}\n`);
    process.exitCode = 1;
  });
}

import test from "node:test";
import { safeCheckpointIoAvailable } from "../../dist/checkpoint-win32.js";

// Windows requires the native no-follow handle backend; without it, fail closed.
export const supportedCheckpointTest = safeCheckpointIoAvailable ? test : test.skip;

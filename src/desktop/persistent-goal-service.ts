// Keep the Desktop host contract stable while CLI and Desktop share the same goal authority.
export { createPersistentGoalService as createDesktopPersistentGoalService } from "../persistent-goal-service.js";
export type { PersistentGoalCommand as DesktopGoalCommand } from "../persistent-goal-service.js";
import { posix, win32 } from "node:path";

/** Uses the requested platform's path semantics for injectable platform-specific locations. */
export function joinPlatformPath(platform: NodeJS.Platform, ...segments: string[]): string {
  return (platform === "win32" ? win32 : posix).join(...segments);
}

/** Tool and repository-relative paths are portable identifiers, not native filesystem paths. */
export function portablePath(path: string): string {
  return path.replaceAll("\\", "/");
}

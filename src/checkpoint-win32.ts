import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

type Handle = object;
type NativeStat = {
  dev: number; ino: number; nlink: number; size: number; mode: number;
  mtimeMs: number; ctimeMs: number; isFile: boolean; isDirectory: boolean; fileId: string;
};
type NativeCheckpoint = {
  openNoFollow(path: string, flags: number): Handle;
  inspectDirectoryNoFollow(path: string): NativeStat;
  stat(handle: Handle): NativeStat;
  read(handle: Handle, buffer: Buffer, offset: number, length: number, position: number): number;
  write(handle: Handle, buffer: Buffer, offset: number, length: number, position: number): number;
  truncate(handle: Handle, length: number): void;
  chmod(handle: Handle, mode: number): void;
  remove(handle: Handle): void;
  close(handle: Handle): void;
};

const native: NativeCheckpoint | undefined = (() => {
  if (process.platform !== "win32") return undefined;
  try {
    const require = createRequire(import.meta.url);
    const path = fileURLToPath(new URL("../native/checkpoint-win32/build/Release/checkpoint_win32.node", import.meta.url));
    const addon: unknown = require(path);
    if (typeof addon !== "object" || addon === null) return undefined;
    const api = addon as Record<string, unknown>;
    if (!["openNoFollow", "inspectDirectoryNoFollow", "stat", "read", "write", "truncate", "chmod", "remove", "close"]
      .every((name) => typeof api[name] === "function")) return undefined;
    return addon as NativeCheckpoint;
  } catch { return undefined; }
})();

export const safeCheckpointIoAvailable = process.platform === "win32" ? Boolean(native) : Boolean(fs.constants.O_NOFOLLOW);
export const checkpointMode = (mode: number): number => process.platform === "win32"
  ? ((mode & 0o222) ? 0o666 : 0o444) : mode;
export type CheckpointHandle = number | Handle;
export type CheckpointStat = Pick<fs.Stats, "dev" | "ino" | "nlink" | "size" | "mode" | "mtimeMs" | "ctimeMs">
  & { fileId?: string; isFile(): boolean; isDirectory(): boolean };
const requireNative = (): NativeCheckpoint => {
  if (!native || !safeCheckpointIoAvailable) throw new Error("Checkpoint platform unsupported.");
  return native;
};
const checked = (stat: NativeStat): CheckpointStat => {
  if (!Number.isSafeInteger(stat.dev) || !Number.isFinite(stat.ino) || !Number.isSafeInteger(stat.nlink)
    || !Number.isSafeInteger(stat.size) || !Number.isSafeInteger(stat.mode)
    || !Number.isFinite(stat.mtimeMs) || !Number.isFinite(stat.ctimeMs)
    || typeof stat.fileId !== "string" || !/^\d{1,20}$/.test(stat.fileId)) {
    throw new Error("Checkpoint native file metadata invalid.");
  }
  return { ...stat, isFile: () => stat.isFile, isDirectory: () => stat.isDirectory };
};
export function directoryNoFollow(path: string): CheckpointStat {
  return process.platform === "win32" ? checked(requireNative().inspectDirectoryNoFollow(path)) : fs.lstatSync(path);
}
export function openCheckpoint(path: string, flags: number, mode = 0o600): CheckpointHandle {
  return process.platform === "win32" ? requireNative().openNoFollow(path, flags & ~(fs.constants.O_NONBLOCK ?? 0))
    : fs.openSync(path, flags | fs.constants.O_NOFOLLOW, mode);
}
export function statCheckpoint(handle: CheckpointHandle): CheckpointStat {
  return typeof handle === "number" ? fs.fstatSync(handle) : checked(requireNative().stat(handle));
}
export function readCheckpoint(handle: CheckpointHandle, bytes: Buffer, offset: number, length: number, position: number): number {
  return typeof handle === "number" ? fs.readSync(handle, bytes, offset, length, position)
    : requireNative().read(handle, bytes, offset, length, position);
}
export function writeCheckpoint(handle: CheckpointHandle, bytes: Buffer, offset: number, length: number, position: number): number {
  return typeof handle === "number" ? fs.writeSync(handle, bytes, offset, length, position)
    : requireNative().write(handle, bytes, offset, length, position);
}
export function truncateCheckpoint(handle: CheckpointHandle, length: number): void {
  if (typeof handle === "number") fs.ftruncateSync(handle, length);
  else requireNative().truncate(handle, length);
}
export function chmodCheckpoint(handle: CheckpointHandle, mode: number): void {
  if (typeof handle === "number") fs.fchmodSync(handle, mode);
  else requireNative().chmod(handle, mode);
}
export function removeCheckpoint(handle: CheckpointHandle, path: string): void {
  if (typeof handle === "number") fs.unlinkSync(path);
  else requireNative().remove(handle);
}
export function closeCheckpoint(handle: CheckpointHandle): void {
  if (typeof handle === "number") fs.closeSync(handle);
  else requireNative().close(handle);
}

/** Internal I/O seam shared by the structural backend and its failure-injection tests. */
export const checkpointIo = {
  directory: directoryNoFollow,
  open: openCheckpoint,
  stat: statCheckpoint,
  read: readCheckpoint,
  write: writeCheckpoint,
  truncate: truncateCheckpoint,
  chmod: chmodCheckpoint,
  remove: removeCheckpoint,
  close: closeCheckpoint,
};

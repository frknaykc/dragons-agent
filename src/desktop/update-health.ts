export const HEALTH_PROBE_ARGUMENT = "--dragons-update-health";

/** Health mode has no workspace/config/runtime path and must be its sole application argument. */
export function isHealthProbeLaunch(argv: readonly string[]): boolean {
  // Electron preserves a source main-script argument, while a packaged executable does not.
  return (argv.length === 2 || argv.length === 3) && argv.at(-1) === HEALTH_PROBE_ARGUMENT;
}

/**
 * Child environments are allowlisted rather than inherited. The caller owns and removes
 * `isolatedHome`; this function never selects or reads an existing user profile.
 */
export function healthProbeEnvironment(source: NodeJS.ProcessEnv, isolatedHome: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    APPDATA: `${isolatedHome}/AppData/Roaming`,
    LOCALAPPDATA: `${isolatedHome}/AppData/Local`,
    XDG_CONFIG_HOME: `${isolatedHome}/.config`,
    XDG_CACHE_HOME: `${isolatedHome}/.cache`,
    XDG_DATA_HOME: `${isolatedHome}/.local/share`,
  };
  for (const name of ["PATH", "SystemRoot", "WINDIR"] as const) {
    if (source[name]) environment[name] = source[name];
  }
  return environment;
}

// OS variables a harness subprocess needs beyond HOME/PATH. The SDK envs are
// deliberately sparse (no inherited credentials), but on Windows HOME/PATH
// alone break the tools agents run: without APPDATA/USERPROFILE `gh` can't
// find its config and reports "not logged in", and without PATHEXT/SystemRoot
// PowerShell can't resolve `.exe` commands. Nothing on this list carries a
// credential.
const OS_PASSTHROUGH_ENV_KEYS = [
  // Windows profile + shell
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'USERDOMAIN',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PSModulePath',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  // Temp dirs (Windows + POSIX)
  'TEMP',
  'TMP',
  'TMPDIR',
  // POSIX identity + locale
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
] as const;

// HOME, PATH and the OS allowlist, copied from process.env when set.
export function buildBaseSpawnEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    HOME: process.env['HOME'],
    PATH: process.env['PATH'],
  };
  for (const key of OS_PASSTHROUGH_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

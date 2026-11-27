/** Fixed child environment; Windows libuv otherwise supplies absent required fields. */
const blockedWindowsDefaults = [
  "PATH",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
] as const;

function namedValue(
  source: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const names = Object.keys(source).filter(
    (candidate) => candidate.toUpperCase() === name.toUpperCase(),
  );
  if (names.length > 1) throw new Error("Ambiguous OS environment key");
  return names.length ? source[names[0]] : undefined;
}

function replace(env: NodeJS.ProcessEnv, name: string, value: string): void {
  for (const key of Object.keys(env))
    if (key.toUpperCase() === name.toUpperCase()) delete env[key];
  env[name] = value;
}

export function isolatedChildEnv(
  owned: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...owned };
  for (const name of ["SystemRoot", "WINDIR"] as const) {
    const value = namedValue(parent, name);
    if (platform === "win32") replace(env, name, value ?? "");
    else if (value) env[name] = value;
  }
  if (platform !== "win32") return env;

  const temporary = namedValue(env, "TEMP") ?? "";
  replace(env, "TEMP", temporary);
  replace(env, "SystemDrive", namedValue(parent, "SystemDrive") ?? "");
  for (const name of blockedWindowsDefaults) replace(env, name, "");
  return env;
}

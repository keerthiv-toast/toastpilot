import { execSync } from "child_process";

export interface SimulatorConfig {
  deviceName: string;
  platformVersion: string;
  udid?: string;
}

let cached: SimulatorConfig | null = null;

function parseSimctlJson<T>(cmd: string): T {
  return JSON.parse(execSync(cmd, { encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 })) as T;
}

/** Resolve iOS Simulator platform version from env or installed runtimes (prefers latest, e.g. 26.5). */
export function resolvePlatformVersion(): string {
  const fromEnv =
    process.env.IOS_PLATFORM_VERSION?.trim() ??
    process.env.IOS_SIMULATOR_VERSION?.trim();
  if (fromEnv) return fromEnv;

  try {
    const data = parseSimctlJson<{
      runtimes?: Array<{ version?: string; isAvailable?: boolean; identifier?: string; name?: string }>;
    }>("xcrun simctl list runtimes available -j");

    const ios = (data.runtimes ?? [])
      .filter(
        (r) =>
          r.isAvailable !== false &&
          (r.identifier?.includes("iOS") || r.name?.includes("iOS")),
      )
      .map((r) => r.version)
      .filter(Boolean) as string[];

    if (ios.length === 0) throw new Error("No iOS runtimes found");

    ios.sort((a, b) => parseFloat(b) - parseFloat(a));
    return ios[0];
  } catch {
    return "26.5";
  }
}

const PREFERRED_DEVICES = [
  "iPhone 17 Pro",
  "iPhone 16 Pro",
  "iPhone 15 Pro",
  "iPhone 15",
];

function detectDevice(platformVersion: string): { name: string; udid?: string } {
  const udidFromEnv = process.env.IOS_SIMULATOR_UDID?.trim();
  const nameFromEnv =
    process.env.IOS_DEVICE_NAME?.trim() ??
    process.env.IOS_SIMULATOR_DEVICE?.trim();

  if (udidFromEnv) {
    return { name: nameFromEnv ?? PREFERRED_DEVICES[0], udid: udidFromEnv };
  }

  try {
    const data = parseSimctlJson<{
      devices?: Record<string, Array<{ name?: string; udid?: string; isAvailable?: boolean }>>;
    }>("xcrun simctl list devices available -j");

    const runtimeKey = Object.keys(data.devices ?? {}).find((k) =>
      k.includes(platformVersion.replace(".", "-")),
    );
    const available = (
      runtimeKey ? (data.devices?.[runtimeKey] ?? []) : Object.values(data.devices ?? {}).flat()
    ).filter((d) => d.isAvailable !== false && d.name && d.udid);

    if (nameFromEnv) {
      const match = available.find((d) => d.name === nameFromEnv);
      if (match) return { name: match.name!, udid: match.udid };
    }

    for (const pref of PREFERRED_DEVICES) {
      const match = available.find((d) => d.name === pref);
      if (match) return { name: match.name!, udid: match.udid };
    }

    const first = available[0];
    if (first?.name) return { name: first.name, udid: first.udid };
  } catch {
    /* fall through */
  }

  return { name: nameFromEnv ?? PREFERRED_DEVICES[0] };
}

export function resolveSimulatorConfig(): SimulatorConfig {
  if (cached) return cached;

  const platformVersion = resolvePlatformVersion();
  const { name, udid } = detectDevice(platformVersion);

  cached = { deviceName: name, platformVersion, udid };
  return cached;
}

export function resolveDeviceName(): string {
  return resolveSimulatorConfig().deviceName;
}

export function resolveSimulatorUdid(): string | undefined {
  return resolveSimulatorConfig().udid;
}

export function describeSimulatorTarget(): string {
  const c = resolveSimulatorConfig();
  return `${c.deviceName} (iOS ${c.platformVersion})${c.udid ? ` · ${c.udid.slice(0, 8)}…` : ""}`;
}

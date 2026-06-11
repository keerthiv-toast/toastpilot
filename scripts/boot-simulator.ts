import { execSync } from "child_process";

const device = process.env.IOS_DEVICE_NAME ?? "iPhone 17 Pro";

try {
  const udid = execSync(`xcrun simctl list devices available | grep "${device}" | head -1`, {
    encoding: "utf-8",
  });
  const match = udid.match(/\(([A-F0-9-]+)\)/);
  if (match?.[1]) {
    execSync(`xcrun simctl boot ${match[1]}`, { stdio: "inherit" });
    execSync("open -a Simulator", { stdio: "inherit" });
    console.log(`✅ Booted simulator ${device} (${match[1]})`);
    console.log(`   export IOS_SIMULATOR_UDID=${match[1]}`);
  } else {
    console.log(`⚠ Could not parse UDID for ${device}. Open Xcode → Devices to create one.`);
  }
} catch (e) {
  console.error("Simulator boot failed:", e);
  process.exit(1);
}

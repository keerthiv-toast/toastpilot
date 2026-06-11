import { execSync } from "child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { config as loadEnv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AI_QA_ROOT = join(__dirname, "..");
loadEnv({ path: join(AI_QA_ROOT, ".env") });

const OPERATOR_APP_ROOT = join(AI_QA_ROOT, "../..");
const DERIVED_DATA = join(OPERATOR_APP_ROOT, "DerivedData");
const APP_DEST = join(AI_QA_ROOT, "../automation/app/ToastOperator.app");
const SCHEME = process.env.XCODE_SCHEME ?? "ToastOperator Production";
const SKIP_IF_EXISTS = process.env.AGENT_FORCE_REBUILD !== "true";

const SCHEME_PRODUCTS_DIR: Record<string, string> = {
  "ToastOperator Production": "DEBUG_PROD-iphonesimulator",
  "ToastOperator Dev": "DEBUG_DEV-iphonesimulator",
  "ToastOperator Preprod": "DEBUG_PREPROD-iphonesimulator",
};

const SCHEME_TOAST_ENV: Record<string, string> = {
  "ToastOperator Dev": "Dev",
  "ToastOperator Production": "Production",
  "ToastOperator Preprod": "Preprod",
};

const SCHEME_BUNDLE_ID: Record<string, string> = {
  "ToastOperator Production": "com.toasttab.toastoperator",
  "ToastOperator Dev": "com.toasttab.toastoperator.preprod",
  "ToastOperator Preprod": "com.toasttab.toastoperator.preprod",
};

function readPlistValue(appBundle: string, key: string): string | null {
  const plist = join(appBundle, "Info.plist");
  if (!existsSync(plist)) return null;
  try {
    return execSync(`/usr/libexec/PlistBuddy -c "Print :${key}" "${plist}"`, {
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
}

function readToastEnvironment(appBundle: string): string | null {
  return readPlistValue(appBundle, "TOAST_ENVIRONMENT");
}

function readBundleId(appBundle: string): string | null {
  return readPlistValue(appBundle, "CFBundleIdentifier");
}

function appMatchesScheme(appBundle: string, scheme: string): boolean {
  const expectedEnv = SCHEME_TOAST_ENV[scheme];
  const expectedBundle = SCHEME_BUNDLE_ID[scheme];
  const env = readToastEnvironment(appBundle);
  const bundleId = readBundleId(appBundle);

  if (expectedEnv && env !== expectedEnv) return false;
  if (expectedBundle && bundleId !== expectedBundle) return false;
  return Boolean(env && bundleId);
}

function findBuiltApp(productsRoot: string, scheme: string): string | null {
  const productsDir = SCHEME_PRODUCTS_DIR[scheme];
  if (productsDir) {
    const direct = join(productsRoot, productsDir, "ToastOperator.app");
    if (existsSync(join(direct, "Info.plist")) && appMatchesScheme(direct, scheme)) {
      return direct;
    }
  }

  if (!existsSync(productsRoot)) return null;

  const matches: string[] = [];
  for (const entry of readdirSync(productsRoot)) {
    const candidate = join(productsRoot, entry, "ToastOperator.app");
    if (existsSync(join(candidate, "Info.plist")) && appMatchesScheme(candidate, scheme)) {
      matches.push(candidate);
    }
  }

  if (productsDir) {
    const preferred = join(productsRoot, productsDir, "ToastOperator.app");
    const hit = matches.find((p) => p === preferred);
    if (hit) return hit;
  }

  return matches[0] ?? null;
}

function findMainBinary(appBundle: string): string | null {
  const entries = readdirSync(appBundle);
  for (const entry of entries) {
    const full = join(appBundle, entry);
    const st = statSync(full);
    if (st.isFile() && (st.mode & 0o111)) return full;
  }
  return null;
}

function main(): void {
  if (SKIP_IF_EXISTS && existsSync(APP_DEST) && appMatchesScheme(APP_DEST, SCHEME)) {
    const installedEnv = readToastEnvironment(APP_DEST);
    const bundleId = readBundleId(APP_DEST);
    console.log(`✅ Using existing app (${installedEnv}, ${bundleId}): ${APP_DEST}`);
    console.log("   Set AGENT_FORCE_REBUILD=true to rebuild.");
    return;
  }

  const installedEnv = existsSync(APP_DEST) ? readToastEnvironment(APP_DEST) : null;
  const installedBundle = existsSync(APP_DEST) ? readBundleId(APP_DEST) : null;
  if (installedEnv || installedBundle) {
    console.log(
      `⚠ Cached app is ${installedEnv ?? "?"} (${installedBundle ?? "?"}), ` +
        `but ${SCHEME} requires ${SCHEME_TOAST_ENV[SCHEME]} (${SCHEME_BUNDLE_ID[SCHEME]}). Rebuilding…`,
    );
  }

  console.log(`\n🔨 Building Toast Operator (${SCHEME}) for iOS Simulator…`);
  console.log(`   Project: ${OPERATOR_APP_ROOT}`);
  console.log(
    "\nℹ First build can take 10–20 minutes while Xcode resolves Swift packages.",
  );
  console.log(
    'ℹ Warnings like "Supported platforms... is empty" during "Resolve Package Graph" are usually normal.\n',
  );

  mkdirSync(join(AI_QA_ROOT, "../automation/app"), { recursive: true });

  let xcbeautify = "";
  try {
    xcbeautify = execSync("command -v xcbeautify", { encoding: "utf-8" }).trim();
  } catch {
    xcbeautify = "";
  }

  if (process.env.AGENT_USE_BUILD_MODULE === "true") {
    const flag =
      "--confirm-10m-timeout-and-no-piping-of-output-because-it-is-already-filtered";
    execSync(`./Scripts/build-module.sh ToastOperator ${flag}`, {
      cwd: OPERATOR_APP_ROOT,
      stdio: "inherit",
      shell: "/bin/bash",
      env: process.env,
    });
  } else {
    const buildCmd = [
      "xcodebuild",
      "-project ToastOperator.xcodeproj",
      `-scheme "${SCHEME}"`,
      "-destination 'generic/platform=iOS Simulator'",
      `-derivedDataPath "${DERIVED_DATA}"`,
      "-skipMacroValidation",
      "build",
    ].join(" ");

    const fullCmd = xcbeautify ? `${buildCmd} | xcbeautify --quieter` : buildCmd;

    execSync(fullCmd, {
      cwd: OPERATOR_APP_ROOT,
      stdio: "inherit",
      shell: "/bin/bash",
      env: { ...process.env },
    });
  }

  const productsRoot = join(DERIVED_DATA, "Build", "Products");
  const builtApp = findBuiltApp(productsRoot, SCHEME);

  if (!builtApp) {
    throw new Error(
      `No ${SCHEME} app found under ${productsRoot}.\n` +
        `Expected: ${SCHEME_PRODUCTS_DIR[SCHEME] ?? "?"}/ToastOperator.app\n` +
        `Try: AGENT_FORCE_REBUILD=true npm run app:build`,
    );
  }

  if (!appMatchesScheme(builtApp, SCHEME)) {
    throw new Error(
      `Built app at ${builtApp} does not match ${SCHEME} ` +
        `(env=${readToastEnvironment(builtApp)}, bundle=${readBundleId(builtApp)}).`,
    );
  }

  if (existsSync(APP_DEST)) {
    rmSync(APP_DEST, { recursive: true, force: true });
  }

  cpSync(builtApp, APP_DEST, { recursive: true });

  const infoPlist = join(APP_DEST, "Info.plist");
  const binary = findMainBinary(APP_DEST);
  if (!existsSync(infoPlist) || !binary) {
    throw new Error(
      `Built app bundle is incomplete at ${APP_DEST}. Re-run with AGENT_FORCE_REBUILD=true`,
    );
  }

  const sidecarPath = join(AI_QA_ROOT, "../automation/app/.build-sha");
  try {
    const sha = execSync(`git -C "${OPERATOR_APP_ROOT}" rev-parse --short origin/main`, {
      encoding: "utf-8",
    }).trim();
    if (sha) {
      writeFileSync(sidecarPath, JSON.stringify({ sha, builtAt: new Date().toISOString() }));
      console.log(`   SHA: ${sha} → ${sidecarPath}`);
    }
  } catch {
    /* best-effort */
  }

  const toastEnv = readToastEnvironment(APP_DEST);
  const bundleId = readBundleId(APP_DEST);
  console.log(`\n✅ Copied ${builtApp}`);
  console.log(`   → ${APP_DEST}`);
  console.log(`   Binary: ${binary}`);
  if (toastEnv) console.log(`   Environment: ${toastEnv}`);
  if (bundleId) console.log(`   Bundle ID: ${bundleId}`);
  console.log("");
}

main();

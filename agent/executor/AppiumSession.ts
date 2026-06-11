import { join, resolve } from "path";
import { existsSync } from "fs";
import { execSync } from "child_process";
import { remote, type Browser } from "webdriverio";
import { SelectorHealer } from "../core/SelectorHealer.js";
import {
  describeSimulatorTarget,
  resolveDeviceName,
  resolvePlatformVersion,
  resolveSimulatorUdid,
} from "./simulatorConfig.js";
import { APPIUM_HOST, APPIUM_PORT, ensureAppiumRunning } from "./AppiumLauncher.js";

export class AppiumSession {
  private driver: Browser | null = null;
  private readonly healer = new SelectorHealer();
  private currentNoReset: boolean | null = null;
  private onLog?: (msg: string) => void;

  setLogger(onLog: (msg: string) => void): void {
    this.onLog = onLog;
  }

  async connect(opts?: { noReset?: boolean }): Promise<Browser> {
    const desiredNoReset = opts?.noReset ?? false;
    if (this.driver) {
      if (this.currentNoReset !== desiredNoReset) {
        await this.disconnect();
      } else {
        return this.driver;
      }
    }

    await ensureAppiumRunning((msg) => this.onLog?.(msg));
    this.onLog?.(`Simulator target: ${describeSimulatorTarget()}`);

    const udid = resolveSimulatorUdid();
    const appPath = resolve(
      process.env.TOAST_OPERATOR_APP_PATH ??
        join(process.cwd(), "../automation/app/ToastOperator.app"),
    );

    if (!existsSync(appPath)) {
      throw new Error(
        `ToastOperator.app not found at ${appPath}. Build with: cd ToastOperatorApp && ./Scripts/build-module.sh ToastOperator`,
      );
    }

    const plist = join(appPath, "Info.plist");
    if (existsSync(plist)) {
      try {
        const env = execSync(`/usr/libexec/PlistBuddy -c "Print :TOAST_ENVIRONMENT" "${plist}"`, {
          encoding: "utf-8",
        }).trim();
        const bundleId = execSync(
          `/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "${plist}"`,
          { encoding: "utf-8" },
        ).trim();
        this.onLog?.(`Launching app: ${env} (${bundleId})`);
        if (env !== "Production" || bundleId !== "com.toasttab.toastoperator") {
          this.onLog?.(
            "⚠ Expected Production (com.toasttab.toastoperator). " +
              "Run: AGENT_FORCE_REBUILD=true npm run app:build",
          );
        }
      } catch {
        /* ignore plist read errors */
      }
    }

    this.driver = await remote({
      hostname: APPIUM_HOST,
      port: APPIUM_PORT,
      path: "/",
      capabilities: {
        platformName: "iOS",
        "appium:automationName": "XCUITest",
        "appium:deviceName": resolveDeviceName(),
        "appium:platformVersion": resolvePlatformVersion(),
        ...(udid ? { "appium:udid": udid } : {}),
        "appium:app": appPath,
        "appium:noReset": desiredNoReset,
        "appium:autoLaunch": true,
        "appium:shouldTerminateApp": false,
        "appium:newCommandTimeout": 180,
      },
    });
    this.currentNoReset = desiredNoReset;

    return this.driver;
  }

  async disconnect(): Promise<void> {
    if (this.driver) {
      await this.driver.deleteSession();
      this.driver = null;
      this.currentNoReset = null;
    }
  }

  get active(): Browser | null {
    return this.driver;
  }

  async pageSource(): Promise<string> {
    const d = await this.requireDriver();
    return d.getPageSource();
  }

  async screenshotBase64(): Promise<string> {
    const d = await this.requireDriver();
    return d.takeScreenshot();
  }

  async pause(ms: number): Promise<void> {
    const d = await this.requireDriver();
    await d.pause(ms);
  }

  async tap(
    selector: string,
    opts?: { timeout?: number; action?: string; stepId?: string; injectDemoFailure?: boolean },
  ): Promise<{ usedSelector: string; healed: boolean; healingReason?: string }> {
    const d = await this.requireDriver();
    let current = selector;

    if (opts?.injectDemoFailure && selector.includes("StartCounting")) {
      current = "~StartCountingButton_WRONG_DEMO";
    }

    try {
      const el = await d.$(current);
      await el.waitForDisplayed({ timeout: opts?.timeout ?? 15000 });
      await el.click();
      return { usedSelector: current, healed: false };
    } catch (firstError) {
      const source = await d.getPageSource();
      const healed = await this.healer.heal(current, source, {
        stepId: opts?.stepId,
        action: opts?.action,
      });
      if (!healed) throw firstError;

      const el = await d.$(healed.selector);
      await el.waitForDisplayed({ timeout: opts?.timeout ?? 15000 });
      await el.click();
      return {
        usedSelector: healed.selector,
        healed: true,
        healingReason: healed.reason,
      };
    }
  }

  async type(selector: string, value: string, opts?: { timeout?: number }): Promise<void> {
    const d = await this.requireDriver();
    const el = await d.$(selector);
    await el.waitForDisplayed({ timeout: opts?.timeout ?? 10000 });
    await el.click();
    await this.clearTextIfPossible(el).catch(() => undefined);
    await el.setValue(value);
  }

  async clearAndType(selector: string, value: string, opts?: { timeout?: number }): Promise<void> {
    const d = await this.requireDriver();
    const el = await d.$(selector);
    await el.waitForDisplayed({ timeout: opts?.timeout ?? 10000 });
    await el.click();
    await this.clearTextIfPossible(el, { aggressive: true }).catch(() => undefined);
    await el.setValue(value);
  }

  async replaceFieldText(selector: string, value: string, opts?: { timeout?: number }): Promise<void> {
    const d = await this.requireDriver();
    const el = await d.$(selector);
    await el.waitForDisplayed({ timeout: opts?.timeout ?? 10000 });
    await el.click();
    await this.pause(200);

    const elementId = (el as unknown as { elementId?: string }).elementId;
    if (elementId) {
      try {
        await d.execute("mobile: clearText", { element: elementId });
      } catch {
        /* ignore */
      }
      try {
        await d.execute("mobile: replaceText", { element: elementId, value });
        return;
      } catch {
        /* fall through */
      }
    }

    await this.clearAndType(selector, value, opts);
  }

  async isEnabled(selector: string): Promise<boolean> {
    const d = await this.requireDriver();
    try {
      const el = await d.$(selector);
      return el.isEnabled();
    } catch {
      return false;
    }
  }

  async tapWhenEnabled(
    selectors: string[],
    opts?: { maxWaitMs?: number; pollMs?: number; tapTimeout?: number },
  ): Promise<string> {
    const maxWaitMs = opts?.maxWaitMs ?? 6000;
    const pollMs = opts?.pollMs ?? 120;
    const tapTimeout = opts?.tapTimeout ?? 5000;
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      for (const selector of selectors) {
        if (!(await this.isDisplayed(selector))) continue;
        if (await this.isEnabled(selector)) {
          await this.tap(selector, { timeout: tapTimeout });
          return selector;
        }
      }
      await this.pause(pollMs);
    }

    throw new Error(`Control not enabled in time: ${selectors.join(" | ")}`);
  }

  async hideKeyboard(searchKey = "Done"): Promise<void> {
    const d = await this.requireDriver();
    try {
      await (d as unknown as { hideKeyboard: (strategy?: unknown, key?: string) => Promise<void> }).hideKeyboard(
        undefined,
        searchKey,
      );
      return;
    } catch {
      /* ignore */
    }
    try {
      await d.execute("mobile: hideKeyboard", { key: searchKey });
    } catch {
      /* ignore */
    }
  }

  async tapFirstMatching(selectors: string[], timeoutMs = 20000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const selector of selectors) {
        if (await this.isDisplayed(selector)) {
          await this.tapWithFallback(selector);
          return selector;
        }
      }
      await this.pause(400);
    }
    throw new Error(`No tappable element found for: ${selectors.join(" | ")}`);
  }

  async tapWithFallback(selector: string): Promise<void> {
    const d = await this.requireDriver();
    const el = await d.$(selector);
    await el.waitForDisplayed({ timeout: 10000 });

    try {
      await el.click();
      return;
    } catch {
      /* try mobile gestures */
    }

    try {
      const id = (el as unknown as { elementId: string }).elementId;
      if (id) {
        await d.execute("mobile: tap", { element: id });
        return;
      }
    } catch {
      /* fall through */
    }

    const location = await el.getLocation();
    const size = await el.getSize();
    await d.execute("mobile: tap", {
      x: Math.round(location.x + size.width / 2),
      y: Math.round(location.y + size.height / 2),
    });
  }

  async swipeUp(): Promise<void> {
    const d = await this.requireDriver();
    await d.execute("mobile: swipe", { direction: "up" });
    await this.pause(600);
  }

  async swipe(direction: "up" | "down" | "left" | "right"): Promise<void> {
    const d = await this.requireDriver();
    await d.execute("mobile: swipe", { direction });
    await this.pause(600);
  }

  async scroll(direction: "up" | "down" | "left" | "right"): Promise<void> {
    const d = await this.requireDriver();
    await d.execute("mobile: scroll", { direction });
    await this.pause(600);
  }

  async tapAtPoint(x: number, y: number): Promise<void> {
    const d = await this.requireDriver();
    await d.execute("mobile: tap", { x: Math.round(x), y: Math.round(y) });
    await this.pause(300);
  }

  async getWindowSize(): Promise<{ width: number; height: number }> {
    const d = await this.requireDriver();
    const rect = await d.getWindowRect();
    return { width: rect.width, height: rect.height };
  }

  async isDisplayed(selector: string): Promise<boolean> {
    const d = await this.requireDriver();
    try {
      const el = await d.$(selector);
      return el.isDisplayed();
    } catch {
      return false;
    }
  }

  async getAttribute(selector: string, name: string): Promise<string | null> {
    const d = await this.requireDriver();
    try {
      const el = await d.$(selector);
      await el.waitForDisplayed({ timeout: 8000 });
      const value = await el.getAttribute(name);
      return value ?? null;
    } catch {
      return null;
    }
  }

  async waitForDisplayed(selector: string, timeout = 15000): Promise<void> {
    const d = await this.requireDriver();
    const el = await d.$(selector);
    await el.waitForDisplayed({ timeout });
  }

  async tapIfDisplayed(selector: string): Promise<boolean> {
    if (!(await this.isDisplayed(selector))) return false;
    try {
      const d = await this.requireDriver();
      const el = await d.$(selector);
      await el.click();
      await this.pause(500);
      return true;
    } catch {
      return false;
    }
  }

  async waitForAnyDisplayed(
    selectors: string[],
    timeoutMs: number,
    onPoll?: () => Promise<void>,
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (onPoll) await onPoll();
      for (const selector of selectors) {
        if (await this.isDisplayed(selector)) return selector;
      }
      await this.pause(500);
    }
    return null;
  }

  async dismissSystemAlerts(): Promise<void> {
    const d = await this.requireDriver();
    for (const action of ["dismiss", "accept"] as const) {
      try {
        await d.execute("mobile: alert", { action });
        await this.pause(400);
      } catch {
        /* no alert */
      }
    }
  }

  async acceptAlert(maxAttempts = 4): Promise<void> {
    const d = await this.requireDriver();
    for (let i = 0; i < maxAttempts; i++) {
      try {
        await d.acceptAlert();
        await this.pause(400);
      } catch {
        break;
      }
    }
  }

  async setOrientation(orientation: "PORTRAIT" | "LANDSCAPE"): Promise<void> {
    const d = await this.requireDriver();

    try {
      await d.setOrientation(orientation);
      await this.pause(900);
      return;
    } catch {
      /* falls through to WDA execute */
    }

    try {
      const radians = orientation === "LANDSCAPE" ? -(Math.PI / 2) : 0;
      await d.execute("mobile: rotateElement", { rotation: radians, velocity: 1 });
      await this.pause(900);
      return;
    } catch {
      /* falls through to simctl */
    }

    const { execSync } = await import("child_process");
    try {
      execSync(
        `osascript -e 'tell application "Simulator" to activate' \
          -e 'tell application "System Events" to tell process "Simulator" to click menu item "Rotate ${orientation === "LANDSCAPE" ? "Right" : "Left"}" of menu "Hardware" of menu bar 1'`,
        { stdio: "ignore", timeout: 5000 },
      );
    } catch {
      this.onLog?.(`[warn] Could not rotate to ${orientation} — continuing without rotation`);
    }
    await this.pause(900);
  }

  private async requireDriver(): Promise<Browser> {
    if (!this.driver) {
      await this.connect();
    }
    return this.driver!;
  }

  private async clearTextIfPossible(
    el: unknown,
    opts?: { aggressive?: boolean },
  ): Promise<void> {
    const d = await this.requireDriver();
    const wdioEl = el as {
      clearValue: () => Promise<void>;
      setValue: (v: string) => Promise<void>;
      elementId?: string;
    };

    try {
      await wdioEl.clearValue();
      return;
    } catch {
      /* fall through */
    }

    try {
      const id = wdioEl.elementId;
      if (id) {
        await d.execute("mobile: clearText", { element: id });
        return;
      }
    } catch {
      /* fall through */
    }

    try {
      await wdioEl.setValue("");
    } catch {
      /* ignore */
    }

    if (opts?.aggressive) {
      try {
        await d.execute("mobile: clearText", {});
      } catch {
        /* ignore */
      }
    }
  }
}

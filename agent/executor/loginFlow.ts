import { config } from "dotenv";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { AppiumSession } from "./AppiumSession.js";

const envPath = join(dirname(fileURLToPath(import.meta.url)), "../../.env");
config({ path: envPath, override: true });

export const LoginLocators = {
  loginButton: '//XCUIElementTypeButton[@name="Log in"]',
  loginButtonUpper: '//XCUIElementTypeButton[@name="LOGIN"]',
  loginButtonTitle: '//XCUIElementTypeButton[@name="Login"]',
  emailField: '//XCUIElementTypeTextField[@name="Email address"]',
  emailTextField: "//XCUIElementTypeTextField",
  returnButton: '//XCUIElementTypeButton[@name="Return"]',
  continueButton: '//XCUIElementTypeButton[@name="Continue"]',
  toastLogoImage: '//XCUIElementTypeImage[@name="Toast"]',
  passwordFieldContainer: '//XCUIElementTypeOther[@name="Enter Your Password"]',
  passwordSecureTextField: "//XCUIElementTypeSecureTextField",
  xMarkButton: '//XCUIElementTypeButton[@name="xmark"]',
  noThanksButton: '//XCUIElementTypeButton[@name="No thanks"]',
  inventoryTabA11y: "~Inventory",
  inventoryTabXPath: '//XCUIElementTypeButton[@name="Inventory"]',
  countSheetNameView: "~CountSheetNameView",
  inventoryEmptyState: "~InventoryCountsEmptyState",
  countListName: "~CountListName",
  getStartedTextSimple:
    '//XCUIElementTypeStaticText[@name="Get started with your count:"]',
  recaptchaMessage: '//XCUIElementTypeStaticText[contains(@name, "reCAPTCHA")]',
  recaptchaCloseButton: '//XCUIElementTypeButton[@name="Close"]',
};

const LOGIN_BUTTONS = [
  LoginLocators.loginButton,
  LoginLocators.loginButtonUpper,
  LoginLocators.loginButtonTitle,
];

export function getTestCredentials(): { email: string; password: string } {
  const email = process.env.TOAST_TEST_EMAIL;
  const password = process.env.TOAST_TEST_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "Missing credentials: set TOAST_TEST_EMAIL and TOAST_TEST_PASSWORD in your .env file.",
    );
  }
  return { email, password };
}

async function isLoginButtonVisible(session: AppiumSession): Promise<boolean> {
  for (const sel of LOGIN_BUTTONS) {
    if (await session.isDisplayed(sel)) return true;
  }
  return false;
}

async function tapLoginButton(session: AppiumSession): Promise<void> {
  const btn = await session.waitForAnyDisplayed(LOGIN_BUTTONS, 20000);
  if (!btn) {
    throw new Error('Welcome screen: expected a login button ("Log in" / "LOGIN")');
  }
  await session.tap(btn, { timeout: 15000 });
}

export async function isLoggedIn(session: AppiumSession): Promise<boolean> {
  const landed = await session.waitForAnyDisplayed(
    [
      LoginLocators.getStartedTextSimple,
      LoginLocators.countSheetNameView,
      LoginLocators.inventoryEmptyState,
      LoginLocators.countListName,
    ],
    2000,
  );
  return Boolean(landed);
}

export async function dismissNoThanksIfNeeded(session: AppiumSession): Promise<void> {
  if (await session.tapIfDisplayed(LoginLocators.noThanksButton)) {
    await session.pause(1000);
  }
}

async function dismissXMarkIfNeeded(session: AppiumSession): Promise<void> {
  if (await session.tapIfDisplayed(LoginLocators.xMarkButton)) {
    await session.pause(1000);
  }
}

async function dismissRecaptchaIfNeeded(session: AppiumSession): Promise<boolean> {
  if (!(await session.isDisplayed(LoginLocators.recaptchaMessage))) return false;
  await session.tapIfDisplayed(LoginLocators.recaptchaCloseButton);
  await session.pause(1000);
  return true;
}

export async function navigateToInventoryTab(session: AppiumSession): Promise<void> {
  const alreadyHome = await session.waitForAnyDisplayed(
    [
      LoginLocators.getStartedTextSimple,
      LoginLocators.countSheetNameView,
      LoginLocators.inventoryEmptyState,
      LoginLocators.countListName,
    ],
    1500,
  );
  if (alreadyHome) return;

  const tab = await session.waitForAnyDisplayed(
    [LoginLocators.inventoryTabA11y, LoginLocators.inventoryTabXPath],
    30000,
    async () => {
      await session.acceptAlert();
      await dismissXMarkIfNeeded(session);
      await dismissRecaptchaIfNeeded(session);
    },
  );
  if (!tab) {
    throw new Error('Inventory tab not visible after login (expected "Inventory")');
  }
  await session.tap(tab, { timeout: 15000 });
  await session.pause(2000);
}

export async function performOperatorLogin(session: AppiumSession): Promise<void> {
  await session.pause(5000);

  if (await isLoggedIn(session)) {
    await dismissNoThanksIfNeeded(session);
    await dismissXMarkIfNeeded(session);
    await navigateToInventoryTab(session);
    return;
  }

  const needsLogin = await isLoginButtonVisible(session);
  if (!needsLogin) {
    await dismissNoThanksIfNeeded(session);
    await dismissXMarkIfNeeded(session);
    await navigateToInventoryTab(session);
    if (await isLoggedIn(session)) return;
    throw new Error("Not logged in and no login button visible on welcome screen");
  }

  const { email, password } = getTestCredentials();

  await tapLoginButton(session);
  await session.pause(3000);
  await session.acceptAlert();

  await session.waitForDisplayed(LoginLocators.emailField, 15000);
  await session.tap(LoginLocators.emailField);
  await session.type(LoginLocators.emailField, email);
  await session.pause(1000);

  await dismissRecaptchaIfNeeded(session);

  if (await session.isDisplayed(LoginLocators.continueButton)) {
    await session.tap(LoginLocators.continueButton, { timeout: 10000 });
  } else if (await session.isDisplayed(LoginLocators.returnButton)) {
    await session.tap(LoginLocators.returnButton, { timeout: 10000 });
  } else {
    await session.hideKeyboard("Done");
  }
  await session.pause(2000);

  await dismissRecaptchaIfNeeded(session);

  if (await session.isDisplayed(LoginLocators.passwordFieldContainer)) {
    await session.tap(LoginLocators.passwordFieldContainer, { timeout: 10000 });
  }
  await session.waitForDisplayed(LoginLocators.passwordSecureTextField, 15000);
  await session.tap(LoginLocators.passwordSecureTextField);
  await session.type(LoginLocators.passwordSecureTextField, password);
  await session.pause(1000);

  await dismissRecaptchaIfNeeded(session);

  if (await session.isDisplayed(LoginLocators.continueButton)) {
    await session.tap(LoginLocators.continueButton, { timeout: 10000 });
  } else if (await session.isDisplayed(LoginLocators.returnButton)) {
    await session.tap(LoginLocators.returnButton, { timeout: 10000 });
  } else {
    await session.hideKeyboard("Done");
  }
  await session.pause(3000);

  await dismissNoThanksIfNeeded(session);
  await dismissXMarkIfNeeded(session);
  await session.pause(2000);

  const landed = await session.waitForAnyDisplayed(
    [
      LoginLocators.getStartedTextSimple,
      LoginLocators.countSheetNameView,
      LoginLocators.inventoryEmptyState,
      LoginLocators.countListName,
      LoginLocators.inventoryTabA11y,
      LoginLocators.inventoryTabXPath,
    ],
    60000,
    async () => {
      await session.acceptAlert();
      await dismissXMarkIfNeeded(session);
      await dismissRecaptchaIfNeeded(session);
    },
  );

  if (!landed) {
    const stillOnWelcome = await isLoginButtonVisible(session);
    if (stillOnWelcome) {
      throw new Error(
        "Login did not complete (still on welcome screen). " +
          "Try: AGENT_FORCE_REBUILD=true npm run app:build",
      );
    }
    throw new Error("Login did not reach Inventory home or tab bar within 60s");
  }

  await navigateToInventoryTab(session);
  await dismissNoThanksIfNeeded(session);

  if (!(await isLoggedIn(session))) {
    const onTabs = await session.isDisplayed(LoginLocators.inventoryTabA11y);
    if (!onTabs) {
      throw new Error("Login finished but Inventory home was not detected");
    }
  }
}

console.log(`
Build Toast Operator for the AI QA agent (real ToastUnifiedInventory module):

  cd /path/to/operator-app-ios/ToastOperatorApp
  ./Scripts/build-module.sh ToastOperator

Copy or symlink the .app into automation (existing E2E convention):

  mkdir -p ToastUnifiedInventory/automation/app
  cp -R DerivedData/Build/Products/*-iphonesimulator/Toast\\ Operator\\ Dev.app \\
     ToastUnifiedInventory/automation/app/ToastOperator.app

Or set TOAST_OPERATOR_APP_PATH in ai-qa-agent/.env

Prerequisites:
  - Appium: npx appium driver install xcuitest  (or use automation/node_modules)
  - Test credentials in .env (TEST_USER_EMAIL, TEST_USER_PASSWORD)
  - Feature flag opa-enable-unified-inventory enabled for test restaurant
`);

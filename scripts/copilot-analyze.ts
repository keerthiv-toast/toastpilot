#!/usr/bin/env npx tsx
import { config } from "dotenv";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { ChangeDetector } from "../copilot/changeDetection/ChangeDetector.js";

config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

const detector = new ChangeDetector();
const result = detector.analyze({
  gitBase: process.env.COPILOT_GIT_BASE,
  jiraTicket: process.env.COPILOT_JIRA_TICKET,
  commitMessage: process.env.COPILOT_COMMIT_MESSAGE,
});

console.log(JSON.stringify(result, null, 2));

#!/usr/bin/env tsx
import "dotenv/config";
import { AgentOrchestrator } from "./core/AgentOrchestrator.js";

const command =
  process.argv.slice(2).join(" ") || "Test Cycle Count inventory flow";

console.log(`\n🤖 ToastUnifiedInventory AI QA Agent`);
console.log(`📋 Command: "${command}"\n`);

const orchestrator = new AgentOrchestrator((event) => {
  switch (event.type) {
    case "plan:generated":
      console.log(`\n📝 Test plan: ${event.plan.flowName} (${event.plan.steps.length} steps)`);
      event.plan.steps.forEach((s, i) => console.log(`   ${i + 1}. ${s.description}`));
      break;
    case "step:started":
      console.log(`\n▶ [${event.index + 1}] ${event.step.description}`);
      break;
    case "step:healing":
      console.log(`   🔧 Self-heal: ${event.event.healedSelector} (${event.event.strategy})`);
      break;
    case "step:finished":
      console.log(`   ${event.step.status === "passed" || event.step.status === "healed" ? "✅" : "❌"} ${event.step.status}`);
      break;
    case "failure:explained":
      console.log(`\n💡 Explanation:\n${event.explanation}\n`);
      break;
    case "log":
      if (event.entry.level === "error") console.log(`   ⚠ ${event.entry.message}`);
      break;
    case "run:finished":
      console.log(`\n🏁 Run ${event.run.status.toUpperCase()} (${event.run.id})\n`);
      break;
  }
});

orchestrator
  .runCommand(command)
  .then((run) => process.exit(run.status === "passed" ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

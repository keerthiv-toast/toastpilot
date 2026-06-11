import { WebSocket } from "ws";
import type { AgentEvent } from "../agent/types.js";

export class EventBus {
  private clients = new Set<WebSocket>();
  private history: AgentEvent[] = [];
  private readonly maxHistory = 500;

  subscribe(ws: WebSocket): void {
    this.clients.add(ws);
    ws.send(JSON.stringify({ type: "history", events: this.history.slice(-100) }));
    ws.on("close", () => this.clients.delete(ws));
  }

  publish(event: AgentEvent): void {
    // IMPORTANT: freeze payload at publish time.
    // AgentOrchestrator reuses/mutates the same `run` object over time; without cloning,
    // earlier history entries (e.g. `run:started`) can balloon to include screenshots/logs
    // added later, and clients that connect mid-run can end up with an incoherent replay.
    const frozen = JSON.parse(JSON.stringify(event)) as AgentEvent;
    this.history.push(frozen);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
    const payload = JSON.stringify(frozen);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  getRecentEvents(): AgentEvent[] {
    return [...this.history];
  }
}

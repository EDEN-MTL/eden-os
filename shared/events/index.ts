import EventEmitter from "eventemitter3";
import { EdenEvent, EventType, AgentId } from "../types";

class EventBus extends EventEmitter {
  private emitEvent(type: EventType, event: EdenEvent): boolean {
    console.log(
      `[EVENT] ${event.agentId.toUpperCase()} → ${type} | client: ${event.clientId}`
    );
    return super.emit(type, event);
  }

  publish(
    type: EventType,
    agentId: AgentId,
    clientId: string,
    data: Record<string, any> = {}
  ): void {
    const event: EdenEvent = {
      type,
      agentId,
      clientId,
      timestamp: new Date().toISOString(),
      data,
    };
    this.emitEvent(type, event);
  }

  subscribe(type: EventType, handler: (event: EdenEvent) => void): void {
    this.on(type, handler);
    console.log(`[EVENT] Subscribed to: ${type}`);
  }
}

// Single instance shared across all agents
export const eventBus = new EventBus();

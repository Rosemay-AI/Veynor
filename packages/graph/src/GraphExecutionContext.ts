import type { GraphNode } from "./GraphNode.js";
import type { Signal } from "./Signal.js";

export class GraphExecutionContext {
  readonly runId: string;
  private activationCount = 0;
  private aborted = false;

  private signalBuffer: Map<string, Map<string, Signal[]>>;
  private queuedNodes = new Set<string>();
  private nodes: Map<string, GraphNode>;

  constructor(nodes: Map<string, GraphNode>) {
    this.runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.nodes = nodes;
    this.signalBuffer = new Map();
    for (const id of nodes.keys()) {
      this.signalBuffer.set(id, new Map());
    }
  }

  bufferSignal(nodeId: string, portId: string, signal: Signal): void {
    const nodeBuffer = this.signalBuffer.get(nodeId);
    if (!nodeBuffer) return;

    let portBuffer = nodeBuffer.get(portId);
    if (!portBuffer) {
      portBuffer = [];
      nodeBuffer.set(portId, portBuffer);
    }
    portBuffer.push(signal);
  }

  isReady(nodeId: string): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) return false;

    const nodeBuffer = this.signalBuffer.get(nodeId);
    if (!nodeBuffer) return false;

    for (const port of node.ports.inputs) {
      if (!port.required) continue;
      const portBuffer = nodeBuffer.get(port.id);
      if (!portBuffer || portBuffer.length === 0) return false;
    }

    return true;
  }

  collectInputs(nodeId: string): Signal[] {
    const nodeBuffer = this.signalBuffer.get(nodeId);
    if (!nodeBuffer) return [];

    const all: Signal[] = [];
    for (const signals of nodeBuffer.values()) {
      all.push(...signals);
    }
    return all;
  }

  clearBuffers(nodeId: string): void {
    this.signalBuffer.get(nodeId)?.clear();
  }

  isQueued(nodeId: string): boolean {
    return this.queuedNodes.has(nodeId);
  }

  markQueued(nodeId: string, queued: boolean): void {
    if (queued) {
      this.queuedNodes.add(nodeId);
    } else {
      this.queuedNodes.delete(nodeId);
    }
  }

  incrementActivations(): void {
    this.activationCount++;
  }

  get activations(): number {
    return this.activationCount;
  }

  abort(): void {
    this.aborted = true;
  }

  get isAborted(): boolean {
    return this.aborted;
  }
}

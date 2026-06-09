import type { AudioFrame } from "@veynor/core";
import {
  Skill,
  type SkillUtterance,
  type SkillContext,
} from "@veynor/skill-sdk";
import type { Edge } from "./Edge.js";
import type { GraphNode } from "./GraphNode.js";
import { GraphExecutionContext } from "./GraphExecutionContext.js";
import type { Signal } from "./Signal.js";
import { audioSignal, isAudio } from "./Signal.js";

export type GraphRuntimeOptions = {
  maxActivations?: number;
  maxQueueDepth?: number;
};

export class GraphRuntime extends Skill {
  readonly id: string;
  readonly name: string;
  readonly nodes: Map<string, GraphNode>;
  readonly edges: Edge[];
  private options: Required<GraphRuntimeOptions>;

  constructor(
    id: string,
    nodes: GraphNode[],
    edges: Edge[],
    options?: GraphRuntimeOptions
  ) {
    super();
    this.id = id;
    this.name = `Graph[${nodes.map((n) => n.id).join(",")}]`;
    this.nodes = new Map(nodes.map((n) => [n.id, n]));
    this.edges = edges;
    this.options = {
      maxActivations: options?.maxActivations ?? 1000,
      maxQueueDepth: options?.maxQueueDepth ?? 10000,
    };
    // Fail fast at construction time: a cyclic graph would otherwise
    // run forever (caught by maxActivations at run time, but with a
    // confusing warning rather than a clear construction error).
    this.assertAcyclic();
  }

  private assertAcyclic(): void {
    // Build adjacency list; reject edges to/from unknown nodes.
    const adj = new Map<string, string[]>();
    for (const nodeId of this.nodes.keys()) {
      adj.set(nodeId, []);
    }
    for (const e of this.edges) {
      if (!adj.has(e.from.nodeId)) {
        throw new Error(
          `GraphRuntime[${this.id}]: edge "${e.id}" references unknown source node "${e.from.nodeId}"`
        );
      }
      if (!adj.has(e.to.nodeId)) {
        throw new Error(
          `GraphRuntime[${this.id}]: edge "${e.id}" references unknown target node "${e.to.nodeId}"`
        );
      }
      adj.get(e.from.nodeId)!.push(e.to.nodeId);
    }

    // DFS with three-color marking. Back-edge (gray neighbor) = cycle.
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    for (const nodeId of this.nodes.keys()) {
      color.set(nodeId, WHITE);
    }

    const dfs = (nodeId: string, path: string[]): void => {
      color.set(nodeId, GRAY);
      for (const next of adj.get(nodeId)!) {
        const c = color.get(next);
        if (c === GRAY) {
          throw new Error(
            `GraphRuntime[${this.id}]: cycle detected: ${path.concat(next).join(" -> ")}`
          );
        }
        if (c === WHITE) {
          dfs(next, path.concat(next));
        }
      }
      color.set(nodeId, BLACK);
    };

    for (const nodeId of this.nodes.keys()) {
      if (color.get(nodeId) === WHITE) {
        dfs(nodeId, [nodeId]);
      }
    }
  }

  async *execute(
    utterance: SkillUtterance,
    ctx: SkillContext
  ): AsyncIterable<AudioFrame> {
    const inputSignal = audioSignal(this.id, utterance.audio());

    for await (const signal of this.run(inputSignal, ctx)) {
      if (!isAudio(signal)) continue;
      const audio = signal.payload;
      if (Array.isArray(audio)) {
        for (const f of audio) yield f;
      } else {
        yield* audio;
      }
    }
  }

  async *run(input: Signal, ctx: SkillContext): AsyncIterable<Signal> {
    if (this.nodes.size === 0) return;

    const execCtx = new GraphExecutionContext(this.nodes);
    const nodeQueue = this.seedInput(input, execCtx);

    while (nodeQueue.length > 0) {
      if (ctx.abortSignal.aborted || execCtx.isAborted) break;

      if (execCtx.activations >= this.options.maxActivations) {
        yield this.warningSignal(
          `max activations (${this.options.maxActivations}) reached`
        );
        break;
      }

      if (nodeQueue.length > this.options.maxQueueDepth) {
        yield this.warningSignal(
          `max queue depth (${this.options.maxQueueDepth}) exceeded`
        );
        break;
      }

      const nodeId = nodeQueue.shift();
      if (!nodeId) continue;
      execCtx.markQueued(nodeId, false);
      if (!execCtx.isReady(nodeId)) continue;

      const node = this.nodes.get(nodeId);
      if (!node) continue;

      const inputs = execCtx.collectInputs(nodeId);
      execCtx.clearBuffers(nodeId);
      execCtx.incrementActivations();

      for await (const outSignal of node.executeSignals(inputs, ctx)) {
        const targetNodeIds = this.routeSignal(outSignal, execCtx);
        if (targetNodeIds.length === 0) {
          yield outSignal;
          continue;
        }

        for (const targetNodeId of targetNodeIds) {
          if (execCtx.isReady(targetNodeId) && !execCtx.isQueued(targetNodeId)) {
            nodeQueue.push(targetNodeId);
            execCtx.markQueued(targetNodeId, true);
          }
        }
      }
    }
  }

  private seedInput(
    input: Signal,
    execCtx: GraphExecutionContext
  ): string[] {
    const entryNodes = this.findEntryNodes();
    if (entryNodes.length === 0) return [];

    const ready: string[] = [];
    for (const nodeId of entryNodes) {
      const node = this.nodes.get(nodeId)!;
      const matchingPort = node.ports.inputs.find((p) =>
        p.accepts.includes(input.type)
      );
      if (matchingPort) {
        execCtx.bufferSignal(nodeId, matchingPort.id, input);
        if (execCtx.isReady(nodeId)) {
          ready.push(nodeId);
          execCtx.markQueued(nodeId, true);
        }
      }
    }

    return ready;
  }

  private findEntryNodes(): string[] {
    const hasIncoming = new Set<string>();
    for (const edge of this.edges) {
      hasIncoming.add(edge.to.nodeId);
    }
    return [...this.nodes.keys()].filter((id) => !hasIncoming.has(id));
  }

  private findOutgoingEdges(sourceNodeId: string): Edge[] {
    return this.edges.filter((e) => e.from.nodeId === sourceNodeId);
  }

  private routeSignal(
    signal: Signal,
    execCtx: GraphExecutionContext
  ): string[] {
    const targetNodeIds = new Set<string>();

    for (const edge of this.findOutgoingEdges(signal.sourceNodeId)) {
      if (edge.condition && !edge.condition(signal)) continue;

      let result: Signal | Signal[] | null;
      if (edge.transform) {
        result = edge.transform(signal);
      } else {
        result = signal;
      }

      if (result === null) continue;

      const results = Array.isArray(result) ? result : [result];
      for (const r of results) {
        execCtx.bufferSignal(edge.to.nodeId, edge.to.portId, r);
        targetNodeIds.add(edge.to.nodeId);
      }
    }

    return [...targetNodeIds];
  }

  private warningSignal(message: string): Signal<"text", string> {
    return {
      type: "text",
      id: `warn-${Date.now()}`,
      sourceNodeId: this.id,
      timestamp: Date.now(),
      payload: message,
    };
  }
}

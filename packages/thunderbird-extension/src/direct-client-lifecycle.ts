import {
  DirectClientError,
  sameConnectionBinding,
  type BoundCompletion,
  type ComposeIdentity,
  type ConnectionBinding,
  type EditResult,
  type ThunderClawDirectClient,
  type DirectCallOptions,
  type TransformComposeRequest,
} from "./direct-client-contract.js";
import { randomId } from "./random-id.js";

export type DirectComposeState = ComposeIdentity & Readonly<{
  sessionId: string;
  binding: ConnectionBinding;
  activeRunId?: string;
}>;

export type DirectComposeTransformInput = Omit<TransformComposeRequest, keyof ComposeIdentity | "protocolVersion">;

type MutableComposeState = ComposeIdentity & {
  sessionId: string;
  binding: ConnectionBinding;
  activeRunId?: string;
};

type PendingOpen = ComposeIdentity & { count: number };

function lifecycleError(code: string, message: string): never {
  throw new DirectClientError("contract", code, message);
}

function cloneState(state: MutableComposeState): DirectComposeState {
  return {
    composeId: state.composeId,
    composeGeneration: state.composeGeneration,
    agentId: state.agentId,
    sessionId: state.sessionId,
    binding: state.binding,
    ...(state.activeRunId === undefined ? {} : { activeRunId: state.activeRunId }),
  };
}

export class DirectComposeLifecycleRegistry {
  private readonly sessions = new Map<string, MutableComposeState>();
  private readonly highestOpeningGeneration = new Map<string, number>();
  private readonly highestClosedGeneration = new Map<string, number>();
  private readonly pendingCancelCleanups = new Map<string, Promise<void>>();
  private readonly pendingOpens = new Map<string, Map<number, PendingOpen>>();

  constructor(
    private readonly client: ThunderClawDirectClient,
    private readonly createRequestId: () => string = randomId,
    private readonly getCurrentBinding: () => ConnectionBinding = () => client.binding,
  ) {}

  private acceptBinding(binding: ConnectionBinding, expected: ConnectionBinding = this.client.binding): void {
    if (!sameConnectionBinding(binding, expected) || !sameConnectionBinding(binding, this.getCurrentBinding())) lifecycleError("STALE_CONNECTION", "completion belongs to a replaced connection");
  }

  private acceptState(state: MutableComposeState): void {
    if (!sameConnectionBinding(state.binding, this.getCurrentBinding())) lifecycleError("STALE_CONNECTION", "compose state belongs to a replaced connection");
  }

  private beginPendingOpen(identity: ComposeIdentity): void {
    let generations = this.pendingOpens.get(identity.composeId);
    if (!generations) {
      generations = new Map();
      this.pendingOpens.set(identity.composeId, generations);
    }
    const pending = generations.get(identity.composeGeneration);
    if (pending && pending.agentId !== identity.agentId) lifecycleError("AGENT_MISMATCH", "compose session agent cannot change");
    if (pending) pending.count += 1;
    else generations.set(identity.composeGeneration, { ...identity, count: 1 });
  }

  private endPendingOpen(identity: ComposeIdentity): void {
    const generations = this.pendingOpens.get(identity.composeId);
    const pending = generations?.get(identity.composeGeneration);
    if (!generations || !pending) return;
    pending.count -= 1;
    if (pending.count === 0) generations.delete(identity.composeGeneration);
    if (generations.size === 0) this.pendingOpens.delete(identity.composeId);
  }

  private newestPendingOpen(composeId: string): PendingOpen | undefined {
    const generations = this.pendingOpens.get(composeId);
    if (!generations) return undefined;
    let newest: PendingOpen | undefined;
    for (const pending of generations.values()) {
      if (!newest || pending.composeGeneration > newest.composeGeneration) newest = pending;
    }
    return newest;
  }

  private tombstoneGeneration(composeId: string, generation: number): void {
    const previousClosed = this.highestClosedGeneration.get(composeId) ?? 0;
    if (generation > previousClosed) this.highestClosedGeneration.set(composeId, generation);
  }

  async open(identity: ComposeIdentity): Promise<DirectComposeState> {
    const existing = this.sessions.get(identity.composeId);
    const highest = this.highestOpeningGeneration.get(identity.composeId) ?? existing?.composeGeneration ?? 0;
    const closed = this.highestClosedGeneration.get(identity.composeId) ?? 0;
    if (!Number.isSafeInteger(identity.composeGeneration) || identity.composeGeneration < 1 || identity.composeGeneration < highest || identity.composeGeneration <= closed) {
      lifecycleError("STALE_COMPOSE_GENERATION", "compose generation has been replaced");
    }
    if (existing?.composeGeneration === identity.composeGeneration && existing.agentId !== identity.agentId) {
      lifecycleError("AGENT_MISMATCH", "compose session agent cannot change");
    }
    this.highestOpeningGeneration.set(identity.composeId, identity.composeGeneration);
    if (existing && existing.composeGeneration < identity.composeGeneration) this.sessions.delete(identity.composeId);
    this.acceptBinding(this.client.binding);
    const request = {
      protocolVersion: 1 as const,
      requestId: this.createRequestId(),
      composeId: identity.composeId,
      composeGeneration: identity.composeGeneration,
      agentId: identity.agentId,
    };
    this.beginPendingOpen(identity);
    try {
      const completion = await this.client.openCompose(request);
      this.acceptBinding(completion.binding);
      if (this.highestOpeningGeneration.get(identity.composeId) !== identity.composeGeneration || identity.composeGeneration <= (this.highestClosedGeneration.get(identity.composeId) ?? 0)) {
        await this.client.closeCompose({ ...request, requestId: this.createRequestId() }).catch(() => undefined);
        lifecycleError("STALE_COMPOSE_GENERATION", "compose generation has been replaced");
      }
      const current = this.sessions.get(identity.composeId);
      if (current && current.composeGeneration > identity.composeGeneration) lifecycleError("STALE_COMPOSE_GENERATION", "compose generation has been replaced");
      const state: MutableComposeState = {
        composeId: identity.composeId,
        composeGeneration: identity.composeGeneration,
        agentId: identity.agentId,
        sessionId: completion.value.sessionId,
        binding: completion.binding,
      };
      this.sessions.set(identity.composeId, state);
      return cloneState(state);
    } finally {
      this.endPendingOpen(identity);
    }
  }

  get(composeId: string): DirectComposeState | undefined {
    const state = this.sessions.get(composeId);
    if (state) this.acceptState(state);
    return state ? cloneState(state) : undefined;
  }

  async transform(composeId: string, input: DirectComposeTransformInput, options?: DirectCallOptions): Promise<BoundCompletion<EditResult>> {
    const state = this.sessions.get(composeId);
    if (!state) lifecycleError("COMPOSE_NOT_OPEN", "compose session is not open");
    this.acceptState(state);
    if (this.highestOpeningGeneration.get(composeId) !== state.composeGeneration) lifecycleError("STALE_COMPOSE_GENERATION", "compose generation has been replaced");
    if (state.activeRunId !== undefined || this.pendingCancelCleanups.has(composeId)) lifecycleError("RUN_ALREADY_ACTIVE", "a transform or its cancellation cleanup is still active");
    state.activeRunId = input.runId;
    try {
      const completion = await this.client.transformCompose({
        protocolVersion: 1,
        requestId: input.requestId,
        runId: input.runId,
        composeId: state.composeId,
        composeGeneration: state.composeGeneration,
        agentId: state.agentId,
        action: input.action,
        instruction: input.instruction,
        contextHash: input.contextHash,
        targetHash: input.targetHash,
        document: input.document,
        target: input.target,
        limits: input.limits,
      }, options);
      this.acceptBinding(completion.binding, state.binding);
      if (this.sessions.get(composeId) !== state || state.activeRunId !== input.runId) lifecycleError("STALE_OR_MISMATCHED_RESULT", "transform completion is no longer active");
      this.acceptState(state);
      return { binding: completion.binding, value: completion.value.result };
    } finally {
      if (state.activeRunId === input.runId) delete state.activeRunId;
    }
  }

  async cancel(composeId: string, requestId: string, runId: string): Promise<void> {
    const state = this.sessions.get(composeId);
    if (!state) lifecycleError("COMPOSE_NOT_OPEN", "compose session is not open");
    this.acceptState(state);
    if (state.activeRunId !== runId) lifecycleError("RUN_NOT_ACTIVE", "exact run is not active");
    delete state.activeRunId;
    const cleanup = (async () => {
      const completion = await this.client.cancelComposeRun({
        protocolVersion: 1,
        requestId,
        runId,
        composeId: state.composeId,
        composeGeneration: state.composeGeneration,
        agentId: state.agentId,
      });
      this.acceptBinding(completion.binding, state.binding);
    })();
    this.pendingCancelCleanups.set(composeId, cleanup);
    try {
      await cleanup;
    } finally {
      if (this.pendingCancelCleanups.get(composeId) === cleanup) this.pendingCancelCleanups.delete(composeId);
    }
  }

  async close(composeId: string, requestId?: string): Promise<void> {
    const state = this.sessions.get(composeId);
    if (!state) {
      const pending = this.newestPendingOpen(composeId);
      if (pending) this.tombstoneGeneration(composeId, pending.composeGeneration);
      return;
    }
    this.acceptState(state);
    this.sessions.delete(composeId);
    this.tombstoneGeneration(composeId, state.composeGeneration);
    const completion = await this.client.closeCompose({
      protocolVersion: 1,
      requestId: requestId ?? this.createRequestId(),
      composeId: state.composeId,
      composeGeneration: state.composeGeneration,
      agentId: state.agentId,
    });
    this.acceptBinding(completion.binding, state.binding);
  }
}

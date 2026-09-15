// Session metadata mutations, plugin state, and reset routing.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  type SessionsPatchManyResult,
  validateSessionsAssignOwnerParams,
  validateSessionsPatchManyParams,
  validateSessionsPatchParams,
  validateSessionsPluginPatchParams,
  validateSessionsRefreshBootstrapParams,
  validateSessionsResetParams,
} from "../../../packages/gateway-protocol/src/index.js";
// Yuiclaw fork（回搬自 openclaw-vendor #26/#67，2026-09-15 移植到 v2026.9.4 基线）：
// clearBootstrapSnapshot 清掉 sessions.refreshBootstrap 目标 sessionKey 的 bootstrap
// workspace-files 缓存（SOUL.md / context-files 等）。函数本身在 v2026.9.4 基线上路径/
// 签名都未变，直接复用。
import { clearBootstrapSnapshot } from "../../agents/bootstrap-cache.js";
import { assignSessionOwner } from "../../config/sessions/session-accessor.js";
import { patchPluginSessionExtension } from "../../plugins/host-hook-state.js";
import { isPluginJsonValue } from "../../plugins/host-hooks.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import {
  projectAssignableSessionOwner,
  projectSessionActor,
} from "../session-identity-projection.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  authorizeIncognitoSessionTarget,
  createSessionListEntryFilter,
  resolveSessionSharingTarget,
  SessionMutationAuthorizationChangedError,
} from "../session-sharing.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
import type { SessionActorProfileIdentity } from "../session-utils-contracts.js";
import { projectSessionPatchResult } from "../session-utils-model.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import { startSessionPatchDiagnostics } from "./sessions-patch-diagnostics.js";
import { executeSessionPatchMutations } from "./sessions-patch-engine.js";
import { createCommitGuard } from "./sessions-patch-errors.js";
import { sessionPatchTargetIdentity } from "./sessions-patch-expectations.js";
import {
  loadSessionsRuntimeModule,
  requireSessionKey,
  resolveGatewaySessionTargetFromKey,
} from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionMutationHandlers: GatewayRequestHandlers = {
  "sessions.patchMany": async ({
    params,
    respond,
    context,
    client,
    sessionMutationAuthorization,
  }) => {
    const diagnostics = startSessionPatchDiagnostics("sessions.patchMany");
    try {
      if (
        !assertValidParams(params, validateSessionsPatchManyParams, "sessions.patchMany", respond)
      ) {
        return;
      }
      const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
      if (
        params.patch.permissionMode === "full" &&
        client !== null &&
        !scopes.includes(ADMIN_SCOPE)
      ) {
        respond(
          false,
          undefined,
          missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] }),
        );
        return;
      }
      const targets = params.targets;
      const executed = await executeSessionPatchMutations({
        client,
        context,
        diagnostics,
        patch: params.patch,
        targets: targets.map((target) => ({
          ...target,
          commitGuard: createCommitGuard(target.key.trim(), () =>
            sessionMutationAuthorization?.assertTargetCurrent({
              sessionKey: target.key.trim(),
              ...(target.agentId ? { agentId: target.agentId } : {}),
            }),
          ),
        })),
      });
      if (!executed.ok) {
        respond(false, undefined, executed.error);
        return;
      }
      const outcomes: SessionsPatchManyResult["outcomes"] = [];
      diagnostics?.scope("response");
      for (const [index, outcome] of executed.outcomes.entries()) {
        const target = targets[index]!;
        const identity = {
          key: target.key,
          ...(target.agentId ? { agentId: target.agentId } : {}),
        };
        outcomes.push(
          outcome.ok ? { ok: true, ...identity } : { ok: false, ...identity, error: outcome.error },
        );
      }
      respond(true, { outcomes }, undefined);
    } finally {
      diagnostics?.finish();
    }
  },
  "sessions.patch": async ({ params, respond, context, client, sessionMutationAuthorization }) => {
    const diagnostics = startSessionPatchDiagnostics("sessions.patch");
    try {
      if (!assertValidParams(params, validateSessionsPatchParams, "sessions.patch", respond)) {
        return;
      }
      const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
      if (params.permissionMode === "full" && client !== null && !scopes.includes(ADMIN_SCOPE)) {
        respond(
          false,
          undefined,
          missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] }),
        );
        return;
      }
      const key = requireSessionKey(params.key, respond);
      if (!key) {
        return;
      }
      const patch = { ...params, key };
      const target = sessionPatchTargetIdentity(patch);
      const executed = await executeSessionPatchMutations({
        client,
        context,
        diagnostics,
        patch,
        targets: [
          {
            ...target,
            commitGuard: createCommitGuard(target.key, sessionMutationAuthorization?.assertCurrent),
          },
        ],
      });
      if (!executed.ok) {
        respond(false, undefined, executed.error);
        return;
      }
      const outcome = executed.outcomes[0]!;
      if (!outcome.ok) {
        respond(false, undefined, outcome.error);
        return;
      }
      const prepared = executed.preparedByIndex[0]!;
      diagnostics?.scope("response");
      respond(
        true,
        projectSessionPatchResult({
          ...prepared,
          cfg: executed.cfg,
          entry: outcome.entry,
          modelCatalog: await executed.catalogs.available(prepared.targetAgentId),
        }),
        undefined,
      );
    } finally {
      diagnostics?.finish();
    }
  },
  "sessions.assignOwner": async ({ params, respond, context, client }) => {
    if (
      !assertValidParams(params, validateSessionsAssignOwnerParams, "sessions.assignOwner", respond)
    ) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const runtimeAgentId = normalizeOptionalString(client?.internal?.agentRuntimeIdentity?.agentId);
    const agentToolCallerId =
      client?.internal?.syntheticClient === true
        ? normalizeOptionalString(client.internal.agentToolCaller?.agentId)
        : undefined;
    const trustedAgentId = runtimeAgentId ?? agentToolCallerId;
    const humanActor = gatewayClientSessionCreator(client);
    const assignedBy = trustedAgentId
      ? ({ type: "agent", id: trustedAgentId } as const)
      : humanActor
        ? ({ type: "human", id: humanActor.id } as const)
        : null;
    if (!assignedBy) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.FORBIDDEN, "sessions.assignOwner requires an identified caller"),
      );
      return;
    }
    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedSessionAgentId(cfg, key, params.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const target = resolveSessionSharingTarget({
      cfg,
      sessionKey: key,
      agentId: requestedAgent.agentId,
    });
    if (!target) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `unknown session: ${key}`));
      return;
    }
    const authorizeView = (candidate: NonNullable<typeof target>) =>
      authorizeIncognitoSessionTarget({ client, sessionKey: key, target: candidate }) ??
      (createSessionListEntryFilter({ client, cfg })?.(candidate.storeKey, candidate.entry) ===
      false
        ? errorShape(ErrorCodes.FORBIDDEN, "session is not visible to this connection")
        : null);
    const visibilityError = authorizeView(target);
    if (visibilityError) {
      respond(false, undefined, visibilityError);
      return;
    }
    const ownerIdentityById = new Map<string, SessionActorProfileIdentity | undefined>();
    const projectedOwner = projectAssignableSessionOwner(params.owner, ownerIdentityById, cfg);
    if (!projectedOwner) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown session owner "${params.owner.id}"`),
      );
      return;
    }
    const owner = { type: projectedOwner.type, id: projectedOwner.id };
    const assignment = assignSessionOwner(
      {
        agentId: target.agentId,
        sessionKey: target.storeKey,
        storePath: target.storePath,
      },
      {
        owner,
        assignedBy,
        assertCurrent: () => {
          const current = resolveSessionSharingTarget({
            cfg: context.getRuntimeConfig(),
            sessionKey: target.canonicalKey,
            agentId: target.agentId,
          });
          const currentError = current ? authorizeView(current) : null;
          if (
            !current ||
            current.entry.sessionId !== target.entry.sessionId ||
            current.storeKey !== target.storeKey ||
            currentError
          ) {
            throw new SessionMutationAuthorizationChangedError(
              currentError ??
                errorShape(
                  ErrorCodes.INVALID_REQUEST,
                  "session changed before sessions.assignOwner; retry the request",
                ),
            );
          }
        },
      },
    );
    const projectedActor = assignment
      ? projectAssignableSessionOwner(assignment.actor, ownerIdentityById, cfg)
      : null;
    const projectedAssignedBy = assignment?.assignedBy
      ? projectSessionActor(assignment.assignedBy, new Map(), cfg)
      : undefined;
    const projected =
      assignment && projectedActor
        ? {
            actor: projectedActor,
            ...(projectedAssignedBy ? { assignedBy: projectedAssignedBy } : {}),
            ...(assignment.assignedAt !== undefined ? { assignedAt: assignment.assignedAt } : {}),
          }
        : undefined;
    if (!projected) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `unknown session: ${key}`));
      return;
    }
    respond(true, { ok: true, key: target.canonicalKey, owner: projected }, undefined);
    emitSessionsChanged(context, {
      sessionKey: target.canonicalKey,
      agentId: target.agentId,
      reason: "owner",
    });
  },
  "sessions.pluginPatch": async ({
    params,
    respond,
    context,
    client,
    sessionMutationAuthorization,
  }) => {
    if (
      !assertValidParams(params, validateSessionsPluginPatchParams, "sessions.pluginPatch", respond)
    ) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
    if (!scopes.includes(ADMIN_SCOPE)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `sessions.pluginPatch requires gateway scope: ${ADMIN_SCOPE}`,
        ),
      );
      return;
    }
    const pluginId = normalizeOptionalString(params.pluginId);
    const namespace = normalizeOptionalString(params.namespace);
    if (!pluginId || !namespace) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "pluginId and namespace are required"),
      );
      return;
    }
    if (params.unset === true && params.value !== undefined) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sessions.pluginPatch cannot specify both unset and value",
        ),
      );
      return;
    }
    if (params.value !== undefined && !isPluginJsonValue(params.value)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sessions.pluginPatch value must be JSON-compatible",
        ),
      );
      return;
    }
    const requestedAgent = resolveRequestedSessionAgentId(
      context.getRuntimeConfig(),
      key,
      params.agentId,
    );
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const canonicalKey = resolveStoredSessionKeyForAgentStore({
      cfg: context.getRuntimeConfig(),
      agentId: requestedAgent.agentId,
      sessionKey: key,
    });
    const patched = await patchPluginSessionExtension({
      cfg: context.getRuntimeConfig(),
      sessionKey: canonicalKey,
      agentId: requestedAgent.agentId,
      pluginId,
      namespace,
      value: params.value,
      unset: params.unset === true,
      assertCurrent: sessionMutationAuthorization?.assertCurrent,
    });
    if (!patched.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, patched.error));
      return;
    }
    respond(true, { ok: true, key: patched.key, value: patched.value }, undefined);
    emitSessionsChanged(context, {
      sessionKey: patched.key,
      agentId: requestedAgent.agentId,
      reason: "plugin-patch",
    });
  },
  // Yuiclaw fork（回搬自 openclaw-vendor #26/#67，2026-09-15 移植到 v2026.9.4 基线）：
  // sessions.refreshBootstrap —— 软刷新：仅清掉指定 sessionKey 的 bootstrap workspace-files
  // 缓存（SOUL.md / context-files 等），让下一轮回复重新装载磁盘上的最新内容。
  //
  // 与 sessions.reset 的关键差别：
  //   reset            = 归档 transcript + 起新 sessionId + 清 bootstrap 缓存
  //                      （破坏性，丢对话上下文）
  //   refreshBootstrap = 仅清 bootstrap 缓存
  //                      （非破坏性，对话上下文保留）
  //
  // 适用场景：
  //   用户在 Yuiclaw 面板里改完 SOUL.md，希望下一轮回复立刻用新版 SOUL，但又不想丢
  //   当前的对话上下文。Yuiclaw 侧 /apply-soul 端点的 "soft" 模式调用此 RPC。
  //
  // 幂等性：即便指定 key 的缓存当前为空（首次访问还没装载过），也返回 ok:true。
  //
  // 不做的事：不归档 transcript、不切 sessionId、不动长期记忆（MEMORY.md / USER.md /
  // IDENTITY.md / memory/）、不触发 sessionUnbound lifecycle 事件、不调用
  // executeSyncNow（workspace 文件 sync 是上游链路的事，应在调用方先做）。
  //
  // canonical key 解析（回搬自 #67 的修复）：bootstrap 缓存按 canonical key 存储，
  // 必须先把 RPC 传入的 raw key（可能是 alias，如 "main"）解析成 canonical 再清，
  // 否则会返回 ok:true 但实际缓存（canonical key）没被清掉。对齐 sessions.patch /
  // sessions.reset 的 canonical 解析方式（v2026.9.4 基线上落点是
  // resolveGatewaySessionTargetFromKey，语义与旧基线一致，只是签名多要求传 cfg）。
  "sessions.refreshBootstrap": ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsRefreshBootstrapParams,
        "sessions.refreshBootstrap",
        respond,
      )
    ) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const { target } = resolveGatewaySessionTargetFromKey(key, cfg);
    clearBootstrapSnapshot(target.canonicalKey);
    respond(true, { ok: true, key: target.canonicalKey }, undefined);
  },
  "sessions.reset": async ({ params, respond, context, client, sessionMutationAuthorization }) => {
    if (!assertValidParams(params, validateSessionsResetParams, "sessions.reset", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }

    const reason = p.reason === "new" ? "new" : "reset";
    const { performGatewaySessionReset } = await loadSessionsRuntimeModule();
    const result = await performGatewaySessionReset({
      key,
      ...(p.agentId ? { agentId: p.agentId } : {}),
      reason,
      commandSource: "gateway:sessions.reset",
      creation: resolveOperatorSessionCreation(client),
      ...(client?.authenticatedUserProfile
        ? { requestingOperatorProfileId: client.authenticatedUserProfile.profileId }
        : {}),
      ...(client?.internal?.operatorRoleActor
        ? { operatorRoleActor: client.internal.operatorRoleActor }
        : {}),
      authorizedPluginId: normalizeOptionalString(client?.internal?.pluginRuntimeOwnerId),
      armSessionDiffBaselineCapture: true,
      workerPlacementContext: context,
      assertAuthorizedInstance: sessionMutationAuthorization?.assertCurrent,
    });
    if (!result.ok) {
      respond(false, undefined, result.error);
      return;
    }
    if ("incognitoDeleted" in result) {
      respond(true, { ok: true, key: result.key, deleted: true }, undefined);
      emitSessionsChanged(context, {
        sessionKey: result.key,
        agentId: result.agentId,
        sessionId: result.deletedSessionId,
        reason: "delete",
      });
      return;
    }
    respond(
      true,
      { ok: true, key: result.key, entry: result.entry, resolved: result.resolved },
      undefined,
    );
    emitSessionsChanged(context, {
      sessionKey: result.key,
      agentId: result.agentId,
      reason,
    });
  },
};

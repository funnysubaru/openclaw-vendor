import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { clearBootstrapSnapshot } from "../../agents/bootstrap-cache.js";
import {
  forkSessionFromParent,
  resolveParentForkMaxTokens,
} from "../../auto-reply/reply/session-fork.js";
import { loadConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveMainSessionKey,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { GATEWAY_CLIENT_IDS } from "../protocol/client-info.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSessionsCompactParams,
  validateSessionsDeleteParams,
  validateSessionsForkParams,
  validateSessionsForkResult,
  validateSessionsListParams,
  validateSessionsPatchParams,
  validateSessionsPreviewParams,
  validateSessionsRefreshBootstrapParams,
  validateSessionsResetParams,
  validateSessionsResolveParams,
} from "../protocol/index.js";
import {
  archiveSessionTranscriptsForSession,
  cleanupSessionBeforeMutation,
  emitSessionUnboundLifecycleEvent,
  performGatewaySessionReset,
} from "../session-reset-service.js";
import {
  archiveFileOnDisk,
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  loadSessionEntry,
  pruneLegacyStoreKeys,
  readSessionPreviewItemsFromTranscript,
  resolveGatewaySessionStoreTarget,
  resolveSessionModelRef,
  resolveSessionTranscriptCandidates,
  type SessionsPatchResult,
  type SessionsPreviewEntry,
  type SessionsPreviewResult,
  readSessionMessages,
} from "../session-utils.js";
import { applySessionsPatchToStore } from "../sessions-patch.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
import type { GatewayClient, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

function requireSessionKey(key: unknown, respond: RespondFn): string | null {
  const raw =
    typeof key === "string"
      ? key
      : typeof key === "number"
        ? String(key)
        : typeof key === "bigint"
          ? String(key)
          : "";
  const normalized = raw.trim();
  if (!normalized) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
    return null;
  }
  return normalized;
}

function resolveGatewaySessionTargetFromKey(key: string) {
  const cfg = loadConfig();
  const target = resolveGatewaySessionStoreTarget({ cfg, key });
  return { cfg, target, storePath: target.storePath };
}

function rejectWebchatSessionMutation(params: {
  action: "patch" | "delete";
  client: GatewayClient | null;
  isWebchatConnect: (params: GatewayClient["connect"] | null | undefined) => boolean;
  respond: RespondFn;
}): boolean {
  if (!params.client?.connect || !params.isWebchatConnect(params.client.connect)) {
    return false;
  }
  if (params.client.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `webchat clients cannot ${params.action} sessions; use chat.send for session-scoped updates`,
    ),
  );
  return true;
}

function migrateAndPruneSessionStoreKey(params: {
  cfg: ReturnType<typeof loadConfig>;
  key: string;
  store: Record<string, SessionEntry>;
}) {
  const target = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.key,
    store: params.store,
  });
  const primaryKey = target.canonicalKey;
  if (!params.store[primaryKey]) {
    const existingKey = target.storeKeys.find((candidate) => Boolean(params.store[candidate]));
    if (existingKey) {
      params.store[primaryKey] = params.store[existingKey];
    }
  }
  pruneLegacyStoreKeys({
    store: params.store,
    canonicalKey: primaryKey,
    candidates: target.storeKeys,
  });
  return { target, primaryKey, entry: params.store[primaryKey] };
}

export const sessionsHandlers: GatewayRequestHandlers = {
  "sessions.list": ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsListParams, "sessions.list", respond)) {
      return;
    }
    const p = params;
    const cfg = loadConfig();
    const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
    const result = listSessionsFromStore({
      cfg,
      storePath,
      store,
      opts: p,
    });
    respond(true, result, undefined);
  },
  "sessions.preview": ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsPreviewParams, "sessions.preview", respond)) {
      return;
    }
    const p = params;
    const keysRaw = Array.isArray(p.keys) ? p.keys : [];
    const keys = keysRaw
      .map((key) => String(key ?? "").trim())
      .filter(Boolean)
      .slice(0, 64);
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.max(1, p.limit) : 12;
    const maxChars =
      typeof p.maxChars === "number" && Number.isFinite(p.maxChars)
        ? Math.max(20, p.maxChars)
        : 240;

    if (keys.length === 0) {
      respond(true, { ts: Date.now(), previews: [] } satisfies SessionsPreviewResult, undefined);
      return;
    }

    const cfg = loadConfig();
    const storeCache = new Map<string, Record<string, SessionEntry>>();
    const previews: SessionsPreviewEntry[] = [];

    for (const key of keys) {
      try {
        const storeTarget = resolveGatewaySessionStoreTarget({ cfg, key, scanLegacyKeys: false });
        const store =
          storeCache.get(storeTarget.storePath) ?? loadSessionStore(storeTarget.storePath);
        storeCache.set(storeTarget.storePath, store);
        const target = resolveGatewaySessionStoreTarget({
          cfg,
          key,
          store,
        });
        const entry = target.storeKeys.map((candidate) => store[candidate]).find(Boolean);
        if (!entry?.sessionId) {
          previews.push({ key, status: "missing", items: [] });
          continue;
        }
        const items = readSessionPreviewItemsFromTranscript(
          entry.sessionId,
          target.storePath,
          entry.sessionFile,
          target.agentId,
          limit,
          maxChars,
        );
        previews.push({
          key,
          status: items.length > 0 ? "ok" : "empty",
          items,
        });
      } catch {
        previews.push({ key, status: "error", items: [] });
      }
    }

    respond(true, { ts: Date.now(), previews } satisfies SessionsPreviewResult, undefined);
  },
  "sessions.resolve": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsResolveParams, "sessions.resolve", respond)) {
      return;
    }
    const p = params;
    const cfg = loadConfig();

    const resolved = await resolveSessionKeyFromResolveParams({ cfg, p });
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    respond(true, { ok: true, key: resolved.key }, undefined);
  },
  "sessions.patch": async ({ params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsPatchParams, "sessions.patch", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "patch", client, isWebchatConnect, respond })) {
      return;
    }

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const applied = await updateSessionStore(storePath, async (store) => {
      const { primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      return await applySessionsPatchToStore({
        cfg,
        store,
        storeKey: primaryKey,
        patch: p,
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
      });
    });
    if (!applied.ok) {
      respond(false, undefined, applied.error);
      return;
    }
    const parsed = parseAgentSessionKey(target.canonicalKey ?? key);
    const agentId = normalizeAgentId(parsed?.agentId ?? resolveDefaultAgentId(cfg));
    const resolved = resolveSessionModelRef(cfg, applied.entry, agentId);
    const result: SessionsPatchResult = {
      ok: true,
      path: storePath,
      key: target.canonicalKey,
      entry: applied.entry,
      resolved: {
        modelProvider: resolved.provider,
        model: resolved.model,
      },
    };
    respond(true, result, undefined);
  },
  "sessions.reset": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsResetParams, "sessions.reset", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }

    const reason = p.reason === "new" ? "new" : "reset";
    const result = await performGatewaySessionReset({
      key,
      reason,
      commandSource: "gateway:sessions.reset",
    });
    if (!result.ok) {
      respond(false, undefined, result.error);
      return;
    }
    respond(true, { ok: true, key: result.key, entry: result.entry }, undefined);
  },
  // sessions.refreshBootstrap —— 软刷新：仅清掉指定 sessionKey 的 bootstrap workspace-files
  // 缓存（SOUL.md / context-files 等），让下一轮回复重新装载磁盘上的最新内容。
  //
  // 与 sessions.reset 的关键差别：
  //   reset           = 归档 jsonl + 起新 sessionId + 清 bootstrap 缓存（破坏性，丢对话历史）
  //   refreshBootstrap = 仅清 bootstrap 缓存（非破坏性，对话历史保留）
  //
  // 适用场景：
  //   用户在 Yuiclaw 面板里改完 SOUL.md，希望下一轮回复立刻用新版 SOUL，但又不想丢
  //   当前的对话上下文。Yuiclaw 侧 /apply-soul 端点的 "soft" 模式调用此 RPC。
  //
  // 幂等性：
  //   即便指定 key 的缓存当前为空（首次访问还没装载过），也返回 ok:true。
  //   不需要预先 sessions.list / sessions.get 校验 key 存在。
  //
  // 不做的事：
  //   - 不归档 jsonl
  //   - 不切 sessionId
  //   - 不动长期记忆（MEMORY.md / USER.md / IDENTITY.md / memory/）
  //   - 不触发 sessionUnbound lifecycle 事件
  //   - 不调用 executeSyncNow（workspace 文件 sync 是上游链路的事，应在调用方先做）
  "sessions.refreshBootstrap": ({ params, respond }) => {
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
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    // P2-3：bootstrap 缓存按 canonical key 存储,必须先把 RPC 传入的 raw key（可能是 alias，
    // 如 "main"）解析成 canonical 再清,否则会返回 ok:true 但实际缓存（canonical key）没被清掉。
    // 对齐 sessions.patch / sessions.reset 的 canonical 解析方式。
    const canonicalKey = resolveGatewaySessionTargetFromKey(key).target.canonicalKey ?? key;
    clearBootstrapSnapshot(canonicalKey);
    respond(true, { ok: true, key: canonicalKey }, undefined);
  },
  "sessions.delete": async ({ params, respond, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsDeleteParams, "sessions.delete", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "delete", client, isWebchatConnect, respond })) {
      return;
    }

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const mainKey = resolveMainSessionKey(cfg);
    if (target.canonicalKey === mainKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Cannot delete the main session (${mainKey}).`),
      );
      return;
    }

    const deleteTranscript = typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;

    const { entry, legacyKey, canonicalKey } = loadSessionEntry(key);
    const mutationCleanupError = await cleanupSessionBeforeMutation({
      cfg,
      key,
      target,
      entry,
      legacyKey,
      canonicalKey,
      reason: "session-delete",
    });
    if (mutationCleanupError) {
      respond(false, undefined, mutationCleanupError);
      return;
    }
    const sessionId = entry?.sessionId;
    const deleted = await updateSessionStore(storePath, (store) => {
      const { primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      const hadEntry = Boolean(store[primaryKey]);
      if (hadEntry) {
        delete store[primaryKey];
      }
      return hadEntry;
    });

    const archived =
      deleted && deleteTranscript
        ? archiveSessionTranscriptsForSession({
            sessionId,
            storePath,
            sessionFile: entry?.sessionFile,
            agentId: target.agentId,
            reason: "deleted",
          })
        : [];
    if (deleted) {
      const emitLifecycleHooks = p.emitLifecycleHooks !== false;
      await emitSessionUnboundLifecycleEvent({
        targetSessionKey: target.canonicalKey ?? key,
        reason: "session-delete",
        emitHooks: emitLifecycleHooks,
      });
    }

    respond(true, { ok: true, key: target.canonicalKey, deleted, archived }, undefined);
  },
  "sessions.get": ({ params, respond }) => {
    const p = params;
    const key = requireSessionKey(p.key ?? p.sessionKey, respond);
    if (!key) {
      return;
    }
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit)
        ? Math.max(1, Math.floor(p.limit))
        : 200;

    const { target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const store = loadSessionStore(storePath);
    const entry = target.storeKeys.map((k) => store[k]).find(Boolean);
    if (!entry?.sessionId) {
      respond(true, { messages: [] }, undefined);
      return;
    }
    const allMessages = readSessionMessages(entry.sessionId, storePath, entry.sessionFile);
    const messages = limit < allMessages.length ? allMessages.slice(-limit) : allMessages;
    respond(true, { messages }, undefined);
  },
  "sessions.compact": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsCompactParams, "sessions.compact", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }

    const maxLines =
      typeof p.maxLines === "number" && Number.isFinite(p.maxLines)
        ? Math.max(1, Math.floor(p.maxLines))
        : 400;

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    // Lock + read in a short critical section; transcript work happens outside.
    const compactTarget = await updateSessionStore(storePath, (store) => {
      const { entry, primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      return { entry, primaryKey };
    });
    const entry = compactTarget.entry;
    const sessionId = entry?.sessionId;
    if (!sessionId) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          reason: "no sessionId",
        },
        undefined,
      );
      return;
    }

    const filePath = resolveSessionTranscriptCandidates(
      sessionId,
      storePath,
      entry?.sessionFile,
      target.agentId,
    ).find((candidate) => fs.existsSync(candidate));
    if (!filePath) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          reason: "no transcript",
        },
        undefined,
      );
      return;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length <= maxLines) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          kept: lines.length,
        },
        undefined,
      );
      return;
    }

    const archived = archiveFileOnDisk(filePath, "bak");
    const keptLines = lines.slice(-maxLines);
    fs.writeFileSync(filePath, `${keptLines.join("\n")}\n`, "utf-8");

    await updateSessionStore(storePath, (store) => {
      const entryKey = compactTarget.primaryKey;
      const entryToUpdate = store[entryKey];
      if (!entryToUpdate) {
        return;
      }
      delete entryToUpdate.inputTokens;
      delete entryToUpdate.outputTokens;
      delete entryToUpdate.totalTokens;
      delete entryToUpdate.totalTokensFresh;
      entryToUpdate.updatedAt = Date.now();
    });

    respond(
      true,
      {
        ok: true,
        key: target.canonicalKey,
        compacted: true,
        archived,
        kept: keptLines.length,
      },
      undefined,
    );
  },

  // sessions.fork ——「対話ブランチ真継承コンテキスト」RPC（Yuiclaw design §4.1-4.2）
  //
  // 業務意図：
  //   Yuiclaw 工作台のブランチ作成時に源会話の完全な履歴を新会話に複製する。
  //   引擎にはすでに forkSessionFromParent（session-fork.ts）という実績ある実装があり、
  //   それを「会話作成時機」で呼び出せるよう薄い RPC として公開するだけ（§0.4 上游已有不重造）。
  //
  // 行為：
  //   1. sourceKey から源会話エントリを取得（存在しない → エラー）
  //   2. targetAgentId 解析（省略時 = 源 agentId）、newSessionKey 解析（省略時 = 自動生成）
  //   3. トークン護衛：源 totalTokens > parentForkMaxTokens → 空白会話を作成、inheritedHistory:false
  //   4. forkSessionFromParent を呼び出し（null 返却時 → step 3 の空白フォールバック）
  //   5. 新会話を store に登録（forkedFromParent=true、源のメタデータ継承）、永続化
  //   6. 新会話 3 つ組 + inheritedHistory を返す
  "sessions.fork": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsForkParams, "sessions.fork", respond)) {
      return;
    }
    const p = params;

    // Step 1: 源会話エントリ取得
    const sourceKey = String(p.sourceKey).trim();
    const loaded = loadSessionEntry(sourceKey);
    const { cfg, storePath, entry: sourceEntry, canonicalKey: canonicalSourceKey } = loaded;

    if (!sourceEntry?.sessionId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `sessions.fork: source session not found: ${sourceKey}`,
        ),
      );
      return;
    }

    // Step 2: targetAgentId と newSessionKey の解析
    // targetAgentId: 省略時は源 agentId を引き継ぐ（跨成員分岐も自然に機能）
    const parsedSource = parseAgentSessionKey(canonicalSourceKey);
    const sourceAgentId = normalizeAgentId(parsedSource?.agentId ?? resolveDefaultAgentId(cfg));
    const targetAgentId =
      typeof p.targetAgentId === "string" && p.targetAgentId.trim()
        ? normalizeAgentId(p.targetAgentId.trim())
        : sourceAgentId;

    // newSessionKey: 省略時は agent:<agentId>:user:<uuid> 形式で生成
    // 注意: パネル側でよく使われる "user:" プレフィックスのキーを踏襲する
    const newSessionKey =
      typeof p.newSessionKey === "string" && p.newSessionKey.trim()
        ? p.newSessionKey.trim().toLowerCase()
        : `agent:${targetAgentId}:user:${crypto.randomUUID()}`;

    // targetAgentId と newSessionKey の一致チェック（異なる agent に別 agentId のキーを作れない）
    const parsedNewKey = parseAgentSessionKey(newSessionKey);
    if (parsedNewKey && parsedNewKey.agentId !== targetAgentId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `sessions.fork: newSessionKey agent (${parsedNewKey.agentId}) does not match targetAgentId (${targetAgentId})`,
        ),
      );
      return;
    }

    // Step 3 & 4: トークン護衛 + fork 実行
    const parentForkMaxTokens = resolveParentForkMaxTokens(cfg);
    const parentTotalTokens =
      typeof sourceEntry.totalTokens === "number" ? sourceEntry.totalTokens : 0;
    const needsTokenGuard = parentTotalTokens > parentForkMaxTokens;

    // Step 5: targetAgentId のストアターゲットを先に解決する
    // （cross-agent 時の fork 後ファイル移動先を決定するために fork 前に必要）
    const targetStoreTarget = resolveGatewaySessionStoreTarget({ cfg, key: newSessionKey });
    const targetStorePath = targetStoreTarget.storePath;
    // targetAgentId のセッションディレクトリ（storePath の dirname = sessions/ ディレクトリ）
    const targetSessionsDir = path.dirname(targetStorePath);

    // Step 4: 実際の fork（護衛が不要な場合）
    let forkedResult: { sessionId: string; sessionFile: string } | null = null;
    if (!needsTokenGuard) {
      // sessionsDir は「親ファイルを探すためのベースディレクトリ」として使われる
      // （forkSessionFromParent の内部で resolveSessionFilePath に渡される）。
      // ここではソース agent の sessions ディレクトリを渡す必要がある——
      // ターゲット agent のディレクトリを渡すと親ファイルの containment check に失敗する。
      // fork 出力の物理的な配置先は step 4b で mv により調整する。
      const sourceSessionsDir = path.dirname(storePath);
      forkedResult = forkSessionFromParent({
        parentEntry: sourceEntry,
        agentId: targetAgentId,
        sessionsDir: sourceSessionsDir,
      });
      // forkSessionFromParent が null を返した（親ファイル不存在等）→ 空白フォールバック
      // 黒洞を避けるためエラーにしない（design §4.2 step 4）

      // Step 4b: cross-agent fork 時は jsonl をターゲット agent の sessionsDir に移動する。
      // forkSessionFromParent は親ファイルと同じディレクトリに出力するため
      // （manager.getSessionDir() = 親ファイルの dirname）、sourceAgentId ≠ targetAgentId の
      // 場合に出力先がソース agent のディレクトリになってしまう。
      // design §6「fork の jsonl 落 B の agentId 下」を実現するため、handler 側で mv する。
      if (forkedResult && sourceAgentId !== targetAgentId) {
        const srcFile = forkedResult.sessionFile;
        const srcBasename = path.basename(srcFile);
        const destFile = path.join(targetSessionsDir, srcBasename);
        try {
          // ターゲット sessionsDir が存在しない場合は作成する
          fs.mkdirSync(targetSessionsDir, { recursive: true });
          fs.renameSync(srcFile, destFile);
          forkedResult = { sessionId: forkedResult.sessionId, sessionFile: destFile };
        } catch (err) {
          // mv 失敗時は元のパス（ソース agent ディレクトリ）のままフォールバック。
          // 履歴を含む jsonl は絶対パスで store に登録されるので機能的には動くが、
          // メタデータ（targetStore）と物理ファイル（sourceDir）が別 agent に分離する稀なケース
          //（跨盤 EXDEV / 権限）。デグレード（履歴喪失）より「存在 + 動作」を優先しつつ、
          // 後追い診断できるよう warn を残す（review #85 第二輪 Minor 1）。
          context.logGateway.warn(
            `sessions.fork: cross-agent jsonl move failed, keeping source path. ` +
              `src=${srcFile} dest=${destFile} err=${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    const inheritedHistory = Boolean(forkedResult);

    // Step 5b: 新会話を store に登録
    await updateSessionStore(targetStorePath, (store) => {
      // 空白エントリの sessionId と sessionFile を確定
      const sessionId = forkedResult?.sessionId ?? crypto.randomUUID();
      const sessionFile = forkedResult?.sessionFile ?? "";

      // 新会話エントリを作成
      // 源のモデル・思考レベル等メタデータを継承する（design §6「元数据継承」）
      const newEntry: SessionEntry = {
        sessionId,
        updatedAt: Date.now(),
        sessionFile: sessionFile || undefined,
        // フォーク済みフラグ（session.ts の既存フォーク処理と同じ意味）
        forkedFromParent: true,
        // 源のモデル設定を継承
        model: sourceEntry.model,
        modelProvider: sourceEntry.modelProvider,
        thinkingLevel: sourceEntry.thinkingLevel,
        fastMode: sourceEntry.fastMode,
        verboseLevel: sourceEntry.verboseLevel,
        reasoningLevel: sourceEntry.reasoningLevel,
        elevatedLevel: sourceEntry.elevatedLevel,
        responseUsage: sourceEntry.responseUsage,
      };

      store[newSessionKey] = newEntry;
    });

    // 返却する sessionFile: フォーク成功時は実パス（mv 後）、フォールバック時は空文字
    const resultSessionFile = forkedResult?.sessionFile ?? "";
    const resultSessionId = forkedResult?.sessionId ?? "";

    // フォールバック時（空白会話）の sessionId を store から取得
    let finalSessionId = resultSessionId;
    let finalSessionFile = resultSessionFile;
    if (!forkedResult) {
      // updateSessionStore の後に再読み込みして登録済みエントリを確認
      const fallbackStore = loadSessionStore(targetStorePath);
      const fallbackEntry = fallbackStore[newSessionKey];
      if (fallbackEntry?.sessionId) {
        finalSessionId = fallbackEntry.sessionId;
        finalSessionFile = fallbackEntry.sessionFile ?? "";
      }
    }

    // レスポンスペイロードを構築し、スキーマバリデーションを通してから返す
    // （config.schema.lookup の validateConfigSchemaLookupResult と同じパターン）
    const resultPayload = {
      sessionKey: newSessionKey,
      sessionId: finalSessionId,
      sessionFile: finalSessionFile,
      inheritedHistory,
    };
    if (!validateSessionsForkResult(resultPayload)) {
      const errors = validateSessionsForkResult.errors ?? [];
      context.logGateway.warn(
        `sessions.fork produced invalid payload for ${newSessionKey}: ${formatValidationErrors(errors)}`,
      );
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "sessions.fork returned invalid payload", {
          details: { errors },
        }),
      );
      return;
    }
    respond(true, resultPayload, undefined);
  },
};

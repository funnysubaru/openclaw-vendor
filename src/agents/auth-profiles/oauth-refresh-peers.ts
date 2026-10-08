import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { toErrorObject } from "../../infra/errors.js";
import { waitForAgentDatabaseStartupAdmission } from "../../state/agent-startup-admission.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import {
  listCandidateAuthProfileStores,
  loadCandidateAuthProfileStore,
  updateCandidateAuthProfileStore,
  type CandidateAuthProfileStore,
} from "./candidate-stores.js";
import { hasUsableOAuthCredential } from "./credential-state.js";
import { isPersistedExternalCliAuthProfile } from "./external-cli-sync.js";
import { isExactOAuthCredential } from "./oauth-refresh-fence.js";
import {
  createFailedOAuthRefreshFence,
  isOAuthRefreshFence,
  isSameOAuthRefreshGeneration,
} from "./oauth-refresh-marker.js";
import { hasMatchingOAuthIdentity, hasOAuthIdentity } from "./oauth-shared.js";
import { getRuntimeExternalCliProfileIds } from "./runtime-external-profile-references.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

export type OAuthRefreshPeerClaim = {
  candidate: CandidateAuthProfileStore;
  original?: OAuthCredential;
};

export class OAuthRefreshPeerFenceError extends Error {
  readonly claims: OAuthRefreshPeerClaim[];

  constructor(claims: OAuthRefreshPeerClaim[], cause: unknown) {
    super("Failed to fence every historical OAuth refresh peer.", { cause });
    this.name = "OAuthRefreshPeerFenceError";
    this.claims = claims;
  }
}

function canonicalDatabasePath(databasePath: string): string {
  return resolvePathViaExistingAncestorSync(databasePath);
}

function isExternalProfileOwned(
  store: AuthProfileStore,
  profileId: string,
  credential: OAuthCredential,
): boolean {
  if (
    store.runtimeExternalProfileIds?.includes(profileId) === true ||
    getRuntimeExternalCliProfileIds(store).includes(profileId)
  ) {
    return true;
  }
  return isPersistedExternalCliAuthProfile({ profileId, credential });
}

function isEligibleHistoricalOAuthPeer(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: OAuthCredential;
  generation: OAuthCredential;
}): boolean {
  return (
    !isUserModelAuthProfileId(params.profileId) &&
    params.credential.provider === params.generation.provider &&
    params.credential.copyToAgents !== true &&
    params.credential.oauthRef === undefined &&
    !isExternalProfileOwned(params.store, params.profileId, params.credential) &&
    isSameOAuthRefreshGeneration({
      profileId: params.profileId,
      left: params.credential,
      right: params.generation,
    })
  );
}

function assertCredentialAllowsClaim(params: {
  candidate: CandidateAuthProfileStore;
  store: AuthProfileStore;
  profileId: string;
  credential: OAuthCredential;
  generation: OAuthCredential;
}): void {
  if (
    !isSameOAuthRefreshGeneration({
      profileId: params.profileId,
      left: params.credential,
      right: params.generation,
    })
  ) {
    return;
  }
  if (isOAuthRefreshFence(params.credential)) {
    throw new Error(
      `OAuth refresh generation is already claimed by another owner: ${params.candidate.databasePath}`,
    );
  }
  if (!isExternalProfileOwned(params.store, params.profileId, params.credential)) {
    return;
  }
  throw new Error(
    `OAuth refresh generation is still owned by an external credential source: ${params.candidate.databasePath}`,
  );
}

function isRemovableOAuthRefreshPeer(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: OAuthCredential;
  generation: OAuthCredential;
}): boolean {
  return (
    (isOAuthRefreshFence(params.generation) &&
      isExactOAuthCredential(params.credential, params.generation)) ||
    isEligibleHistoricalOAuthPeer(params)
  );
}

async function listPeerCandidates(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  ownerDatabasePath: string;
}): Promise<CandidateAuthProfileStore[]> {
  const ownerDatabasePath = canonicalDatabasePath(params.ownerDatabasePath);
  return (await listCandidateAuthProfileStores(params)).filter(
    (candidate) => candidate.databasePath !== ownerDatabasePath,
  );
}

/**
 * 写某个 peer 员工的 auth 库之前，等它的后台启动准入（ADR-0033 任务84(c) selfreview2 / 3）。
 *
 * 取舍（fail-closed）：peer 准入已失败、而它确实持有这份凭据（Yuiclaw 把订阅凭据广播进每个
 * 员工库，这是常态）时，这次刷新失败，不跳过它。跳过的话它保留着旧的 refresh token，重启后
 * 会拿旧 token 再刷一次，可能触发 OAuth 提供方的 refresh token 重用检测、把整个凭据族作废；
 * 相比之下"刷新失败、重启 gateway 后恢复"代价更小。上游同样 fail-closed：peer 库被准入拒绝时
 * 栅栏写抛错、回滚已认领的 peer 后整体失败。错误里点名员工并提示重启。
 * 关停 / 热重启的中止原样抛出。
 */
async function waitForOAuthRefreshPeerAdmission(
  candidate: CandidateAuthProfileStore,
): Promise<void> {
  try {
    await waitForAgentDatabaseStartupAdmission(candidate.agentId);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new Error(
      `OAuth refresh cannot fence agent "${candidate.agentId}": its database (${candidate.databasePath}) failed startup admission. Restart the gateway to retry that agent's admission, then retry the refresh.`,
      { cause: error },
    );
  }
}

/**
 * Replace every provable historical peer generation with the owner's exact
 * pending fence. Reads and writes are sequential, so no two databases share a
 * transaction.
 */
export async function fenceOAuthRefreshPeers(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  ownerDatabasePath: string;
  profileId: string;
  generation: OAuthCredential;
  fence: OAuthCredential;
  rollbackOnFailure?: boolean;
}): Promise<OAuthRefreshPeerClaim[]> {
  const claims: OAuthRefreshPeerClaim[] = [];
  try {
    for (const candidate of await listPeerCandidates(params)) {
      // 只读加载走只读连接池、不经准入闸门；等待只放在"确认要写 / 要认领"这个员工库之前
      // （见 waitForOAuthRefreshPeerAdmission），不持有这份凭据的员工既不等也不受其准入失败影响。
      const store = loadCandidateAuthProfileStore(candidate);
      if (!store) {
        continue;
      }
      const credential = store?.profiles[params.profileId];
      if (credential?.type !== "oauth") {
        continue;
      }
      if (isExactOAuthCredential(credential, params.fence)) {
        // 已是同一栅栏的 claim：之后的同步 settle / fail 会写它，先等它准入。
        await waitForOAuthRefreshPeerAdmission(candidate);
        claims.push({ candidate });
        continue;
      }
      assertCredentialAllowsClaim({
        candidate,
        store,
        profileId: params.profileId,
        credential,
        generation: params.generation,
      });
      if (
        !isEligibleHistoricalOAuthPeer({
          store,
          profileId: params.profileId,
          credential,
          generation: params.generation,
        })
      ) {
        continue;
      }
      let claimed = false;
      const original = { ...credential };
      // 确认是要认领的历史同代际 peer，马上同步写它的库：先等它的后台启动准入。等待期间库内
      // 状态若变了也安全——下面是带 updater 的比对写，不匹配就不认领。
      await waitForOAuthRefreshPeerAdmission(candidate);
      const updated = updateCandidateAuthProfileStore({
        candidate,
        profileId: params.profileId,
        updater: (currentStore) => {
          const current = currentStore.profiles[params.profileId];
          if (!isExactOAuthCredential(current?.type === "oauth" ? current : undefined, original)) {
            return false;
          }
          currentStore.profiles[params.profileId] = { ...params.fence };
          claimed = true;
          return true;
        },
      });
      if (!claimed) {
        const current = updated.store.profiles[params.profileId];
        if (isExactOAuthCredential(current?.type === "oauth" ? current : undefined, params.fence)) {
          claims.push({ candidate });
          continue;
        }
        if (current?.type === "oauth") {
          assertCredentialAllowsClaim({
            candidate,
            store: updated.store,
            profileId: params.profileId,
            credential: current,
            generation: params.generation,
          });
          if (
            isEligibleHistoricalOAuthPeer({
              store: updated.store,
              profileId: params.profileId,
              credential: current,
              generation: params.generation,
            })
          ) {
            throw new Error(
              `OAuth refresh peer changed before it could be fenced: ${candidate.databasePath}`,
            );
          }
        }
        continue;
      }
      claims.push({ candidate, original });
    }
    return claims;
  } catch (error) {
    if (params.rollbackOnFailure !== false) {
      try {
        rollbackOAuthRefreshPeerClaims({
          profileId: params.profileId,
          fence: params.fence,
          claims,
        });
      } catch (rollbackError) {
        // oxlint-disable-next-line preserve-caught-error -- AggregateError.errors retains rollbackError; cause must remain the original fencing failure.
        throw new AggregateError(
          [error, rollbackError],
          "Failed to fence every historical OAuth refresh peer and roll back partial claims.",
          { cause: error },
        );
      }
      throw error;
    }
    throw new OAuthRefreshPeerFenceError(claims, error);
  }
}

/** Restore pre-I/O peer claims; a retained fence becomes terminal on restore failure. */
export function rollbackOAuthRefreshPeerClaims(params: {
  profileId: string;
  fence: OAuthCredential;
  claims: readonly OAuthRefreshPeerClaim[];
}): void {
  const unresolved: Error[] = [];
  for (const claim of params.claims.toReversed()) {
    if (!claim.original) {
      continue;
    }
    let restoreError: Error | undefined;
    try {
      let restored = false;
      updateCandidateAuthProfileStore({
        candidate: claim.candidate,
        profileId: params.profileId,
        updater: (store) => {
          const current = store.profiles[params.profileId];
          if (
            !isExactOAuthCredential(current?.type === "oauth" ? current : undefined, params.fence)
          ) {
            return false;
          }
          store.profiles[params.profileId] = { ...claim.original! };
          restored = true;
          return true;
        },
      });
      if (restored) {
        continue;
      }
    } catch (error) {
      restoreError = toErrorObject(error, "Failed to restore OAuth refresh peer");
    }
    try {
      updateCandidateAuthProfileStore({
        candidate: claim.candidate,
        profileId: params.profileId,
        updater: (store) => {
          const current = store.profiles[params.profileId];
          if (
            !isExactOAuthCredential(current?.type === "oauth" ? current : undefined, params.fence)
          ) {
            return false;
          }
          store.profiles[params.profileId] = createFailedOAuthRefreshFence(params.fence);
          return true;
        },
      });
    } catch (error) {
      const terminalError = toErrorObject(error, "Failed to terminally fence OAuth refresh peer");
      unresolved.push(
        restoreError
          ? new AggregateError(
              [restoreError, terminalError],
              `Failed to resolve OAuth refresh peer rollback: ${claim.candidate.databasePath}`,
              { cause: restoreError },
            )
          : terminalError,
      );
    }
  }
  if (unresolved.length > 0) {
    throw new AggregateError(unresolved, "Failed to roll back every OAuth refresh peer.", {
      cause: unresolved[0],
    });
  }
}

/**
 * Retire exact peer fences only when their original credential can safely
 * inherit the authoritative shared credential. Otherwise leave a terminal
 * marker so merged resolution cannot expose another account.
 */
export function settleOAuthRefreshPeerClaims(params: {
  profileId: string;
  fence: OAuthCredential;
  claims: readonly OAuthRefreshPeerClaim[];
  authoritativeSharedCredential?: OAuthCredential;
  replacement: OAuthCredential;
}): void {
  let firstError: Error | undefined;
  for (const claim of params.claims) {
    try {
      updateCandidateAuthProfileStore({
        candidate: claim.candidate,
        preserveProfileState: true,
        profileId: params.profileId,
        updater: (store) => {
          const current = store.profiles[params.profileId];
          if (
            !isExactOAuthCredential(current?.type === "oauth" ? current : undefined, params.fence)
          ) {
            return false;
          }
          const inherited = params.authoritativeSharedCredential;
          const canInherit =
            claim.original !== undefined &&
            inherited !== undefined &&
            inherited.provider === claim.original.provider &&
            hasUsableOAuthCredential(inherited) &&
            (hasMatchingOAuthIdentity(claim.original, inherited) ||
              (!hasOAuthIdentity(claim.original) &&
                isExactOAuthCredential(inherited, params.replacement)));
          if (canInherit) {
            delete store.profiles[params.profileId];
          } else {
            store.profiles[params.profileId] = createFailedOAuthRefreshFence(params.fence);
          }
          return true;
        },
      });
    } catch (error) {
      firstError ??= toErrorObject(error, "Failed to settle OAuth refresh peer");
    }
  }
  if (firstError !== undefined) {
    throw firstError;
  }
}

/** Convert every exact peer fence into a terminal no-replay marker. */
export function failOAuthRefreshPeerClaims(params: {
  profileId: string;
  fence: OAuthCredential;
  claims: readonly OAuthRefreshPeerClaim[];
}): void {
  const failed = createFailedOAuthRefreshFence(params.fence);
  let firstError: Error | undefined;
  for (const claim of params.claims) {
    try {
      updateCandidateAuthProfileStore({
        candidate: claim.candidate,
        profileId: params.profileId,
        updater: (store) => {
          const current = store.profiles[params.profileId];
          if (
            !isExactOAuthCredential(current?.type === "oauth" ? current : undefined, params.fence)
          ) {
            return false;
          }
          store.profiles[params.profileId] = failed;
          return true;
        },
      });
    } catch (error) {
      firstError ??= toErrorObject(error, "Failed to fail OAuth refresh peer");
    }
  }
  if (firstError !== undefined) {
    throw firstError;
  }
}

/** Remove one owner generation and its exact nonportable historical peers. */
export async function removeOAuthRefreshGenerationPeers(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  ownerDatabasePath: string;
  profileId: string;
  generation: OAuthCredential;
}): Promise<void> {
  for (const candidate of await listPeerCandidates(params)) {
    const store = loadCandidateAuthProfileStore(candidate);
    if (!store) {
      continue;
    }
    const credential = store?.profiles[params.profileId];
    if (credential?.type !== "oauth") {
      continue;
    }
    const removable = isRemovableOAuthRefreshPeer({
      store,
      profileId: params.profileId,
      credential,
      generation: params.generation,
    });
    if (!removable) {
      continue;
    }
    // 确认该员工持有这一代凭据、要删除它：写库之前先等它的后台启动准入。
    await waitForOAuthRefreshPeerAdmission(candidate);
    updateCandidateAuthProfileStore({
      candidate,
      preserveProfileState: true,
      profileId: params.profileId,
      updater: (currentStore) => {
        const current = currentStore.profiles[params.profileId];
        if (current?.type !== "oauth") {
          return false;
        }
        if (
          !isExactOAuthCredential(current, credential) ||
          !isRemovableOAuthRefreshPeer({
            store: currentStore,
            profileId: params.profileId,
            credential: current,
            generation: params.generation,
          })
        ) {
          return false;
        }
        delete currentStore.profiles[params.profileId];
        return true;
      },
    });
  }
}

import { isDeepStrictEqual } from "node:util";
import { refreshContextWindowCache } from "../agents/context.js";
import {
  getRuntimeConfigSnapshotMetadata,
  getRuntimeConfigSourceSnapshot,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeSnapshotRevisionState,
  hasActiveSecretsRuntimeSnapshotLineage,
  hasSameSecretReloadContract,
  restoreSecretsRuntimeSourceSnapshotIfLineageCurrent,
  setSecretsRuntimeSourceSnapshotIfCurrent,
  type PreparedSecretsRuntimeSnapshot,
} from "../secrets/runtime-state.js";
import { diffConfigPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  isNoopGatewayReloadPlan,
  type ChannelKind,
} from "./config-reload-plan.js";
import { shouldRefreshContextWindowCache } from "./config-reload-recovery.js";
import type {
  GatewayConfigReloadTransactionOwnership,
  startGatewayConfigReloader,
} from "./config-reload.js";
import {
  GatewayConfigReloadSupersededError,
  GatewayHotReloadRecoveryError,
  GatewayHotReloadStaleSecretsError,
  type CurrentRuntimeSecretsPreparation,
  type GatewayHotReloadPublication,
  type ManagedGatewayConfigReloaderParams,
  type RuntimeSecretsPreflightParams,
} from "./server-reload-contracts.js";
import type { createGatewayReloadHandlers } from "./server-reload-hot.js";
import {
  captureSharedGatewaySessionGenerationOwnership,
  claimSharedGatewaySessionGenerationIfOwned,
  disconnectStaleSharedGatewayAuthClients,
  finalizeOwnedSharedGatewaySessionGeneration,
  isSharedGatewaySessionGenerationOwnershipCurrent,
  restoreOwnedCurrentSharedGatewaySessionGeneration,
  type SharedGatewaySessionGenerationOwnership,
} from "./server-shared-auth-generation.js";
import { publishRuntimeSecretsStateTransition } from "./server-startup-config.js";

export function isRuntimeSecretsPreparationCurrent(
  preparation: CurrentRuntimeSecretsPreparation,
): boolean {
  return getActiveSecretsRuntimeSnapshotRevisionState() === preparation.expectedRevision;
}

async function activateSecretsRuntimeSnapshotIfCurrent(
  snapshot: PreparedSecretsRuntimeSnapshot,
  expectedRevision: number,
  options?: {
    canActivate?: () => boolean;
    onActivated?: () => void;
    runtimeSourceConfig?: OpenClawConfig;
  },
): Promise<boolean> {
  const runtime = await import("../secrets/runtime.js");
  if (options?.canActivate && !options.canActivate()) {
    return false;
  }
  if (
    !runtime.activateSecretsRuntimeSnapshotIfCurrent(snapshot, expectedRevision, {
      runtimeSourceConfig: options?.runtimeSourceConfig,
    })
  ) {
    return false;
  }
  options?.onActivated?.();
  return true;
}

async function restoreSecretsRuntimeSnapshotIfCurrent(
  snapshot: PreparedSecretsRuntimeSnapshot,
  expectedRevision: number,
  ownedSnapshot: PreparedSecretsRuntimeSnapshot,
  options?: { onActivated?: () => void; runtimeSourceConfig?: OpenClawConfig },
): Promise<boolean> {
  const runtime = await import("../secrets/runtime.js");
  if (
    !runtime.restoreSecretsRuntimeSnapshotIfCurrent(snapshot, expectedRevision, ownedSnapshot, {
      runtimeSourceConfig: options?.runtimeSourceConfig,
    })
  ) {
    return false;
  }
  options?.onActivated?.();
  return true;
}

type PrepareRuntimeCandidate = (
  runtimeConfig: OpenClawConfig,
  sourceConfig: OpenClawConfig,
  ownership?: GatewayConfigReloadTransactionOwnership,
) => OpenClawConfig;

type TryPrepareRuntimeSecrets = (
  config: OpenClawConfig,
  transactionOwnership: GatewayConfigReloadTransactionOwnership,
  activationParams: RuntimeSecretsPreflightParams,
) => Promise<CurrentRuntimeSecretsPreparation | null>;

type ManagedReloadOptions = Parameters<typeof startGatewayConfigReloader>[0];
type EffectiveConfigUnchangedHandler = NonNullable<
  ManagedReloadOptions["onEffectiveConfigUnchanged"]
>;
type HotReloadHandler = NonNullable<ManagedReloadOptions["onHotReload"]>;

/**
 * 诊断用（Yuiclaw ADR-0033 任务 119）：描述某个配置值的「形状」，绝不包含值本身。
 * channels.* 下面挂着渠道 token / secret，所以只输出类型、字符串长度、数组长度、
 * 对象的 key 列表（key 是字段名或账号 id，不是机密）；数字、布尔同样只给类型，
 * 避免任何原值进日志。
 */
function describeConfigValueShape(value: unknown): string {
  if (value === undefined) {
    return "absent";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return `string(len=${value.length})`;
  }
  if (Array.isArray(value)) {
    return `array(len=${value.length})`;
  }
  if (typeof value === "object") {
    return `object{${Object.keys(value).toSorted().join(",")}}`;
  }
  return typeof value;
}

/** 按 diffConfigPaths 产出的点分路径取值；中途断掉返回 undefined（显示为 absent）。 */
function readConfigPath(config: unknown, path: string): unknown {
  let current: unknown = config;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * 诊断用（Yuiclaw ADR-0033 任务 119）：热重载时「活动密钥快照」与「新准备的运行时配置」
 * 之间的 channels.* 差异会让渠道（如 LINE）重启，而渠道重启要等在途请求结束——
 * 1.16.0 上添加订阅卡 5 分钟就是这么来的，但写入的文件里并没有改 channels.*，
 * 隔离副本也复现不出，只能在真实环境抓这份差异。
 * 输出每条路径 + 新旧值形状，例如 `channels.line.accessToken: string(len=172) -> string(len=0)`。
 * 安全边界：只拼路径与形状，绝不输出值（含渠道 token）。
 */
export function describeChannelDiffShapes(
  previousConfig: unknown,
  nextConfig: unknown,
  paths: readonly string[],
): string {
  return paths
    .map(
      (path) =>
        `${path}: ${describeConfigValueShape(readConfigPath(previousConfig, path))} -> ${describeConfigValueShape(readConfigPath(nextConfig, path))}`,
    )
    .join("; ");
}

export function createManagedReloadSecretHandlers(options: {
  params: Pick<
    ManagedGatewayConfigReloaderParams,
    | "activateRuntimeSecrets"
    | "assertRuntimeSecurityConfig"
    | "clients"
    | "commitRuntimePolicy"
    | "reconcileRuntimePolicy"
    | "resolveSharedGatewaySessionGenerationForConfig"
    | "sharedGatewaySessionGenerationState"
  >;
  prepareRuntimeCandidate: PrepareRuntimeCandidate;
  tryPrepareRuntimeSecrets: TryPrepareRuntimeSecrets;
  applyHotReload: ReturnType<typeof createGatewayReloadHandlers>["applyHotReload"];
  /** 可选：只用于下方 channels.* 差异诊断 warn；测试等不传时静默。 */
  logReload?: { warn: (msg: string) => void };
}) {
  const { params, prepareRuntimeCandidate, tryPrepareRuntimeSecrets, applyHotReload, logReload } =
    options;
  const onEffectiveConfigUnchanged: EffectiveConfigUnchangedHandler = async (
    nextConfig,
    transactionOwnership,
    sourceConfig,
  ) => {
    for (;;) {
      if (!transactionOwnership.isCurrent()) {
        throw new GatewayConfigReloadSupersededError();
      }
      const previousRuntimeSourceConfig = getRuntimeConfigSourceSnapshot();
      const previousSecretsSnapshot = getActiveSecretsRuntimeSnapshotState();
      const previousSecretsRevision = getActiveSecretsRuntimeSnapshotRevisionState();
      const previousRuntimeMetadata = getRuntimeConfigSnapshotMetadata();
      const nextSecretsSourceConfig = prepareRuntimeCandidate(
        nextConfig,
        sourceConfig,
        transactionOwnership,
      );
      if (
        previousRuntimeMetadata &&
        previousRuntimeSourceConfig &&
        previousSecretsSnapshot &&
        hasSameSecretReloadContract(previousSecretsSnapshot.sourceConfig, nextSecretsSourceConfig)
      ) {
        const sourceOnlySnapshot = {
          ...previousSecretsSnapshot,
          sourceConfig: nextSecretsSourceConfig,
        };
        if (!isDeepStrictEqual(sourceOnlySnapshot.config, nextConfig)) {
          throw new GatewayConfigReloadSupersededError();
        }
        if (!transactionOwnership.isCurrent()) {
          throw new GatewayConfigReloadSupersededError();
        }
        if (
          !setSecretsRuntimeSourceSnapshotIfCurrent({
            expectedSecretsRevision: previousSecretsRevision,
            expectedRuntimeConfigRevision: previousRuntimeMetadata.revision,
            runtimeSourceConfig: sourceConfig,
            secretsSourceConfig: nextSecretsSourceConfig,
          })
        ) {
          continue;
        }
        const committedSecretsRevision = getActiveSecretsRuntimeSnapshotRevisionState();
        const rollbackPublishedSource = async () => {
          if (
            !restoreSecretsRuntimeSourceSnapshotIfLineageCurrent({
              expectedLineageRevision: committedSecretsRevision,
              runtimeSourceConfig: previousRuntimeSourceConfig,
              secretsSourceConfig: previousSecretsSnapshot.sourceConfig,
            })
          ) {
            throw new GatewayConfigReloadSupersededError();
          }
        };
        if (!transactionOwnership.isCurrent()) {
          await rollbackPublishedSource();
          throw new GatewayConfigReloadSupersededError();
        }
        return {
          rollback: rollbackPublishedSource,
          commit: () =>
            publishRuntimeSecretsStateTransition(
              params.activateRuntimeSecrets,
              sourceOnlySnapshot,
              {
                sourceOnly: true,
                expectedRevision: committedSecretsRevision,
              },
            ),
        };
      }
      const preparation = await tryPrepareRuntimeSecrets(
        nextSecretsSourceConfig,
        transactionOwnership,
        {
          reason: "reload",
          publishFailureAsDegraded: true,
          ...(transactionOwnership.runtimeEnv ? { env: transactionOwnership.runtimeEnv.env } : {}),
          includeAuthStoreRefs: true,
        },
      );
      if (!previousRuntimeMetadata || !transactionOwnership.isCurrent()) {
        throw new GatewayConfigReloadSupersededError();
      }
      if (getRuntimeConfigSnapshotMetadata()?.revision !== previousRuntimeMetadata.revision) {
        if (hasActiveSecretsRuntimeSnapshotLineage(previousSecretsRevision)) {
          continue;
        }
        throw new GatewayConfigReloadSupersededError();
      }
      if (
        !preparation ||
        preparation.expectedRevision !== previousSecretsRevision ||
        !isRuntimeSecretsPreparationCurrent(preparation)
      ) {
        continue;
      }
      const preparedSecrets = preparation.snapshot;
      if (!transactionOwnership.isCurrent()) {
        throw new GatewayConfigReloadSupersededError();
      }
      if (!isDeepStrictEqual(preparedSecrets.config, nextConfig)) {
        throw new GatewayConfigReloadSupersededError();
      }
      if (!previousRuntimeSourceConfig || !previousSecretsSnapshot) {
        throw new GatewayConfigReloadSupersededError();
      }
      const activateIfCurrent = params.activateRuntimeSecrets.activatePreparedSnapshotIfCurrent;
      const activated = activateIfCurrent
        ? await activateIfCurrent(
            preparedSecrets,
            previousSecretsRevision,
            {
              reason: "reload",
              activate: true,
              deferStatePublication: true,
              runtimeSourceConfig: sourceConfig,
            },
            undefined,
            transactionOwnership.isCurrent,
          )
        : (await activateSecretsRuntimeSnapshotIfCurrent(preparedSecrets, previousSecretsRevision, {
              canActivate: transactionOwnership.isCurrent,
              runtimeSourceConfig: sourceConfig,
            }))
          ? preparedSecrets
          : null;
      if (!activated) {
        continue;
      }
      const committedSecretsRevision = getActiveSecretsRuntimeSnapshotRevisionState();
      const rollbackPublishedSource = async () => {
        if (
          !(await restoreSecretsRuntimeSnapshotIfCurrent(
            previousSecretsSnapshot,
            committedSecretsRevision,
            activated,
            { runtimeSourceConfig: previousRuntimeSourceConfig },
          ))
        ) {
          throw new GatewayConfigReloadSupersededError();
        }
      };
      if (!transactionOwnership.isCurrent()) {
        await rollbackPublishedSource();
        throw new GatewayConfigReloadSupersededError();
      }
      return {
        rollback: rollbackPublishedSource,
        commit: () =>
          publishRuntimeSecretsStateTransition(params.activateRuntimeSecrets, activated),
      };
    }
  };
  const onHotReload: HotReloadHandler = async (
    plan,
    nextConfig,
    transactionOwnership,
    sourceConfig,
  ) => {
    const authoredChannels = new Set(plan.restartChannels);
    const authoredAccountTargets = new Map<ChannelKind, Set<string>>(
      [...(plan.restartChannelAccounts ?? [])].map(([channel, ids]) => [channel, new Set(ids)]),
    );
    // A deferred channel/plugin reload can overlap secrets.reload. Retry from
    // preparation unless the same active snapshot still owns publication.
    for (;;) {
      if (!transactionOwnership.isCurrent()) {
        throw new GatewayConfigReloadSupersededError();
      }
      const previousSnapshot = getActiveSecretsRuntimeSnapshotState();
      // Prepared secrets carry effective defaults; commit and rollback must retain authored provenance.
      const previousRuntimeSourceConfig = getRuntimeConfigSourceSnapshot() ?? undefined;
      const previousSnapshotRevision = getActiveSecretsRuntimeSnapshotRevisionState();
      const previousGenerationOwnership = captureSharedGatewaySessionGenerationOwnership(
        params.sharedGatewaySessionGenerationState,
      );
      const previousSharedGatewaySessionGeneration = previousGenerationOwnership.generation;
      const preparation = await tryPrepareRuntimeSecrets(
        prepareRuntimeCandidate(nextConfig, sourceConfig, transactionOwnership),
        transactionOwnership,
        {
          reason: "reload",
          publishFailureAsDegraded: true,
          ...(transactionOwnership.runtimeEnv ? { env: transactionOwnership.runtimeEnv.env } : {}),
          includeAuthStoreRefs: transactionOwnership.runtimeRefresh?.includeAuthStoreRefs,
        },
      );
      if (
        !preparation ||
        preparation.expectedRevision !== previousSnapshotRevision ||
        !isRuntimeSecretsPreparationCurrent(preparation)
      ) {
        continue;
      }
      const prepared = preparation.snapshot;
      params.assertRuntimeSecurityConfig?.(prepared.config, transactionOwnership.runtimeEnv?.env);
      // Resolution can change channel lifetimes even when only a provider
      // definition changed. Rebuild each attempt so a lost CAS leaves no targets.
      const resolvedChannelPaths = previousSnapshot
        ? diffConfigPaths(previousSnapshot.config, prepared.config).filter(
            (path) => path === "channels" || path.startsWith("channels."),
          )
        : [];
      const resolvedChannelPlan = buildGatewayReloadPlan(resolvedChannelPaths, {
        candidateConfig: prepared.config,
      });
      // 诊断（Yuiclaw ADR-0033 任务 119）：解析出来的 channels.* 差异要重启渠道时，
      // 把触发重启的路径和新旧值形状记下来，用于在真实环境定位「文件没改渠道却重启了 LINE」。
      // 只打路径与形状，不打值（describeChannelDiffShapes 保证）。
      if (
        previousSnapshot &&
        (resolvedChannelPlan.restartChannels.size > 0 ||
          (resolvedChannelPlan.restartChannelAccounts?.size ?? 0) > 0)
      ) {
        logReload?.warn(
          `config hot reload: resolved channel diff restarts channels [${[
            ...resolvedChannelPlan.restartChannels,
          ].join(",")}] accounts [${[...(resolvedChannelPlan.restartChannelAccounts ?? [])]
            .map(([channel, ids]) => `${channel}:${[...ids].join("|")}`)
            .join(",")}]; paths: ${describeChannelDiffShapes(
            previousSnapshot.config,
            prepared.config,
            resolvedChannelPaths,
          )}`,
        );
      }
      plan.restartChannels = new Set([...authoredChannels, ...resolvedChannelPlan.restartChannels]);
      plan.restartChannelAccounts = new Map(
        [...authoredAccountTargets].map(([channel, ids]) => [channel, new Set(ids)]),
      );
      for (const [channel, ids] of resolvedChannelPlan.restartChannelAccounts ?? []) {
        const targets = plan.restartChannelAccounts.get(channel) ?? new Set<string>();
        for (const id of ids) {
          targets.add(id);
        }
        plan.restartChannelAccounts.set(channel, targets);
      }
      for (const channel of plan.restartChannels) {
        plan.restartChannelAccounts.delete(channel);
      }
      if (!transactionOwnership.isCurrent()) {
        throw new GatewayConfigReloadSupersededError();
      }
      if (getActiveSecretsRuntimeSnapshotRevisionState() !== previousSnapshotRevision) {
        continue;
      }
      const nextSharedGatewaySessionGeneration =
        params.resolveSharedGatewaySessionGenerationForConfig(prepared.config);
      const sharedGatewaySessionGenerationChanged =
        previousSharedGatewaySessionGeneration !== nextSharedGatewaySessionGeneration;
      let runtimeSecretsPublished = false;
      let runtimeCommitted = false;
      let publishedSnapshotRevision: number | null = null;
      let publishedSharedGatewaySessionGeneration: SharedGatewaySessionGenerationOwnership | null =
        null;
      let runtimePolicyReconciled = false;
      let applicationStatus: Awaited<ReturnType<typeof applyHotReload>>;
      try {
        const publication: GatewayHotReloadPublication = {
          isCurrent: transactionOwnership.isCurrent,
          ...(transactionOwnership.runtimeEnv
            ? { runtimeEnv: transactionOwnership.runtimeEnv.env }
            : {}),
          sourceConfig,
          prepareRestartRuntimeConfig: async () => {
            for (;;) {
              const restartPrepared = await tryPrepareRuntimeSecrets(
                prepareRuntimeCandidate(prepared.config, sourceConfig, transactionOwnership),
                transactionOwnership,
                {
                  reason: "restart-check",
                  publishFailureAsDegraded: true,
                  ...(transactionOwnership.runtimeEnv
                    ? { env: transactionOwnership.runtimeEnv.env }
                    : {}),
                },
              );
              if (!transactionOwnership.isCurrent()) {
                throw new GatewayConfigReloadSupersededError();
              }
              if (restartPrepared && isRuntimeSecretsPreparationCurrent(restartPrepared)) {
                return restartPrepared.snapshot.config;
              }
            }
          },
          publish: async (commit, isCommitted) => {
            const claimGenerationOwnership = () => {
              publishedSharedGatewaySessionGeneration ??=
                claimSharedGatewaySessionGenerationIfOwned(
                  params.sharedGatewaySessionGenerationState,
                  previousGenerationOwnership,
                  nextSharedGatewaySessionGeneration,
                );
              if (!publishedSharedGatewaySessionGeneration) {
                throw new GatewayHotReloadStaleSecretsError();
              }
            };
            const publishRuntime = async () => {
              runtimeSecretsPublished = true;
              publishedSnapshotRevision = getActiveSecretsRuntimeSnapshotRevisionState();
              // Claim the generation at the snapshot activation edge, but keep
              // `required` until the runtime commit succeeds.
              claimGenerationOwnership();
              try {
                // Hot-reloaded services inherit process.env. Publish the
                // prepared layer at the same edge as secrets/runtime state,
                // before any replacement service or channel starts.
                transactionOwnership.publishRuntimeEnv();
                try {
                  await commit();
                } finally {
                  // Published policy remains authoritative if a later service handoff fails.
                  // Commit admission policy before irreversible PTY and socket eviction.
                  if (isCommitted()) {
                    if (!runtimePolicyReconciled) {
                      params.commitRuntimePolicy(prepared.config);
                      await params.reconcileRuntimePolicy(prepared.config, "committed");
                      runtimePolicyReconciled = true;
                    }
                    if (sharedGatewaySessionGenerationChanged) {
                      disconnectStaleSharedGatewayAuthClients({
                        clients: params.clients,
                        expectedGeneration: nextSharedGatewaySessionGeneration,
                      });
                    }
                  }
                }
              } catch (err) {
                if (!isCommitted()) {
                  let generationRestored = false;
                  let snapshotRestored = false;
                  const generationOwnership = publishedSharedGatewaySessionGeneration;
                  if (previousSnapshot && generationOwnership) {
                    snapshotRestored = await restoreSecretsRuntimeSnapshotIfCurrent(
                      previousSnapshot,
                      publishedSnapshotRevision ?? -1,
                      prepared,
                      {
                        runtimeSourceConfig: previousRuntimeSourceConfig,
                        onActivated: () => {
                          generationRestored = restoreOwnedCurrentSharedGatewaySessionGeneration(
                            params.sharedGatewaySessionGenerationState,
                            generationOwnership,
                            previousSharedGatewaySessionGeneration,
                          );
                        },
                      },
                    );
                  } else if (
                    publishedSnapshotRevision !== null &&
                    getActiveSecretsRuntimeSnapshotRevisionState() === publishedSnapshotRevision
                  ) {
                    clearSecretsRuntimeSnapshotState();
                    snapshotRestored = true;
                    if (generationOwnership) {
                      generationRestored = restoreOwnedCurrentSharedGatewaySessionGeneration(
                        params.sharedGatewaySessionGenerationState,
                        generationOwnership,
                        previousSharedGatewaySessionGeneration,
                      );
                    }
                  }
                  if (snapshotRestored) {
                    if (previousSnapshot && shouldRefreshContextWindowCache(plan)) {
                      await refreshContextWindowCache(previousSnapshot.config);
                    }
                    runtimeSecretsPublished = false;
                  }
                  if (generationRestored && sharedGatewaySessionGenerationChanged) {
                    disconnectStaleSharedGatewayAuthClients({
                      clients: params.clients,
                      expectedGeneration: previousSharedGatewaySessionGeneration,
                    });
                  }
                }
                throw err;
              } finally {
                if (isCommitted()) {
                  runtimeCommitted = true;
                  transactionOwnership.markRuntimeCommitted(prepared.config, plan);
                }
              }
            };
            const activateIfCurrent =
              params.activateRuntimeSecrets.activatePreparedSnapshotIfCurrent;
            if (activateIfCurrent) {
              const activated = await activateIfCurrent(
                prepared,
                previousSnapshotRevision,
                {
                  reason: "reload",
                  activate: true,
                  runtimeSourceConfig: sourceConfig,
                },
                publishRuntime,
                () =>
                  transactionOwnership.isCurrent() &&
                  isSharedGatewaySessionGenerationOwnershipCurrent(
                    params.sharedGatewaySessionGenerationState,
                    previousGenerationOwnership,
                  ),
              );
              if (!activated) {
                throw new GatewayHotReloadStaleSecretsError();
              }
            } else {
              if (
                !(await activateSecretsRuntimeSnapshotIfCurrent(
                  prepared,
                  previousSnapshotRevision,
                  {
                    canActivate: () =>
                      transactionOwnership.isCurrent() &&
                      isSharedGatewaySessionGenerationOwnershipCurrent(
                        params.sharedGatewaySessionGenerationState,
                        previousGenerationOwnership,
                      ),
                    onActivated: claimGenerationOwnership,
                    runtimeSourceConfig: sourceConfig,
                  },
                ))
              ) {
                throw new GatewayHotReloadStaleSecretsError();
              }
              await publishRuntime();
            }
          },
        };
        if (isNoopGatewayReloadPlan(plan)) {
          // A source no-op still shares secret/auth publication ownership, but
          // must not churn services or prepared model owners without an effect.
          let committed = false;
          await publication.publish(
            async () => {
              committed = true;
            },
            () => committed,
          );
          applicationStatus = "applied";
        } else {
          applicationStatus = await applyHotReload(plan, prepared.config, publication);
        }
      } catch (err) {
        if (err instanceof GatewayHotReloadStaleSecretsError) {
          if (!transactionOwnership.isCurrent()) {
            throw new GatewayConfigReloadSupersededError();
          }
          continue;
        }
        if (err instanceof GatewayHotReloadRecoveryError) {
          throw err;
        }
        if (runtimeCommitted) {
          throw err;
        }
        if (runtimeSecretsPublished) {
          let generationRestored = false;
          let snapshotRestored = false;
          const generationOwnership = publishedSharedGatewaySessionGeneration;
          if (previousSnapshot && publishedSnapshotRevision !== null && generationOwnership) {
            snapshotRestored = await restoreSecretsRuntimeSnapshotIfCurrent(
              previousSnapshot,
              publishedSnapshotRevision,
              prepared,
              {
                runtimeSourceConfig: previousRuntimeSourceConfig,
                onActivated: () => {
                  generationRestored = restoreOwnedCurrentSharedGatewaySessionGeneration(
                    params.sharedGatewaySessionGenerationState,
                    generationOwnership,
                    previousSharedGatewaySessionGeneration,
                  );
                },
              },
            );
          } else if (
            publishedSnapshotRevision !== null &&
            generationOwnership &&
            getActiveSecretsRuntimeSnapshotRevisionState() === publishedSnapshotRevision
          ) {
            clearSecretsRuntimeSnapshotState();
            snapshotRestored = true;
            generationRestored = restoreOwnedCurrentSharedGatewaySessionGeneration(
              params.sharedGatewaySessionGenerationState,
              generationOwnership,
              previousSharedGatewaySessionGeneration,
            );
          }
          if (snapshotRestored) {
            if (previousSnapshot && shouldRefreshContextWindowCache(plan)) {
              await refreshContextWindowCache(previousSnapshot.config);
            }
          }
          if (generationRestored && sharedGatewaySessionGenerationChanged) {
            disconnectStaleSharedGatewayAuthClients({
              clients: params.clients,
              expectedGeneration: previousSharedGatewaySessionGeneration,
            });
          }
        }
        throw err;
      }
      // Runtime-secret refreshes can legitimately advance the snapshot
      // revision after this commit. Finalize only while this transaction's
      // generation is still current so a genuinely newer generation wins.
      if (publishedSharedGatewaySessionGeneration) {
        finalizeOwnedSharedGatewaySessionGeneration(
          params.sharedGatewaySessionGenerationState,
          publishedSharedGatewaySessionGeneration,
        );
      }
      return applicationStatus;
    }
  };

  return {
    onEffectiveConfigUnchanged,
    onHotReload,
  };
}

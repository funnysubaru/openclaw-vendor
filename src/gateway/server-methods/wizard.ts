// Wizard gateway methods manage interactive setup wizard sessions and route
// start/next/status/cancel RPCs through the wizard runtime.
import { randomUUID } from "node:crypto";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  GatewayErrorDetailCodes,
  validateWizardCancelParams,
  validateWizardNextParams,
  validateWizardStartParams,
  validateWizardStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OnboardOptions } from "../../commands/onboard-types.js";
import { runAsGatewayPassiveWait } from "../../process/gateway-work-admission.js";
import { createNonExitingRuntime, ExitError, type RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import {
  sanitizeWizardStepForClient,
  WizardSession,
  type WizardStep,
} from "../../wizard/session.js";
import { formatForLog } from "../ws-log.js";
import {
  createAdmittedWizardSession,
  respondSetupAdmissionBusy,
  whenAdmittedWizardSessionSettled,
} from "./setup-admission.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

export type SetupWizardRunner = (
  opts: OnboardOptions,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
) => Promise<void>;

export type ChannelSetupWizardRunner = (
  opts: {
    channel?: string;
    onConfigured?: (accounts: Array<{ channel: string; accountId: string }>) => void;
    beforePersistentEffect?: () => Promise<void>;
  },
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
) => Promise<void>;

export const runDefaultSetupWizard: SetupWizardRunner = async (...args) => {
  const { runSetupWizard } = await import("../../wizard/setup.js");
  return runSetupWizard(...args);
};

export const runDefaultChannelSetupWizard: ChannelSetupWizardRunner = async (...args) => {
  const { runChannelsSetupWizard } = await import("../../commands/channels/add-wizard.js");
  return runChannelsSetupWizard(...args);
};

async function runHostedWizard(run: (runtime: RuntimeEnv) => Promise<void>): Promise<void> {
  try {
    await run(createNonExitingRuntime());
  } catch (error) {
    // Hosted wizards share the Gateway process; a successful CLI-style exit
    // must complete only its session, while failures remain session errors.
    if (error instanceof ExitError && error.code === 0) {
      return;
    }
    throw error;
  }
}

function readWizardStatus(session: WizardSession) {
  return {
    status: session.getStatus(),
    error: session.getError(),
  };
}

function sanitizeWizardResultForClient<T extends { step?: WizardStep }>(result: T): T {
  return result.step ? { ...result, step: sanitizeWizardStepForClient(result.step) } : result;
}

/** Resolves a live wizard session or sends the public not-found error. */
function findWizardSessionOrRespond(params: {
  context: GatewayRequestContext;
  respond: RespondFn;
  sessionId: string;
}): WizardSession | null {
  const session = params.context.wizardSessions.get(params.sessionId);
  if (!session) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "wizard not found", {
        details: { code: GatewayErrorDetailCodes.WIZARD_NOT_FOUND },
      }),
    );
    return null;
  }
  return session;
}

/** Gateway handlers for the interactive setup wizard session lifecycle. */
/**
 * 取向导下一步。没有现成步骤时会一直挂着，等后台向导（可能正在落凭据、等热重载生效）出下一步。
 * 这段挂起只是被动等待，用 runAsGatewayPassiveWait 包住，免得热重载 / 重启排空把它算成在途请求、
 * 与向导互等到超时（Yuiclaw ADR-0033 任务 123.3）。
 */
async function nextWizardResult(session: WizardSession) {
  return await runAsGatewayPassiveWait(() => session.next());
}

export const wizardHandlers: GatewayRequestHandlers = {
  "wizard.start": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateWizardStartParams, "wizard.start", respond)) {
      return;
    }
    const sessionId = randomUUID();
    const flow = params.flow ?? "setup";
    const createSession = () =>
      flow === "channels"
        ? new WizardSession((prompter, _signal, wizardSession) =>
            runHostedWizard((runtime) =>
              context.channelWizardRunner(
                {
                  channel: readStringValue(params.channel),
                  onConfigured: (accounts) => wizardSession.setConfiguredAccounts(accounts),
                  // Durable effects (plugin installs, config commit) must finish
                  // even if the client cancels mid-write.
                  beforePersistentEffect: async () => wizardSession.lockCancellation(),
                },
                runtime,
                prompter,
              ),
            ),
          )
        : new WizardSession((prompter) =>
            runHostedWizard((runtime) =>
              context.wizardRunner(
                {
                  mode: params.mode,
                  workspace: readStringValue(params.workspace),
                  installDaemon: params.installDaemon,
                },
                runtime,
                prompter,
              ),
            ),
          );
    const session = await createAdmittedWizardSession(createSession, flow === "setup");
    if (!session) {
      respondSetupAdmissionBusy(respond);
      return;
    }
    context.wizardSessions.set(sessionId, session);
    const result = await nextWizardResult(session);
    if (result.done) {
      // Let the runner release setup admission before the terminal response,
      // so an immediate replacement wizard is not rejected as still busy.
      await whenAdmittedWizardSessionSettled(session);
      context.purgeWizardSession(sessionId);
    }
    respond(true, { sessionId, ...sanitizeWizardResultForClient(result) }, undefined);
  },
  "wizard.next": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateWizardNextParams, "wizard.next", respond)) {
      return;
    }
    const sessionId = params.sessionId;
    const session = findWizardSessionOrRespond({ context, respond, sessionId });
    if (!session) {
      return;
    }
    const answer = params.answer as { stepId?: string; value?: unknown } | undefined;
    if (answer) {
      if (session.getStatus() !== "running") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "wizard not running"));
        return;
      }
      try {
        const validationError = await session.answer(answer.stepId ?? "", answer.value);
        if (validationError) {
          respond(
            true,
            {
              ...sanitizeWizardResultForClient(await nextWizardResult(session)),
              error: validationError,
            },
            undefined,
          );
          return;
        }
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
        return;
      }
    }
    const result = await nextWizardResult(session);
    if (result.done) {
      // Keep terminal response ordering identical to wizard.start.
      await whenAdmittedWizardSessionSettled(session);
      context.purgeWizardSession(sessionId);
    }
    respond(true, sanitizeWizardResultForClient(result), undefined);
  },
  "wizard.cancel": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateWizardCancelParams, "wizard.cancel", respond)) {
      return;
    }
    const sessionId = params.sessionId;
    const session = findWizardSessionOrRespond({ context, respond, sessionId });
    if (!session) {
      return;
    }
    const cancelled = session.cancel();
    const status = readWizardStatus(session);
    if (cancelled) {
      const purge = () => context.purgeWizardSession(sessionId);
      void whenAdmittedWizardSessionSettled(session).then(purge, purge);
    } else if (status.status !== "running") {
      context.purgeWizardSession(sessionId);
    }
    respond(true, status, undefined);
  },
  "wizard.status": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateWizardStatusParams, "wizard.status", respond)) {
      return;
    }
    const sessionId = params.sessionId;
    const session = findWizardSessionOrRespond({ context, respond, sessionId });
    if (!session) {
      return;
    }
    const status = readWizardStatus(session);
    if (status.status !== "running") {
      await whenAdmittedWizardSessionSettled(session);
    }
    context.purgeWizardSession(sessionId);
    respond(true, status, undefined);
  },
};

export type PermissionDecisionState =
  | "approved"
  | "approved_for_session"
  | "approved_permanently"
  | "denied"
  | "denied_with_reason";

export type PermissionPromptDecision = {
  approved: boolean;
  state: PermissionDecisionState;
  denialReason?: string;
  /**
   * True when the decision was made automatically by yolo mode rather than
   * by an interactive user prompt. Used by handlers to emit "auto_approved"
   * rather than "user_approved" in the permissions:decision broadcast.
   */
  autoApproved?: true;
};

export interface PermissionDecisionUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
}

const APPROVE_OPTION = "Yes";
const APPROVE_FOR_SESSION_OPTION = "Yes, for this session";
const APPROVE_PERMANENTLY_OPTION = "Yes, permanently";
const DENY_OPTION = "No";
const DENY_WITH_REASON_OPTION = "No, provide reason";

export function normalizePermissionDenialReason(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function createDeniedPermissionDecision(
  denialReason?: string,
): PermissionPromptDecision {
  const normalizedReason = normalizePermissionDenialReason(denialReason);
  return normalizedReason
    ? {
        approved: false,
        state: "denied_with_reason",
        denialReason: normalizedReason,
      }
    : {
        approved: false,
        state: "denied",
      };
}

export function isPermissionDecisionState(
  value: unknown,
): value is PermissionDecisionState {
  return (
    value === "approved" ||
    value === "approved_for_session" ||
    value === "approved_permanently" ||
    value === "denied" ||
    value === "denied_with_reason"
  );
}

export interface RequestPermissionOptions {
  /** Override the "for this session" option label (e.g. to show the suggested pattern). */
  sessionLabel?: string;
  /** Override the "permanently" option label (e.g. to show the suggested pattern).
   * When absent/undefined, the permanent option is not shown in the dialog. */
  persistentLabel?: string;
}

export async function requestPermissionDecisionFromUi(
  ui: PermissionDecisionUi,
  title: string,
  message: string,
  options?: RequestPermissionOptions,
): Promise<PermissionPromptDecision> {
  const sessionOption = options?.sessionLabel ?? APPROVE_FOR_SESSION_OPTION;
  const persistentOption = options?.persistentLabel;
  const decisionOptions: string[] = [
    APPROVE_OPTION,
    sessionOption,
  ];
  if (persistentOption) {
    decisionOptions.push(persistentOption);
  }
  decisionOptions.push(DENY_OPTION, DENY_WITH_REASON_OPTION);

  const selected = await ui.select(`${title}\n${message}`, decisionOptions);

  if (selected === APPROVE_OPTION) {
    return {
      approved: true,
      state: "approved",
    };
  }

  if (selected === sessionOption) {
    return {
      approved: true,
      state: "approved_for_session",
    };
  }

  if (persistentOption && selected === persistentOption) {
    return {
      approved: true,
      state: "approved_permanently",
    };
  }

  if (selected === DENY_WITH_REASON_OPTION) {
    const denialReason = normalizePermissionDenialReason(
      await ui.input(
        `${title}\nShare why this request was denied (optional).`,
        "Reason shown back to the agent",
      ),
    );

    return createDeniedPermissionDecision(denialReason);
  }

  return createDeniedPermissionDecision();
}

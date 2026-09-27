/** Native Eve/Workflow currently supports only omission/default and zero. */
export function workflowRunRetention(value) {
  if (value === undefined || value === "default") return "default";
  if (value === "0") return 0;
  throw new Error("Workflow retention must be default or 0.");
}

/** Account chat requires retained runtime output for replay and recovery. */
export function requireReplayRetention(env = process.env) {
  const selected = workflowRunRetention(env.EVE_WORKFLOW_RETENTION);
  const expected = workflowRunRetention(env.WORKFLOW_EXPECTED_RETENTION);
  if (env.AI_CHAT_ENABLED === "true" && (selected === 0 || expected === 0)) {
    throw new Error("Account chat requires default Workflow retention for replay and recovery.");
  }
  return selected;
}

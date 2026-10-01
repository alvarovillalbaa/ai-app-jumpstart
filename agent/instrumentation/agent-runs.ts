import { agentRuns,composeSpanExportPolicies,redactSpanInputs,redactSpanOutputs } from "eve/instrumentation/otel";
export default agentRuns({ exportPolicy: composeSpanExportPolicies(redactSpanInputs(),redactSpanOutputs()) });

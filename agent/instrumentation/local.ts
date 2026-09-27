import { localTraces,composeSpanExportPolicies,redactSpanInputs,redactSpanOutputs } from "eve/instrumentation/otel";
export default localTraces({ exportPolicy: composeSpanExportPolicies(redactSpanInputs(),redactSpanOutputs()) });

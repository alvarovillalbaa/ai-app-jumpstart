import { otel } from "eve/instrumentation/otel";
import { metadataOnly } from "../../lib/observability/runtime-provider";
export default otel({ tracePolicy: metadataOnly });

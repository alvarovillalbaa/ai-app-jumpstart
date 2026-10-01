import { defineTool } from "eve/tools";
import { arithmeticInput, calculate } from "../../../../../agent/lib/arithmetic";
export default defineTool({ description: "Arithmetic contract fixture", inputSchema: arithmeticInput, execute: calculate });

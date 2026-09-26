import { defineTool } from "eve/tools";
import { arithmeticInput, calculate } from "#lib/arithmetic.ts";
export default defineTool({
  description: "Perform bounded arithmetic on two numbers. Division by zero returns an explicit error.",
  inputSchema: arithmeticInput,
  execute: calculate,
});

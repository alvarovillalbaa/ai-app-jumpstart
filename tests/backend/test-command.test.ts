import { expect,it } from "vitest";
import { testCommand } from "../../scripts/helpers/test-command.mjs";

it("captures complete JSON larger than 12 KiB without mixing stderr warnings",async () => {
  const output = await testCommand(process.execPath,["-e",'process.stderr.write("warning on stderr\\n"); process.stdout.write(JSON.stringify({routes:"x".repeat(16000)}))']);
  expect(JSON.parse(output)).toEqual({ routes: "x".repeat(16000) });
});
it("refuses oversized stdout instead of returning a truncated successful result",async () => {
  await expect(testCommand(process.execPath,["-e",'process.stdout.write("x".repeat(1048577))'])).rejects.toThrow("refusing incomplete output");
});
it("retains bounded failure diagnostics while redacting fixture secrets",async () => {
  await expect(testCommand(process.execPath,["-e",'process.stdout.write("stdout fixture-secret"); process.stderr.write("stderr fixture-secret"); process.exitCode=1'],{},["fixture-secret"]))
    .rejects.toThrow("stdout [redacted]\nstderr [redacted]");
});

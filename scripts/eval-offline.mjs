import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../tests/fixtures/eve/", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/.bin/eve", import.meta.url));
const child = spawn(cli, ["eval", "--strict", "--junit", ".eve/junit.xml"], { cwd: root, stdio: "inherit", env: { ...process.env, NODE_ENV: "development" } });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));

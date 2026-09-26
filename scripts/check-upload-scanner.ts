import { createUploadScanner } from "../lib/uploads/scanner";

try {
  const scanner = await createUploadScanner();
  if (!scanner) throw new Error("Scanner is not configured.");
  const clean = new TextEncoder().encode("Jumpstart clean upload scanner control.");
  // Assemble the standard harmless EICAR test bytes only in memory.
  const eicar = new TextEncoder().encode(["X5O!P%@AP[4","\\","PZX54(P^)7CC)7}","$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join(""));
  if (eicar.length !== 68 || await scanner.scan(clean) !== "clean" || await scanner.scan(eicar) !== "infected") {
    throw new Error("Scanner verdicts did not match the controls.");
  }
  console.log("Upload scanner passed clean and EICAR controls.");
} catch {
  console.error("Upload scanner preflight failed. Check the private scanner endpoint, authentication, limits and current signatures.");
  process.exitCode = 1;
}

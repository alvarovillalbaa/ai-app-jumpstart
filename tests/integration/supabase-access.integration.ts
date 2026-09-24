import { expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

it("denies table reads and forged inserts to anonymous and authenticated database clients", async () => {
  const url = process.env.SUPABASE_URL!;
  const tokens = [process.env.TEST_SUPABASE_ANON_TOKEN, process.env.TEST_SUPABASE_USER_TOKEN];
  if (tokens.some(token => !token)) throw new Error("Direct-access validation needs explicit disposable anon and authenticated tokens.");
  for (const token of tokens) {
    const client = createClient(url, token!, { auth: { persistSession: false, autoRefreshToken: false } });
    const read = await client.from("app_records").select("*");
    expect(read.error?.code).toBe("42501");
    const write = await client.from("app_records").insert({ id: crypto.randomUUID(), tenant: "victim", subject: "victim", title: "forged", content: "" });
    expect(write.error?.code).toBe("42501");
    for (const [table, row] of [
      ["app_budget_accounts", { tenant: "victim", subject: "victim" }],
      ["app_budget_reservations", { operation_id: crypto.randomUUID(), tenant: "victim", subject: "victim", request_hash: "a".repeat(64), policy_id: "forged", estimate_micros: 1, day: 1, created_at: 86400000, status: "reserved" }],
      ["app_budget_corrections", { correction_id: crypto.randomUUID(),operation_id: crypto.randomUUID(),tenant: "victim",subject: "victim",
        corrected_actual_micros: 0,actor: "forged",reason: "Attempt to alter another account",evidence_ref: "forged",at: Date.now() }],
      ["app_conversations", { id: crypto.randomUUID(), operation_id: crypto.randomUUID(), tenant: "victim", subject: "victim", request_hash: "a".repeat(64), status: "starting" }],
      ["app_internal_nonces", { id: "b".repeat(64), expires_at: Date.now() + 60000 }],
      ["app_conversation_events",{ operation_id: crypto.randomUUID(),event_id: "evt_00000000000000000000000001",payload: "{}" }],
      ["app_artifacts",{ id: crypto.randomUUID(),operation_id: crypto.randomUUID(),session_id: "forged",call_id: "forged",input_hash: "a".repeat(64),title: "forged",content: "forged",created_at: Date.now() }],
    ] as const) {
      expect((await client.from(table).select("*")).error?.code).toBe("42501");
      expect((await client.from(table).insert(row)).error?.code).toBe("42501");
      if (table === "app_artifacts") expect((await client.from(table).update({ content: "forged" }).eq("id",row.id)).error?.code).toBe("42501");
    }
    for (const command of ["reserve", "settle", "snapshot"]) {
      const result = await client.rpc("app_budget_command", { command, input: { tenant: "victim", subject: "victim", now: Date.now() } });
      expect(result.error?.code).toBe("42501");
    }
    expect((await client.from("app_budget_attempts").select("*")).error?.code).toBe("42501");
    expect((await client.rpc("app_append_conversation_event",{ p_tenant: "victim",p_subject: "victim",p_operation: crypto.randomUUID(),p_session: "session",p_event: "evt_00000000000000000000000001",p_payload: "{}" })).error?.code).toBe("42501");
    expect((await client.rpc("app_save_artifact",{ p_tenant: "victim",p_subject: "victim",p_operation: crypto.randomUUID(),p_session: "session",p_call: "forged",p_hash: "a".repeat(64),p_id: crypto.randomUUID(),p_title: "forged",p_content: "forged",p_created: Date.now() })).error?.code).toBe("42501");
    expect((await client.rpc("app_delete_artifact",{ p_tenant: "victim",p_subject: "victim",p_id: crypto.randomUUID(),p_deleted: Date.now() })).error?.code).toBe("42501");
    for (const command of ["claimAttempt","attemptCount"]) expect((await client.rpc("app_budget_attempt_command", { command, input: { tenant: "victim", subject: "victim", operationId: crypto.randomUUID() } })).error?.code).toBe("42501");
    expect((await client.rpc("app_budget_correct_settlement",{ input: { tenant: "victim",subject: "victim",
      operationId: crypto.randomUUID(),correctionId: crypto.randomUUID(),expectedActualMicros: null,
      correctedActualMicros: 0,actor: "forged",reason: "Attempt to alter another account",evidenceRef: "forged" } })).error?.code).toBe("42501");
  }
});

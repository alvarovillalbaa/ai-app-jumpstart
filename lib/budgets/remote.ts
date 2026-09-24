import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ConvexBackend } from "../data/convex-client";
import type { Database } from "../data/supabase.generated";
import { admission, admissionResult, settlement, settlementCorrection, correctionResult, correctionEntry, budgetInspection, lookup, snapshot, attempt, attemptOwner, reservationState, outstandingOptions, outstandingEntry, outstandingPage, pageOfOutstanding, ledgerOptions, ledgerEntry, ledgerPage, pageOfLedger, ownerCorrectionEntry, ownerCorrectionPage, pageOfOwnerCorrections, type BudgetStore } from "./contract";

type Rpc = (operation: string, input: object) => Promise<unknown>;
function adapter(call: Rpc, getReservation: BudgetStore["getReservation"], inspectReservation: BudgetStore["inspectReservation"], listOutstanding: BudgetStore["listOutstanding"],
  listLedger: BudgetStore["listLedger"],listOwnerCorrections: BudgetStore["listOwnerCorrections"],
  correctSettlement: BudgetStore["correctSettlement"], listCorrections: BudgetStore["listCorrections"], close: () => Promise<void>): BudgetStore {
  return {
    reserve: async input => admissionResult.parse(await call("reserve", admission.parse(input))),
    getReservation,
    inspectReservation,
    listOutstanding,
    listLedger,
    listOwnerCorrections,
    settle: async input => z.boolean().parse(await call("settle", settlement.parse(input))),
    correctSettlement,
    listCorrections,
    snapshot: async input => snapshot.parse(await call("snapshot", lookup.parse(input))),
    claimAttempt: async input => z.boolean().parse(await call("claimAttempt", attempt.parse(input))),
    attemptCount: async input => z.number().int().nonnegative().parse(await call("attemptCount", attemptOwner.parse(input))),
    close,
  };
}
export function postgresBudgetStore(connectionString: string) {
  const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  pool.on("error", () => console.error(JSON.stringify({ event: "budget_pool_error" })));
  return adapter(async (operation, input) => (await pool.query(operation === "claimAttempt" || operation === "attemptCount" ? "SELECT public.app_budget_attempt_command($1,$2::jsonb) AS result" : "SELECT public.app_budget_command($1,$2::jsonb) AS result", [operation, JSON.stringify(input)])).rows[0].result,
    async raw => {
      const input = attemptOwner.parse(raw);
      const result = await pool.query('SELECT request_hash AS "requestHash",status FROM public.app_budget_reservations WHERE operation_id=$1 AND tenant=$2 AND subject=$3', [input.operationId,input.tenant,input.subject]);
      return result.rows[0] ? reservationState.parse(result.rows[0]) : null;
    }, async raw => {
      const input = attemptOwner.parse(raw);
      const result = await pool.query(`SELECT status,estimate_micros AS "estimateMicros",actual_micros AS "actualMicros",day,policy_id AS "policyId"
        FROM public.app_budget_reservations WHERE operation_id=$1 AND tenant=$2 AND subject=$3`,[input.operationId,input.tenant,input.subject]);
      const row = result.rows[0];
      return row ? budgetInspection.parse({ ...row,estimateMicros: Number(row.estimateMicros),
        actualMicros: row.actualMicros === null ? null : Number(row.actualMicros),day: Number(row.day) }) : null;
    }, async raw => {
      const input = outstandingOptions.parse(raw),[time,id] = input.cursor?.split(".") ?? [];
      const result = await pool.query(`SELECT tenant,subject,operation_id AS "operationId",created_at AS "createdAt",
        estimate_micros AS "estimateMicros",policy_id AS "policyId" FROM public.app_budget_reservations
        WHERE status='reserved' AND ($1::bigint IS NULL OR created_at>$1 OR (created_at=$1 AND operation_id>$2::uuid))
        ORDER BY created_at ASC,operation_id ASC LIMIT $3`,[time ? Number(time) : null,id ?? null,input.limit+1]);
      return pageOfOutstanding(result.rows.map(row => outstandingEntry.parse({ ...row,createdAt: Number(row.createdAt),estimateMicros: Number(row.estimateMicros) })),input.limit);
    }, async raw => {
      const input = ledgerOptions.parse(raw),[time,id] = input.cursor?.split(".") ?? [];
      const result = await pool.query(`SELECT operation_id AS "operationId",created_at AS "createdAt",day,policy_id AS "policyId",
        estimate_micros AS "estimateMicros",status,actual_micros AS "actualMicros" FROM public.app_budget_reservations
        WHERE tenant=$1 AND subject=$2 AND ($3::bigint IS NULL OR created_at>$3 OR (created_at=$3 AND operation_id>$4::uuid))
        ORDER BY created_at ASC,operation_id ASC LIMIT $5`,[input.tenant,input.subject,time ? Number(time) : null,id ?? null,input.limit+1]);
      return pageOfLedger(result.rows.map(row => ledgerEntry.parse({ ...row,createdAt: Number(row.createdAt),day: Number(row.day),
        estimateMicros: Number(row.estimateMicros),actualMicros: row.actualMicros === null ? null : Number(row.actualMicros) })),input.limit);
    }, async raw => {
      const input = ledgerOptions.parse(raw),[time,id] = input.cursor?.split(".") ?? [];
      const result = await pool.query(`SELECT correction_id AS "correctionId",operation_id AS "operationId",
        previous_actual_micros AS "previousActualMicros",corrected_actual_micros AS "correctedActualMicros",at
        FROM public.app_budget_corrections WHERE tenant=$1 AND subject=$2
        AND ($3::bigint IS NULL OR at>$3 OR (at=$3 AND correction_id>$4::uuid))
        ORDER BY at ASC,correction_id ASC LIMIT $5`,[input.tenant,input.subject,time ? Number(time) : null,id ?? null,input.limit+1]);
      return pageOfOwnerCorrections(result.rows.map(row => ownerCorrectionEntry.parse({ ...row,at: Number(row.at),
        previousActualMicros: row.previousActualMicros === null ? null : Number(row.previousActualMicros),
        correctedActualMicros: Number(row.correctedActualMicros) })),input.limit);
    }, async raw => {
      const input = settlementCorrection.parse(raw);
      return correctionResult.parse((await pool.query("SELECT public.app_budget_correct_settlement($1::jsonb) AS result",[JSON.stringify(input)])).rows[0].result);
    }, async raw => {
      const input = attemptOwner.parse(raw);
      const result = await pool.query(`SELECT correction_id AS "correctionId",operation_id AS "operationId",tenant,subject,
        previous_actual_micros AS "previousActualMicros",corrected_actual_micros AS "correctedActualMicros",actor,reason,
        evidence_ref AS "evidenceRef",at FROM public.app_budget_corrections
        WHERE operation_id=$1 AND tenant=$2 AND subject=$3 ORDER BY at DESC,correction_id DESC LIMIT 100`,
      [input.operationId,input.tenant,input.subject]);
      return result.rows.map(row => correctionEntry.parse({ ...row,at: Number(row.at),
        previousActualMicros: row.previousActualMicros === null ? null : Number(row.previousActualMicros),
        correctedActualMicros: Number(row.correctedActualMicros) }));
    }, () => pool.end());
}
export function supabaseBudgetStore(url: string, secret: string) {
  const client = createClient<Database>(url, secret, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(10000) }) } });
  return adapter(async (operation, input) => {
    const { data, error } = await client.rpc(operation === "claimAttempt" || operation === "attemptCount" ? "app_budget_attempt_command" : "app_budget_command", { command: operation, input: z.json().parse(input) });
    if (error) throw error; return data;
  }, async raw => {
    const input = attemptOwner.parse(raw);
    const { data,error } = await client.from("app_budget_reservations").select("request_hash,status").eq("operation_id",input.operationId).eq("tenant",input.tenant).eq("subject",input.subject).maybeSingle();
    if (error) throw error;
    return data ? reservationState.parse({ requestHash: data.request_hash,status: data.status }) : null;
  }, async raw => {
    const input = attemptOwner.parse(raw);
    const { data,error } = await client.from("app_budget_reservations").select("status,estimate_micros,actual_micros,day,policy_id")
      .eq("operation_id",input.operationId).eq("tenant",input.tenant).eq("subject",input.subject).maybeSingle();
    if (error) throw error;
    return data ? budgetInspection.parse({ status: data.status,estimateMicros: Number(data.estimate_micros),
      actualMicros: data.actual_micros === null ? null : Number(data.actual_micros),day: Number(data.day),policyId: data.policy_id }) : null;
  }, async raw => {
    const input = outstandingOptions.parse(raw),[time,id] = input.cursor?.split(".") ?? [];
    let query = client.from("app_budget_reservations").select("tenant,subject,operation_id,created_at,estimate_micros,policy_id")
      .eq("status","reserved").order("created_at",{ ascending: true }).order("operation_id",{ ascending: true }).limit(input.limit+1);
    if (time) query = query.or(`created_at.gt.${time},and(created_at.eq.${time},operation_id.gt.${id})`);
    const { data,error } = await query;
    if (error) throw error;
    return pageOfOutstanding((data ?? []).map(row => outstandingEntry.parse({ tenant: row.tenant,subject: row.subject,
      operationId: row.operation_id,createdAt: Number(row.created_at),estimateMicros: Number(row.estimate_micros),policyId: row.policy_id })),input.limit);
  }, async raw => {
    const input = ledgerOptions.parse(raw),[time,id] = input.cursor?.split(".") ?? [];
    let query = client.from("app_budget_reservations").select("operation_id,created_at,day,policy_id,estimate_micros,status,actual_micros")
      .eq("tenant",input.tenant).eq("subject",input.subject).order("created_at",{ ascending: true })
      .order("operation_id",{ ascending: true }).limit(input.limit+1);
    if (time) query = query.or(`created_at.gt.${time},and(created_at.eq.${time},operation_id.gt.${id})`);
    const { data,error } = await query;
    if (error) throw error;
    return pageOfLedger((data ?? []).map(row => ledgerEntry.parse({ operationId: row.operation_id,
      createdAt: Number(row.created_at),day: Number(row.day),policyId: row.policy_id,estimateMicros: Number(row.estimate_micros),
      status: row.status,actualMicros: row.actual_micros === null ? null : Number(row.actual_micros) })),input.limit);
  }, async raw => {
    const input = ledgerOptions.parse(raw),[time,id] = input.cursor?.split(".") ?? [];
    let query = client.from("app_budget_corrections")
      .select("correction_id,operation_id,previous_actual_micros,corrected_actual_micros,at")
      .eq("tenant",input.tenant).eq("subject",input.subject).order("at",{ ascending: true })
      .order("correction_id",{ ascending: true }).limit(input.limit+1);
    if (time) query = query.or(`at.gt.${time},and(at.eq.${time},correction_id.gt.${id})`);
    const { data,error } = await query;
    if (error) throw error;
    return pageOfOwnerCorrections((data ?? []).map(row => ownerCorrectionEntry.parse({ correctionId: row.correction_id,
      operationId: row.operation_id,previousActualMicros: row.previous_actual_micros === null ? null : Number(row.previous_actual_micros),
      correctedActualMicros: Number(row.corrected_actual_micros),at: Number(row.at) })),input.limit);
  }, async raw => {
    const input = settlementCorrection.parse(raw);
    const { data,error } = await client.rpc("app_budget_correct_settlement",{ input });
    if (error) throw error;
    return correctionResult.parse(data);
  }, async raw => {
    const input = attemptOwner.parse(raw);
    const { data,error } = await client.from("app_budget_corrections")
      .select("correction_id,operation_id,tenant,subject,previous_actual_micros,corrected_actual_micros,actor,reason,evidence_ref,at")
      .eq("operation_id",input.operationId).eq("tenant",input.tenant).eq("subject",input.subject)
      .order("at",{ ascending: false }).order("correction_id",{ ascending: false }).limit(100);
    if (error) throw error;
    return (data ?? []).map(row => correctionEntry.parse({ correctionId: row.correction_id,operationId: row.operation_id,
      tenant: row.tenant,subject: row.subject,previousActualMicros: row.previous_actual_micros === null ? null : Number(row.previous_actual_micros),
      correctedActualMicros: Number(row.corrected_actual_micros),actor: row.actor,reason: row.reason,evidenceRef: row.evidence_ref,at: Number(row.at) }));
  }, async () => {});
}
export function convexBudgetStore(url: string, secret: string) {
  const backend = new ConvexBackend(url, secret);
  return adapter((operation, input) => backend.call(`budget.${operation}`, input, z.unknown()),
    async input => reservationState.nullable().parse(await backend.call("budget.getReservation", attemptOwner.parse(input), z.unknown())),
    async input => budgetInspection.nullable().parse(await backend.call("budget.inspectReservation", attemptOwner.parse(input), z.unknown())),
    async input => outstandingPage.parse(await backend.call("budget.listOutstanding",outstandingOptions.parse(input),z.unknown())),
    async input => ledgerPage.parse(await backend.call("budget.listLedger",ledgerOptions.parse(input),z.unknown())),
    async input => ownerCorrectionPage.parse(await backend.call("budget.listOwnerCorrections",ledgerOptions.parse(input),z.unknown())),
    async input => correctionResult.parse(await backend.call("budget.correctSettlement",settlementCorrection.parse(input),z.unknown())),
    async input => z.array(correctionEntry).parse(await backend.call("budget.listCorrections",attemptOwner.parse(input),z.unknown())),async () => {});
}

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { accessOwner, reservation, operationId, sessionId, bodyHash, fromAccessRow, type AccessOwner, type Reservation, type SessionAccessStore } from "./contract";
import { conversationTitle, historyOptions, historyPatch, pageOfHistory, summaryFromRow } from "./contract";
import { projectionEntry, projectionOptions, projectionOutcome, projectionSourceIndex, pageOfProjections } from "./projection-contract";
import { artifactInput, artifactCallId, artifactOptions, artifactSaveResult, artifactFromRow, pageOfArtifacts } from "./artifact-contract";
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "../data/supabase.generated";

export function supabaseAccessStore(url: string, secret: string): SessionAccessStore {
  const client = createClient<Database>(url, secret, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) }) } });
  const store: SessionAccessStore = {
    async saveArtifact(owner,operation,session,callId,input) {
      const o = accessOwner.parse(owner),data = artifactInput.parse(input),id = operationId.parse(operation),sid = sessionId.parse(session),call = artifactCallId.parse(callId);
      const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
      const { data: result,error } = await client.rpc("app_save_artifact",{ p_tenant: o.tenant,p_subject: o.subject,p_operation: id,p_session: sid,p_call: call,
        p_hash: hash,p_id: randomUUID(),p_title: data.title,p_content: data.content,p_created: Date.now() });
      if (error) throw error;
      const response = z.object({ status: z.enum(["created","existing","conflict","unavailable"]), artifact: z.unknown().optional() }).parse(result);
      return artifactSaveResult.parse({ status: response.status,...(response.artifact !== undefined ? { artifact: artifactFromRow(response.artifact) } : {}) });
    },
    async listArtifacts(owner,options) {
      const o = accessOwner.parse(owner),q = artifactOptions.parse(options);
      let query = client.from("app_artifacts").select("*,app_conversations!inner(tenant,subject)").eq("app_conversations.tenant",o.tenant).eq("app_conversations.subject",o.subject).is("deleted_at",null);
      if (q.cursor) { const [time,id] = q.cursor.split(".");query = query.or(`created_at.lt.${Number(time)},and(created_at.eq.${Number(time)},id.lt.${id})`); }
      const { data,error } = await query.order("created_at",{ ascending: false }).order("id",{ ascending: false }).limit(q.limit+1);
      if (error) throw error;
      return pageOfArtifacts(data.map(artifactFromRow),q.limit);
    },
    async getArtifact(owner,id) {
      const o = accessOwner.parse(owner);
      const { data,error } = await client.from("app_artifacts").select("*,app_conversations!inner(tenant,subject)").eq("app_conversations.tenant",o.tenant).eq("app_conversations.subject",o.subject).eq("id",operationId.parse(id)).is("deleted_at",null).maybeSingle();
      if (error) throw error;
      return data ? artifactFromRow(data) : null;
    },
    async deleteArtifact(owner,id) {
      const o = accessOwner.parse(owner);
      const { data,error } = await client.rpc("app_delete_artifact",{ p_tenant: o.tenant,p_subject: o.subject,p_id: operationId.parse(id),p_deleted: Date.now() });
      if (error) throw error;
      return z.boolean().parse(data);
    },
    async appendProjection(owner,operation,session,entry,sourceIndex) {
      const o = accessOwner.parse(owner), e = projectionEntry.parse(entry);
      const { data,error } = await client.rpc("app_append_conversation_event",{ p_tenant: o.tenant,p_subject: o.subject,p_operation: operationId.parse(operation),p_session: sessionId.parse(session),p_event: e.eventId,p_payload: JSON.stringify(e),...(sourceIndex === undefined ? {} : { p_source_index: projectionSourceIndex.parse(sourceIndex) }) });
      if (error) throw error;
      return projectionOutcome.parse(data);
    },
    async listProjections(owner,operation,options) {
      const o = accessOwner.parse(owner), id = operationId.parse(operation), q = projectionOptions.parse(options);
      // The relationship filter is an inner join, so owner predicates constrain
      // event rows even though this client uses a privileged server credential.
      const { data,error } = await client.from("app_conversation_events").select("payload,ordinal,source_index,app_conversations!inner(tenant,subject)").eq("operation_id",id).eq("app_conversations.tenant",o.tenant).eq("app_conversations.subject",o.subject).gt("ordinal",q.after ?? 0).order("ordinal",{ ascending: true }).limit(q.limit+1);
      if (error) throw error;
      return pageOfProjections(data.map(row => ({ entry: JSON.parse(row.payload),index: Number(row.ordinal),sourceIndex: row.source_index === null ? null : Number(row.source_index) })),q.limit);
    },
    async reserve(input: Reservation, title = "New conversation") {
      const r = reservation.parse(input);
      const { error } = await client.from("app_conversations").insert({ id: r.id, tenant: r.tenant, subject: r.subject, operation_id: r.operationId, request_hash: r.requestHash, status: "starting", title: conversationTitle.parse(title), created_at: Date.now() });
      if (error?.code === "23505") return false;
      if (error) throw error;
      return true;
    },
    async list(owner, options) {
      const o = accessOwner.parse(owner), q = historyOptions.parse(options);
      let query = client.from("app_conversations").select("*").eq("tenant",o.tenant).eq("subject",o.subject).eq("archived",q.archived ? 1 : 0);
      if (q.cursor) { const [time,id] = q.cursor.split("."); query = query.or(`created_at.lt.${Number(time)},and(created_at.eq.${Number(time)},id.lt.${id})`); }
      const { data,error } = await query.order("created_at",{ ascending: false }).order("id",{ ascending: false }).limit(q.limit+1);
      if (error) throw error;
      return pageOfHistory(data.map(summaryFromRow),q.limit);
    },
    async getDetails(owner, operation) {
      const o = accessOwner.parse(owner);
      const { data,error } = await client.from("app_conversations").select("*").eq("tenant",o.tenant).eq("subject",o.subject).eq("operation_id",operationId.parse(operation)).maybeSingle();
      if (error) throw error;
      return data ? summaryFromRow(data) : null;
    },
    async updateDetails(owner, operation, patch) {
      const o = accessOwner.parse(owner), p = historyPatch.parse(patch);
      const values = { ...(p.title !== undefined ? { title: p.title } : {}), ...(p.archived !== undefined ? { archived: p.archived ? 1 : 0 } : {}), revision: p.revision+1 };
      const { data,error } = await client.from("app_conversations").update(values).eq("tenant",o.tenant).eq("subject",o.subject).eq("operation_id",operationId.parse(operation)).eq("revision",p.revision).select("*").maybeSingle();
      if (error) throw error;
      return data ? summaryFromRow(data) : null;
    },
    async getOperation(owner: AccessOwner, operation: string) {
      const o = accessOwner.parse(owner);
      const { data, error } = await client.from("app_conversations").select("*").eq("tenant", o.tenant).eq("subject", o.subject).eq("operation_id", operationId.parse(operation)).maybeSingle();
      if (error) throw error;
      return fromAccessRow(data);
    },
    async bind(owner: AccessOwner, operation: string, session: string) {
      const o = accessOwner.parse(owner), id = operationId.parse(operation), target = sessionId.parse(session);
      const { data, error } = await client.from("app_conversations").update({ session_id: target, status: "active" }).eq("tenant", o.tenant).eq("subject", o.subject).eq("operation_id", id).eq("status", "starting").is("session_id", null).select("id");
      if (error?.code === "23505") return false;
      if (error) throw error;
      if (data?.length) return true;
      const existing = await store.getOperation(o, id);
      return existing?.status === "active" && existing.sessionId === target;
    },
    async ownsSession(owner: AccessOwner, session: string) {
      const o = accessOwner.parse(owner);
      const { data, error } = await client.from("app_conversations").select("id").eq("tenant", o.tenant).eq("subject", o.subject).eq("session_id", sessionId.parse(session)).eq("status", "active").maybeSingle();
      if (error) throw error;
      return !!data;
    },
    async cancelStarting(owner: AccessOwner, operation: string) {
      const o = accessOwner.parse(owner);
      const { data, error } = await client.from("app_conversations").update({ status: "revoked" }).eq("tenant", o.tenant).eq("subject", o.subject).eq("operation_id", operationId.parse(operation)).eq("status", "starting").is("session_id", null).select("id");
      if (error) throw error;
      return data?.length === 1;
    },
    async revoke(owner: AccessOwner, id: string) {
      const o = accessOwner.parse(owner);
      const { data, error } = await client.from("app_conversations").update({ status: "revoked" }).eq("tenant", o.tenant).eq("subject", o.subject).eq("id", operationId.parse(id)).select("id");
      if (error) throw error;
      return data?.length === 1;
    },
    async claimNonce(id: string, expiresAt: number, now: number) {
      bodyHash.parse(id);
      if (!Number.isSafeInteger(now) || !Number.isSafeInteger(expiresAt) || now <= 0 || expiresAt <= now) throw new Error("Invalid nonce retention window.");
      const expired = await client.from("app_internal_nonces").select("id").lt("expires_at", now).limit(1000);
      if (expired.error) throw expired.error;
      if (expired.data.length) {
        const removal = await client.from("app_internal_nonces").delete().in("id", expired.data.map(row => row.id)).lt("expires_at", now);
        if (removal.error) throw removal.error;
      }
      const { error } = await client.from("app_internal_nonces").insert({ id, expires_at: expiresAt });
      if (error?.code === "23505") return false;
      if (error) throw error;
      return true;
    },
    async close() {},
  };
  return store;
}

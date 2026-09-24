import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { page, type AppRecord, type ListInput, type Owner, type RecordInput, type RecordRepository, type RecordUpdate } from "./contract";
import type { Database } from "./supabase.generated";

type Row = Database["public"]["Tables"]["app_records"]["Row"];
export class SupabaseRepository implements RecordRepository {
  private client: SupabaseClient<Database>;
  constructor(url: string, secret: string) {
    this.client = createClient<Database>(url, secret, { auth: { persistSession: false, autoRefreshToken: false }, global: {
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
    } });
  }
  private scoped(owner: Owner) { return this.client.from("app_records").select("*").eq("tenant", owner.tenant).eq("subject", owner.subject); }
  private row(r: Row): AppRecord {
    return { id: r.id, title: r.title, content: r.content, revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  async list(owner: Owner, input: ListInput) {
    let query = this.scoped(owner).order("id").limit(input.limit + 1);
    if (input.after) query = query.gt("id", input.after);
    const { data, error } = await query;
    if (error) throw error;
    return page((data as Row[]).map(r => this.row(r)), input.limit);
  }
  async get(owner: Owner, id: string) {
    const { data, error } = await this.scoped(owner).eq("id", id).maybeSingle();
    if (error) throw error;
    return data ? this.row(data as Row) : null;
  }
  async create(owner: Owner, input: RecordInput) {
    const { data, error } = await this.client.from("app_records").insert({ id: randomUUID(), tenant: owner.tenant, subject: owner.subject, ...input }).select().single();
    if (error) throw error;
    return this.row(data as Row);
  }
  async update(owner: Owner, id: string, input: RecordUpdate) {
    const { data, error } = await this.client.from("app_records").update({ title: input.title, content: input.content, revision: input.revision + 1, updated_at: new Date().toISOString() })
      .eq("tenant", owner.tenant).eq("subject", owner.subject).eq("id", id).eq("revision", input.revision).select().maybeSingle();
    if (error) throw error;
    return data ? this.row(data as Row) : null;
  }
  async delete(owner: Owner, id: string, revision: number) {
    const { data, error } = await this.client.from("app_records").delete().eq("tenant", owner.tenant).eq("subject", owner.subject).eq("id", id).eq("revision", revision).select("id");
    if (error) throw error;
    return data?.length === 1;
  }
  async health() { const { error } = await this.client.from("app_records").select("id").limit(1); if (error) throw error; }
  async close() {}
}

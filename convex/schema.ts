import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  uploads: defineTable({ id: v.string(),tenant: v.string(),subject: v.string(),name: v.string(),mediaType: v.string(),
    size: v.number(),sha256: v.string(),createdAt: v.number(),state: v.union(v.literal("pending"),v.literal("quarantined"),v.literal("deleting"),v.literal("deleted")) })
    .index("by_external_id",["id"]).index("by_owner_state",["tenant","subject","state"]),
  artifacts: defineTable({ id: v.string(),tenant: v.string(),subject: v.string(),operationId: v.string(),sessionId: v.string(),callId: v.string(),inputHash: v.string(),title: v.string(),content: v.string(),createdAt: v.number(),deletedAt: v.optional(v.number()) })
    .index("by_external_id",["id"]).index("by_operation_call",["operationId","callId"]).index("by_owner_time",["tenant","subject","createdAt","id"]),
  conversationEvents: defineTable({ operationId: v.string(),eventId: v.string(),ordinal: v.number(),payload: v.string() }).index("by_operation_event",["operationId","eventId"]).index("by_operation_ordinal",["operationId","ordinal"]),
  budgetAttempts: defineTable({ operationId: v.string(), attemptId: v.string() }).index("by_operation_attempt", ["operationId","attemptId"]),
  budgetCorrections: defineTable({ correctionId: v.string(),operationId: v.string(),tenant: v.string(),subject: v.string(),
    previousActualMicros: v.union(v.number(),v.null()),correctedActualMicros: v.number(),actor: v.string(),reason: v.string(),
    evidenceRef: v.string(),at: v.number() }).index("by_correction",["correctionId"]).index("by_operation_time",["operationId","at","correctionId"]),
  budgetAccounts: defineTable({ tenant: v.string(), subject: v.string(), active: v.number() }).index("by_owner", ["tenant", "subject"]),
  budgetDays: defineTable({ tenant: v.string(), subject: v.string(), day: v.number(), reservedMicros: v.number(), chargedMicros: v.number(), unknownCosts: v.number() }).index("by_owner_day", ["tenant", "subject", "day"]),
  budgetReservations: defineTable({ operationId: v.string(), tenant: v.string(), subject: v.string(), requestHash: v.string(), policyId: v.string(), estimateMicros: v.number(), day: v.number(), createdAt: v.number(), status: v.union(v.literal("reserved"), v.literal("settled")), actualMicros: v.union(v.number(), v.null()) }).index("by_operation", ["operationId"]).index("by_owner_time", ["tenant", "subject", "createdAt"]).index("by_owner_ledger",["tenant","subject","createdAt","operationId"]).index("by_status_time",["status","createdAt","operationId"]),
  conversations: defineTable({
    id: v.string(), tenant: v.string(), subject: v.string(), operationId: v.string(), requestHash: v.string(),
    sessionId: v.union(v.string(), v.null()), status: v.union(v.literal("starting"), v.literal("active"), v.literal("revoked")),
    projectionSequence: v.optional(v.number()),title: v.optional(v.string()), createdAt: v.optional(v.number()), archived: v.optional(v.boolean()), revision: v.optional(v.number()),
  }).index("by_external_id", ["id"]).index("by_operation", ["operationId"]).index("by_session", ["sessionId"])
    .index("by_history", ["tenant","subject","archived","createdAt","id"]).index("by_archived", ["archived"]),
  internalNonces: defineTable({ id: v.string(), expiresAt: v.number() }).index("by_external_id", ["id"]).index("by_expiry", ["expiresAt"]),
  records: defineTable({
    id: v.string(), tenant: v.string(), subject: v.string(),
    title: v.string(), content: v.string(), revision: v.number(),
    createdAt: v.string(), updatedAt: v.string(),
  }).index("by_owner_id", ["tenant", "subject", "id"]),
});

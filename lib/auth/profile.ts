import type { User } from "@supabase/supabase-js";
import { z } from "zod";

/** An explicit Auth data export boundary; never serialize the whole provider user. */
export const accountProfile = z.object({
  id: z.uuid(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().nullable(),
  lastSignInAt: z.string().nullable(),
  emailConfirmedAt: z.string().nullable(),
  phoneConfirmedAt: z.string().nullable(),
  providers: z.array(z.string()).max(20),
  userMetadata: z.record(z.string(), z.json()),
}).strict();

export type AccountProfile = z.infer<typeof accountProfile>;

export function profileSnapshot(user: User): AccountProfile {
  const names = user.app_metadata?.providers ?? (user.app_metadata?.provider ? [user.app_metadata.provider] : []);
  return accountProfile.parse({
    id: user.id,
    email: user.email ?? null,
    phone: user.phone ?? null,
    createdAt: user.created_at,
    updatedAt: user.updated_at ?? null,
    lastSignInAt: user.last_sign_in_at ?? null,
    emailConfirmedAt: user.email_confirmed_at ?? null,
    phoneConfirmedAt: user.phone_confirmed_at ?? null,
    providers: names,
    userMetadata: user.user_metadata ?? {},
  });
}

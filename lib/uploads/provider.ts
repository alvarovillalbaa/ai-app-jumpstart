const providers = new Set(["local","supabase","aws-s3"]);

export function uploadStorageEnabled(provider: string | undefined) {
  return provider !== undefined && providers.has(provider);
}

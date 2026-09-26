/** One host policy for server-side download admission and browser affordance. */
export function uploadDownloadConfigured(env: Record<string,string | undefined>,policy = env.UPLOAD_DOWNLOAD_POLICY) {
  return policy === "scan-on-read" &&
    (!(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME) || env.UPLOAD_SCANNER_PROVIDER === "remote");
}

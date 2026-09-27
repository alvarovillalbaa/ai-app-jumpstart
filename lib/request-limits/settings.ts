import { AppError } from "../http/errors";

/** Missing/zero keeps existing installations off; .env.example enables it. */
export function requestsPerMinute(env: Record<string,string | undefined> = process.env): number {
  const value = env.APP_REQUESTS_PER_MINUTE;
  if (value === undefined || value === "0") return 0;
  if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value)>10000) {
    throw new AppError(503,"configuration_error","Set APP_REQUESTS_PER_MINUTE to 0 or an integer from 1 to 10000.");
  }
  return Number(value);
}

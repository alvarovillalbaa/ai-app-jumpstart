export class AppError extends Error {
  constructor(public status: number, public code: string, message: string,public retryAfterSeconds?: number) { super(message); }
}

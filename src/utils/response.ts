export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  errors?: Record<string, string[]>;
}

export function ok<T>(data: T, message?: string): ApiResponse<T> {
  return { success: true, data, ...(message ? { message } : {}) };
}

export function fail(message: string, errors?: Record<string, string[]>): ApiResponse<never> {
  return { success: false, message, ...(errors ? { errors } : {}) };
}

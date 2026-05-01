export const JWT_EXPIRY_SECONDS = 1200; // 20 minutes (Apple's limit)
// Cache 1 minute shorter than expiry so we never present a stale token
export const JWT_CACHE_DURATION_MS = JWT_EXPIRY_SECONDS * 1000 - 60_000;
export const RATE_LIMIT_PER_HOUR = 3600;
export const RATE_LIMIT_THRESHOLD = 3500; // 100-request safety buffer
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour in ms
export const AXIOS_TIMEOUT_MS = 30_000;
export const SANDBOX_TIMEOUT_MS = 15_000;
export const MAX_OUTPUT_CHARS = 40_000;
export const MAX_CODE_LENGTH = 10_000;
export const REPORT_ENDPOINTS = new Set([
    '/v1/salesReports',
    '/v1/financeReports',
]);
//# sourceMappingURL=constants.js.map
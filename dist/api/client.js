import axios from 'axios';
import { AXIOS_TIMEOUT_MS, RATE_LIMIT_PER_HOUR, RATE_LIMIT_THRESHOLD, RATE_LIMIT_WINDOW_MS, REPORT_ENDPOINTS, } from '../constants.js';
export class AppStoreClient {
    baseURL = 'https://api.appstoreconnect.apple.com';
    auth;
    axiosInstance;
    requestCount = 0;
    requestResetTime;
    constructor(auth) {
        this.auth = auth;
        this.requestResetTime = new Date(Date.now() + RATE_LIMIT_WINDOW_MS);
        this.axiosInstance = axios.create({
            baseURL: this.baseURL,
            timeout: AXIOS_TIMEOUT_MS,
            headers: {
                'Content-Type': 'application/json'
            }
        });
        this.axiosInstance.interceptors.request.use(async (config) => {
            const token = await this.auth.getToken();
            config.headers.Authorization = `Bearer ${token}`;
            return config;
        }, (error) => Promise.reject(error));
        this.axiosInstance.interceptors.response.use((response) => response, (error) => this.handleError(error));
    }
    /**
     * Make a GET request to the App Store Connect API
     */
    async request(endpoint, params, options) {
        await this.checkRateLimit();
        try {
            const isReportEndpoint = REPORT_ENDPOINTS.has(endpoint);
            const method = (options?.method || 'GET').toUpperCase();
            const config = {
                method,
                url: endpoint,
                params,
                data: options?.data,
                ...options,
            };
            if (isReportEndpoint && method === 'GET') {
                config.responseType = 'arraybuffer';
            }
            const response = await this.axiosInstance.request(config);
            this.requestCount++;
            // For report endpoints, decompress gzipped data
            if (isReportEndpoint && Buffer.isBuffer(response.data)) {
                const { gunzipSync } = await import('zlib');
                const buf = response.data;
                if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b && buf[2] === 0x08) {
                    try {
                        return gunzipSync(buf).toString('utf-8');
                    }
                    catch (decompressError) {
                        process.stderr.write(`[warn] gzip decompression failed, returning raw: ${decompressError instanceof Error ? decompressError.message : String(decompressError)}\n`);
                    }
                }
                return buf.toString('utf-8');
            }
            return response.data;
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Handle paginated endpoints with automatic page fetching
     */
    async *paginate(endpoint, params) {
        let nextUrl = endpoint;
        let currentParams = params;
        while (nextUrl) {
            const response = await this.request(nextUrl, currentParams);
            for (const item of response.data) {
                yield item;
            }
            if (response.links?.next) {
                nextUrl = response.links.next.replace(this.baseURL, '');
                currentParams = undefined;
            }
            else {
                nextUrl = null;
            }
        }
    }
    /**
     * Get all items from a paginated endpoint (use with caution for large datasets)
     */
    async getAll(endpoint, params) {
        const items = [];
        for await (const item of this.paginate(endpoint, params)) {
            items.push(item);
        }
        return items;
    }
    /**
     * Check and enforce rate limiting
     */
    async checkRateLimit() {
        if (new Date() > this.requestResetTime) {
            this.requestCount = 0;
            this.requestResetTime = new Date(Date.now() + RATE_LIMIT_WINDOW_MS);
        }
        if (this.requestCount >= RATE_LIMIT_THRESHOLD) {
            const waitTime = this.requestResetTime.getTime() - Date.now();
            if (waitTime > 0) {
                await this.sleep(waitTime);
                this.requestCount = 0;
                this.requestResetTime = new Date(Date.now() + RATE_LIMIT_WINDOW_MS);
            }
        }
    }
    /**
     * Handle API errors with proper formatting
     */
    async handleError(error) {
        if (error.response) {
            const status = error.response.status;
            let data = {};
            const rawData = error.response.data;
            if (rawData instanceof ArrayBuffer || Buffer.isBuffer(rawData)) {
                try {
                    data = JSON.parse(Buffer.from(rawData).toString('utf-8'));
                }
                catch (parseError) {
                    process.stderr.write(`[warn] failed to parse error response body: ${parseError instanceof Error ? parseError.message : String(parseError)}\n`);
                }
            }
            else if (rawData && typeof rawData === 'object') {
                data = rawData;
            }
            else if (typeof rawData === 'string' && rawData.length > 0) {
                // Apple proxies and CDNs can return plain-text or HTML error bodies
                try {
                    data = JSON.parse(rawData);
                }
                catch {
                    process.stderr.write(`[warn] non-JSON error body (${status}): ${rawData.slice(0, 200)}\n`);
                }
            }
            const asAppStoreError = data;
            if (asAppStoreError.errors && Array.isArray(asAppStoreError.errors)) {
                const firstError = asAppStoreError.errors[0];
                const message = firstError.detail || firstError.title || 'Unknown error';
                switch (status) {
                    case 401:
                        throw new Error(`Authentication failed: ${message}. Check your credentials.`);
                    case 403:
                        throw new Error(`Permission denied: ${message}. Check your API key permissions.`);
                    case 404:
                        process.stderr.write(`[debug] 404 - URL: ${error.request?.path || error.config?.url}\n`);
                        process.stderr.write(`[debug] 404 - Params: ${JSON.stringify(error.config?.params)}\n`);
                        throw new Error(`Resource not found: ${message}`);
                    case 429: {
                        const retryAfter = error.response.headers['retry-after'];
                        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 60000;
                        await this.sleep(waitTime);
                        throw new Error('Rate limited - please retry');
                    }
                    default:
                        throw new Error(`API Error (${status}): ${message}`);
                }
            }
            else {
                throw new Error(`API Error (${status}): ${error.message}`);
            }
        }
        else if (error.request) {
            throw new Error(`Network error: No response from App Store Connect API`);
        }
        else {
            throw new Error(`Request error: ${error.message}`);
        }
    }
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    async testConnection() {
        try {
            await this.request('/v1/apps', { limit: 1 });
            return true;
        }
        catch {
            return false;
        }
    }
    getStats() {
        const resetIn = Math.max(0, this.requestResetTime.getTime() - Date.now());
        return {
            requestCount: this.requestCount,
            requestLimit: RATE_LIMIT_PER_HOUR,
            resetInSeconds: Math.ceil(resetIn / 1000),
            resetAt: this.requestResetTime
        };
    }
}
//# sourceMappingURL=client.js.map
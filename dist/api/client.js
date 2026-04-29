import axios from 'axios';
export class AppStoreClient {
    baseURL = 'https://api.appstoreconnect.apple.com';
    auth;
    axiosInstance;
    requestCount = 0;
    requestResetTime;
    constructor(auth) {
        this.auth = auth;
        this.requestResetTime = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now
        // Create axios instance with defaults
        this.axiosInstance = axios.create({
            baseURL: this.baseURL,
            timeout: 30000, // 30 second timeout
            headers: {
                'Content-Type': 'application/json'
            }
        });
        // Add request interceptor for auth
        this.axiosInstance.interceptors.request.use(async (config) => {
            const token = await this.auth.getToken();
            config.headers.Authorization = `Bearer ${token}`;
            return config;
        }, (error) => Promise.reject(error));
        // Add response interceptor for error handling
        this.axiosInstance.interceptors.response.use((response) => response, (error) => this.handleError(error));
        // App Store API Client initialized
    }
    /**
     * Make a GET request to the App Store Connect API
     */
    async request(endpoint, params, options) {
        // Check rate limit
        await this.checkRateLimit();
        try {
            // For reports endpoints, we need to handle binary/gzipped responses
            const isReportEndpoint = endpoint === '/v1/salesReports' || endpoint === '/v1/financeReports';
            const method = (options?.method || 'GET').toUpperCase();
            const config = {
                method,
                url: endpoint,
                params,
                data: options?.data,
                ...options,
            };
            // Set response type to arraybuffer for report endpoints to handle gzipped data
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
                        const decompressed = gunzipSync(buf).toString('utf-8');
                        return decompressed;
                    }
                    catch {
                        return buf.toString('utf-8');
                    }
                }
                return buf.toString('utf-8');
            }
            return response.data;
        }
        catch (error) {
            // Error is already handled by interceptor
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
            // Yield each item
            for (const item of response.data) {
                yield item;
            }
            // Check for next page
            if (response.links?.next) {
                // Extract path from full URL
                nextUrl = response.links.next.replace(this.baseURL, '');
                currentParams = undefined; // Params are included in next URL
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
     * Check and enforce rate limiting (3600 requests per hour)
     */
    async checkRateLimit() {
        // Reset counter if hour has passed
        if (new Date() > this.requestResetTime) {
            this.requestCount = 0;
            this.requestResetTime = new Date(Date.now() + 60 * 60 * 1000);
        }
        // Check if we're approaching the limit
        if (this.requestCount >= 3500) {
            // Leave 100 request buffer
            const waitTime = this.requestResetTime.getTime() - Date.now();
            if (waitTime > 0) {
                await this.sleep(waitTime);
                this.requestCount = 0;
                this.requestResetTime = new Date(Date.now() + 60 * 60 * 1000);
            }
        }
    }
    /**
     * Handle API errors with proper formatting
     */
    async handleError(error) {
        if (error.response) {
            const status = error.response.status;
            let data = error.response.data;
            // Decode arraybuffer error responses (report endpoints return ArrayBuffer)
            if (data instanceof ArrayBuffer || Buffer.isBuffer(data)) {
                try {
                    data = JSON.parse(Buffer.from(data).toString('utf-8'));
                }
                catch {
                    data = {};
                }
            }
            // Check if it's an App Store error response
            if (data?.errors && Array.isArray(data.errors)) {
                const firstError = data.errors[0];
                const message = firstError.detail || firstError.title || 'Unknown error';
                // Special handling for common errors
                switch (status) {
                    case 401:
                        throw new Error(`Authentication failed: ${message}. Check your credentials.`);
                    case 403:
                        throw new Error(`Permission denied: ${message}. Check your API key permissions.`);
                    case 404:
                        // Log more details for debugging  
                        process.stderr.write(`404 Debug - URL: ${error.request?.path || error.config?.url}\n`);
                        process.stderr.write(`404 Debug - Params: ${JSON.stringify(error.config?.params)}\n`);
                        throw new Error(`Resource not found: ${message}`);
                    case 429:
                        // Rate limited - wait and retry
                        const retryAfter = error.response.headers['retry-after'];
                        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 60000;
                        await this.sleep(waitTime);
                        throw new Error('Rate limited - please retry');
                    default:
                        throw new Error(`API Error (${status}): ${message}`);
                }
            }
            else {
                // Generic error response
                throw new Error(`API Error (${status}): ${error.message}`);
            }
        }
        else if (error.request) {
            // Request made but no response
            throw new Error(`Network error: No response from App Store Connect API`);
        }
        else {
            // Something else happened
            throw new Error(`Request error: ${error.message}`);
        }
    }
    /**
     * Helper function to sleep for specified milliseconds
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    /**
     * Test the connection to App Store Connect
     */
    async testConnection() {
        try {
            // Try to fetch apps (simplest endpoint)
            await this.request('/v1/apps', { limit: 1 });
            return true;
        }
        catch (error) {
            return false;
        }
    }
    /**
     * Get request statistics
     */
    getStats() {
        const resetIn = Math.max(0, this.requestResetTime.getTime() - Date.now());
        return {
            requestCount: this.requestCount,
            requestLimit: 3600,
            resetInSeconds: Math.ceil(resetIn / 1000),
            resetAt: this.requestResetTime
        };
    }
}
//# sourceMappingURL=client.js.map
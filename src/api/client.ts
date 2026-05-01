import axios, { AxiosInstance, AxiosError, AxiosRequestConfig } from 'axios';
import { JWTManager } from '../auth/jwt-manager.js';
import { PagedResponse, AppStoreError } from '../types/api.js';
import {
  AXIOS_TIMEOUT_MS,
  RATE_LIMIT_PER_HOUR,
  RATE_LIMIT_THRESHOLD,
  RATE_LIMIT_WINDOW_MS,
  REPORT_ENDPOINTS,
} from '../constants.js';

type QueryParams = Record<string, string | number | boolean | undefined>;

export class AppStoreClient {
  private baseURL = 'https://api.appstoreconnect.apple.com';
  private auth: JWTManager;
  private axiosInstance: AxiosInstance;
  private requestCount = 0;
  private requestResetTime: Date;

  constructor(auth: JWTManager) {
    this.auth = auth;
    this.requestResetTime = new Date(Date.now() + RATE_LIMIT_WINDOW_MS);

    this.axiosInstance = axios.create({
      baseURL: this.baseURL,
      timeout: AXIOS_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    this.axiosInstance.interceptors.request.use(
      async (config) => {
        const token = await this.auth.getToken();
        config.headers.Authorization = `Bearer ${token}`;
        return config;
      },
      (error) => Promise.reject(error)
    );

    this.axiosInstance.interceptors.response.use(
      (response) => response,
      (error) => this.handleError(error)
    );
  }

  /**
   * Make a GET request to the App Store Connect API
   */
  async request<T = unknown>(endpoint: string, params?: QueryParams, options?: AxiosRequestConfig): Promise<T> {
    await this.checkRateLimit();

    try {
      const isReportEndpoint = REPORT_ENDPOINTS.has(endpoint);
      const method = (options?.method || 'GET').toUpperCase();
      const config: AxiosRequestConfig = {
        method,
        url: endpoint,
        params,
        data: options?.data,
        ...options,
      };

      if (isReportEndpoint && method === 'GET') {
        config.responseType = 'arraybuffer';
      }

      const response = await this.axiosInstance.request<T>(config);
      this.requestCount++;

      // For report endpoints, decompress gzipped data
      if (isReportEndpoint && Buffer.isBuffer(response.data)) {
        const { gunzipSync } = await import('zlib');
        const buf = response.data as unknown as Buffer;
        if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b && buf[2] === 0x08) {
          try {
            return gunzipSync(buf).toString('utf-8') as unknown as T;
          } catch (decompressError: unknown) {
            process.stderr.write(`[warn] gzip decompression failed, returning raw: ${decompressError instanceof Error ? decompressError.message : String(decompressError)}\n`);
          }
        }
        return buf.toString('utf-8') as unknown as T;
      }

      return response.data;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Handle paginated endpoints with automatic page fetching
   */
  async *paginate<T>(endpoint: string, params?: QueryParams): AsyncGenerator<T, void, unknown> {
    let nextUrl: string | null = endpoint;
    let currentParams: QueryParams | undefined = params;

    while (nextUrl) {
      const response: PagedResponse<T> = await this.request<PagedResponse<T>>(nextUrl, currentParams);

      for (const item of response.data) {
        yield item;
      }

      if (response.links?.next) {
        nextUrl = response.links.next.replace(this.baseURL, '');
        currentParams = undefined;
      } else {
        nextUrl = null;
      }
    }
  }

  /**
   * Get all items from a paginated endpoint (use with caution for large datasets)
   */
  async getAll<T>(endpoint: string, params?: QueryParams): Promise<T[]> {
    const items: T[] = [];

    for await (const item of this.paginate<T>(endpoint, params)) {
      items.push(item);
    }

    return items;
  }

  /**
   * Check and enforce rate limiting
   */
  private async checkRateLimit(): Promise<void> {
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
  private async handleError(error: AxiosError): Promise<never> {
    if (error.response) {
      const status = error.response.status;
      let data: AppStoreError | Record<string, unknown> = {};

      const rawData = error.response.data;
      if (rawData instanceof ArrayBuffer || Buffer.isBuffer(rawData)) {
        try {
          data = JSON.parse(Buffer.from(rawData as ArrayBuffer).toString('utf-8')) as AppStoreError;
        } catch (parseError: unknown) {
          process.stderr.write(`[warn] failed to parse error response body: ${parseError instanceof Error ? parseError.message : String(parseError)}\n`);
        }
      } else if (rawData && typeof rawData === 'object') {
        data = rawData as AppStoreError;
      }

      const asAppStoreError = data as AppStoreError;
      if (asAppStoreError.errors && Array.isArray(asAppStoreError.errors)) {
        const firstError = asAppStoreError.errors[0];
        const message = firstError.detail || firstError.title || 'Unknown error';

        switch (status) {
          case 401:
            throw new Error(`Authentication failed: ${message}. Check your credentials.`);
          case 403:
            throw new Error(`Permission denied: ${message}. Check your API key permissions.`);
          case 404:
            if (process.env.DEBUG) {
              process.stderr.write(`[debug] 404 - URL: ${error.request?.path || error.config?.url}\n`);
              process.stderr.write(`[debug] 404 - Params: ${JSON.stringify(error.config?.params)}\n`);
            }
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
      } else {
        throw new Error(`API Error (${status}): ${error.message}`);
      }
    } else if (error.request) {
      throw new Error(`Network error: No response from App Store Connect API`);
    } else {
      throw new Error(`Request error: ${error.message}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.request('/v1/apps', { limit: 1 });
      return true;
    } catch {
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

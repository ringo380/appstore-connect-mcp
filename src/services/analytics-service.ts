import { AppStoreClient } from '../api/client.js';

export interface AnalyticsRequest {
  appId: string;
  metricType: 'USERS' | 'SESSIONS' | 'CRASHES' | 'RETENTION' | 'ENGAGEMENT';
  startDate?: string;
  endDate?: string;
  granularity?: 'DAILY' | 'WEEKLY' | 'MONTHLY';
}

export class AnalyticsService {
  constructor(private client: AppStoreClient) {}

  async getAppAnalytics(request: AnalyticsRequest): Promise<any> {
    if (!request.appId) throw new Error('App ID is required for analytics');

    // Step 1: Create an analytics report request
    const requestBody = {
      data: {
        type: 'analyticsReportRequests',
        attributes: { accessType: 'ONE_TIME_SNAPSHOT' },
        relationships: {
          app: { data: { type: 'apps', id: request.appId } }
        }
      }
    };

    let requestId: string;
    try {
      const createResp = await this.client.post('/analyticsReportRequests', requestBody);
      requestId = createResp?.data?.id;
      if (!requestId) throw new Error('No request ID in response');
    } catch (error: any) {
      throw new Error(`Failed to create analytics report request: ${error.message}`);
    }

    // Step 2: Poll for reports to become available (up to 30s)
    const reports = await this.pollForReports(requestId, 30_000);

    if (!reports || reports.length === 0) {
      return {
        appId: request.appId,
        metricType: request.metricType,
        status: 'PENDING',
        requestId,
        message: 'Analytics report request created. Reports are processed asynchronously and may take several minutes. Check back later or use get_api_stats to monitor.',
        hint: 'Apple Analytics reports are generated on a delay. Reports for a specific app may not be available if analytics access has not been granted in App Store Connect.'
      };
    }

    // Step 3: Find a matching report
    // Apple report names (e.g. "App Store Engagement") don't match our metricType enum directly;
    // use a keyword map, falling back to the first report if nothing matches.
    const metricKeywords: Record<string, string[]> = {
      USERS: ['user', 'active', 'engagement'],
      SESSIONS: ['session', 'engagement'],
      CRASHES: ['crash', 'diagnostic'],
      RETENTION: ['retention', 'cohort'],
      ENGAGEMENT: ['engagement', 'user', 'session']
    };
    const keywords = metricKeywords[request.metricType] || [request.metricType.toLowerCase()];
    const targetReport = reports.find((r: any) =>
      keywords.some(kw => r.attributes?.name?.toLowerCase().includes(kw))
    ) || reports[0];

    const reportId = targetReport?.id;
    if (!reportId) {
      return {
        appId: request.appId,
        metricType: request.metricType,
        status: 'NO_MATCHING_REPORT',
        availableReports: reports.map((r: any) => r.attributes?.name),
        message: `No report matching metric type ${request.metricType} found.`
      };
    }

    // Step 4: Get report instances
    let instances: any[];
    try {
      const instancesResp = await this.client.request(`/analyticsReports/${reportId}/instances`);
      instances = instancesResp?.data || [];
    } catch (error: any) {
      throw new Error(`Failed to fetch report instances: ${error.message}`);
    }

    if (instances.length === 0) {
      return {
        appId: request.appId,
        metricType: request.metricType,
        status: 'NO_INSTANCES',
        reportId,
        message: 'Report exists but has no data instances yet.'
      };
    }

    // Return the most recent instance metadata
    const latestInstance = instances[0];
    return {
      appId: request.appId,
      metricType: request.metricType,
      status: 'AVAILABLE',
      reportId,
      instanceId: latestInstance.id,
      processingDate: latestInstance.attributes?.processingDate,
      granularity: latestInstance.attributes?.granularity,
      size: latestInstance.attributes?.size,
      message: 'Report instance available. Use the instanceId to download the full dataset via the App Store Connect API.'
    };
  }

  private async pollForReports(requestId: string, timeoutMs: number): Promise<any[]> {
    const pollInterval = 3_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      // Let real errors (401, 403, network) propagate — only an empty list means "not ready yet"
      const resp = await this.client.request(`/analyticsReportRequests/${requestId}/reports`);
      const reports = resp?.data || [];
      if (reports.length > 0) return reports;
      await new Promise(r => setTimeout(r, pollInterval));
    }
    return [];
  }
}

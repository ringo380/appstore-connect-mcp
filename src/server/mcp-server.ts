import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { JWTManager } from '../auth/jwt-manager.js';
import { AppStoreClient } from '../api/client.js';
import { AppService } from '../services/app-service.js';
import { FinanceService } from '../services/finance-service.js';
import { FinanceReportService } from '../services/finance-report-service.js';
import { AnalyticsService } from '../services/analytics-service.js';
import { BetaService } from '../services/beta-service.js';
import { ReviewService } from '../services/review-service.js';
import { SubscriptionService } from '../services/subscription-service.js';
import { ServerConfig } from '../types/config.js';

export class AppStoreMCPServer {
  private server: McpServer;
  private auth: JWTManager;
  private client: AppStoreClient;
  private appService: AppService;
  private financeService: FinanceService;
  private financeReportService: FinanceReportService;
  private analyticsService: AnalyticsService;
  private betaService: BetaService;
  private reviewService: ReviewService;
  private subscriptionService: SubscriptionService;

  constructor(config: ServerConfig) {
    this.server = new McpServer({
      name: 'appstore-connect-mcp',
      version: '1.2.0'
    });

    this.auth = new JWTManager(config.auth);
    this.client = new AppStoreClient(this.auth);
    this.appService = new AppService(this.client);
    this.financeService = new FinanceService(this.client, config.vendorNumber);
    this.financeReportService = new FinanceReportService(this.client, config.vendorNumber || '');
    this.analyticsService = new AnalyticsService(this.client);
    this.betaService = new BetaService(this.client);
    this.reviewService = new ReviewService(this.client);
    this.subscriptionService = new SubscriptionService(this.client, config.vendorNumber);

    this.registerTools();
  }

  private ok(data: any) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  }

  private registerTools() {
    // App tools
    this.server.registerTool('list_apps', {
      description: 'Get list of all apps in your App Store Connect account',
      inputSchema: {}
    }, async () => this.ok(await this.appService.getAllAppsSummary()));

    this.server.registerTool('get_app', {
      description: 'Get detailed information about a specific app',
      inputSchema: {
        appId: z.string().optional().describe('The App Store Connect app ID'),
        bundleId: z.string().optional().describe('Alternative: find app by bundle ID')
      }
    }, async ({ appId, bundleId }) => {
      if (bundleId) return this.ok(await this.appService.getAppByBundleId(bundleId));
      if (appId) return this.ok(await this.appService.getAppSummary(appId));
      throw new Error('Either appId or bundleId is required');
    });

    // Financial tools
    this.server.registerTool('get_sales_report', {
      description: 'Get daily sales report from App Store Connect (new purchases only, does not include subscription renewals)',
      inputSchema: {
        date: z.string().optional().describe('Date in YYYY-MM-DD format (defaults to yesterday)'),
        reportType: z.enum(['SALES', 'SUBSCRIPTION']).optional().describe('Type of report')
      }
    }, async ({ date, reportType }) => this.ok(await this.financeService.getSalesReport({ date, reportType })));

    this.server.registerTool('get_revenue_metrics', {
      description: 'Get revenue metrics from the latest available financial report. Financial reports include all revenue (new purchases + renewals) but are delayed ~1 month.',
      inputSchema: {
        appId: z.string().optional().describe('Optional: specific app ID to filter')
      }
    }, async ({ appId }) => {
      try {
        const latest = await this.financeReportService.getLatestAvailable();
        const byRegion: Record<string, number> = {};
        latest.byRegion.forEach((v, k) => { byRegion[k] = v; });
        return this.ok({
          MRR: latest.totalRevenue,
          ARR: latest.totalRevenue * 12,
          currency: 'USD',
          lastUpdated: latest.metadata.month,
          byRegion,
          notes: 'Complete revenue from FINANCIAL reports (includes all renewals). Reports delayed ~1 month.'
        });
      } catch {
        return this.ok(await this.financeService.getRevenueMetrics(appId));
      }
    });

    this.server.registerTool('get_subscription_metrics', {
      description: 'Get subscription-specific metrics from sales reports',
      inputSchema: {}
    }, async () => this.ok(await this.financeService.getSubscriptionMetrics()));

    this.server.registerTool('get_monthly_revenue', {
      description: 'Get aggregated monthly revenue. Uses Financial reports (complete, includes renewals) when available, falls back to summing daily Sales reports.',
      inputSchema: {
        year: z.number().int().describe('Year (e.g., 2025)'),
        month: z.number().int().min(1).max(12).describe('Month (1-12)')
      }
    }, async ({ year, month }) => {
      try {
        const summary = await this.financeReportService.getMonthlySummary(year, month);
        const byProduct: Record<string, number> = {};
        summary.byProduct.forEach((v, k) => { byProduct[k] = v; });
        const byRegion: Record<string, number> = {};
        summary.byRegion.forEach((v, k) => { byRegion[k] = v; });
        return this.ok({
          totalRevenue: summary.totalRevenue,
          byProduct,
          byRegion,
          salesVsReturns: summary.salesVsReturns,
          metadata: summary.metadata,
          source: 'FINANCIAL',
          notes: 'Complete revenue from FINANCIAL reports (includes all renewals)'
        });
      } catch {
        const salesData = await this.financeService.getMonthlyRevenue(year, month);
        return this.ok({ ...salesData, source: 'SALES', notes: 'From SALES reports (new purchases only, excludes renewals)' });
      }
    });

    this.server.registerTool('get_subscription_renewals', {
      description: 'Get subscription renewal data for a specific date',
      inputSchema: {
        date: z.string().optional().describe('Date in YYYY-MM-DD format (defaults to yesterday)')
      }
    }, async ({ date }) => this.ok(await this.subscriptionService.getSubscriptionRenewals(date)));

    this.server.registerTool('get_monthly_subscription_analytics', {
      description: 'Get comprehensive subscription analytics for a full calendar month',
      inputSchema: {
        year: z.number().int().describe('Year (e.g., 2025)'),
        month: z.number().int().min(1).max(12).describe('Month (1-12)')
      }
    }, async ({ year, month }) => this.ok(await this.subscriptionService.getMonthlySubscriptionAnalytics(year, month)));

    // Analytics tools
    this.server.registerTool('get_app_analytics', {
      description: 'Get app usage analytics via the Analytics Report Requests API. Note: reports are generated asynchronously and may not be immediately available for all apps.',
      inputSchema: {
        appId: z.string().describe('App ID to get analytics for'),
        metricType: z.enum(['USERS', 'SESSIONS', 'CRASHES', 'RETENTION']).optional().describe('Type of metric to retrieve (defaults to USERS)')
      }
    }, async ({ appId, metricType }) => this.ok(await this.analyticsService.getAppAnalytics({
      appId,
      metricType: metricType || 'USERS'
    })));

    // Beta testing tools
    this.server.registerTool('get_testflight_metrics', {
      description: 'Get TestFlight beta testing metrics including testers, groups, and recent builds',
      inputSchema: {
        appId: z.string().optional().describe('Optional: specific app ID to filter')
      }
    }, async ({ appId }) => this.ok(await this.betaService.getTestFlightSummary(appId)));

    this.server.registerTool('get_beta_testers', {
      description: 'Get list of beta testers across all apps',
      inputSchema: {
        limit: z.number().int().optional().describe('Maximum number of testers to return (default: 100)')
      }
    }, async ({ limit }) => this.ok(await this.betaService.getBetaTesters(limit ?? 100)));

    // Review tools
    this.server.registerTool('get_customer_reviews', {
      description: 'Get customer reviews and ratings for a specific app',
      inputSchema: {
        appId: z.string().describe('App ID to get reviews for'),
        limit: z.number().int().optional().describe('Maximum number of reviews (default: 100)')
      }
    }, async ({ appId, limit }) => this.ok(await this.reviewService.getCustomerReviews(appId, limit ?? 100)));

    this.server.registerTool('get_review_metrics', {
      description: 'Get comprehensive review metrics and sentiment analysis for an app',
      inputSchema: {
        appId: z.string().describe('App ID to analyze reviews for')
      }
    }, async ({ appId }) => this.ok(await this.reviewService.getReviewSummary(appId)));

    // Utility tools
    this.server.registerTool('test_connection', {
      description: 'Test connection to App Store Connect API and verify credentials',
      inputSchema: {}
    }, async () => {
      const connected = await this.client.testConnection();
      return this.ok({
        connected,
        message: connected ? 'Successfully connected to App Store Connect' : 'Connection failed'
      });
    });

    this.server.registerTool('get_api_stats', {
      description: 'Get API usage statistics (request count, rate limit status)',
      inputSchema: {}
    }, async () => this.ok(this.client.getStats()));
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

import { AppStoreClient } from '../api/client.js';
import { decompressIfNeeded, parseCSVReport } from '../utils/report-utils.js';

export class SubscriptionService {
  constructor(
    private client: AppStoreClient,
    private vendorNumber?: string
  ) {}

  async getSubscriptionRenewals(date?: string): Promise<any> {
    if (!this.vendorNumber) {
      throw new Error('Vendor number required for subscription reports');
    }

    const targetDate = date || this.getYesterdayDate();

    const results = {
      date: targetDate,
      renewalData: null as any,
      salesData: null as any,
      totalRenewals: 0,
      totalNewSubscriptions: 0,
      estimatedMRR: 0,
      dataSource: 'none'
    };

    // Try subscription report types in order
    const subscriptionParams = [
      { reportType: 'SUBSCRIPTION', reportSubType: 'SUMMARY', version: '1_2' },
      { reportType: 'SUBSCRIPTION', reportSubType: 'DETAILED', version: '1_2' },
      { reportType: 'SUBSCRIPTION_EVENT', reportSubType: 'SUMMARY', version: '1_2' },
      { reportType: 'SUBSCRIBER', reportSubType: 'DETAILED', version: '1_3' }
    ];

    for (const params of subscriptionParams) {
      try {
        const response = await this.client.request('/salesReports', {
          'filter[vendorNumber]': this.vendorNumber,
          'filter[reportType]': params.reportType,
          'filter[reportSubType]': params.reportSubType,
          'filter[frequency]': 'DAILY',
          'filter[reportDate]': targetDate,
          'filter[version]': params.version
        });
        const parsed = parseCSVReport(decompressIfNeeded(response), params.reportType);
        if (parsed.rows.length > 0) {
          results.renewalData = this.analyzeSubscriptionData(parsed);
          results.dataSource = params.reportType;
          break;
        }
      } catch {
        // Continue to next type
      }
    }

    // Also try SALES data for subscription patterns
    try {
      const salesResponse = await this.client.request('/salesReports', {
        'filter[vendorNumber]': this.vendorNumber,
        'filter[reportType]': 'SALES',
        'filter[reportSubType]': 'SUMMARY',
        'filter[frequency]': 'DAILY',
        'filter[reportDate]': targetDate,
        'filter[version]': '1_1'
      });
      const salesParsed = parseCSVReport(decompressIfNeeded(salesResponse), 'SALES');
      if (salesParsed.rows.length > 0) {
        results.salesData = this.extractSubscriptionFromSales(salesParsed);
        results.totalNewSubscriptions = results.salesData.newSubscriptions || 0;
        if (!results.renewalData) results.dataSource = 'SALES_INFERRED';
      }
    } catch {
      // Sales data not available
    }

    results.estimatedMRR = this.calculateEstimatedMRR(results);
    return results;
  }

  async getMonthlySubscriptionAnalytics(year: number, month: number): Promise<any> {
    const analytics = {
      year,
      month,
      monthName: new Date(year, month - 1).toLocaleDateString('en-US', { month: 'long' }),
      totalNewSubscriptions: 0,
      totalRenewals: 0,
      totalChurn: 0,
      netSubscriberGrowth: 0,
      subscriptionRevenue: 0,
      oneTimeRevenue: 0,
      averageSubscriptionValue: 0,
      subscriptionTypes: new Map<string, number>(),
      geographicDistribution: new Map<string, number>(),
      dailyMetrics: [] as any[]
    };

    const daysInMonth = new Date(year, month, 0).getDate();
    const dates = Array.from({ length: daysInMonth }, (_, i) => {
      const day = i + 1;
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    });

    // Fetch all days concurrently in batches of 10
    const BATCH_SIZE = 10;
    const allResults: Array<any> = [];

    for (let i = 0; i < dates.length; i += BATCH_SIZE) {
      const batch = dates.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(dateStr => this.getSubscriptionRenewals(dateStr))
      );
      for (let j = 0; j < batchResults.length; j++) {
        const r = batchResults[j];
        allResults.push(r.status === 'fulfilled' ? { dateStr: batch[j], data: r.value } : null);
      }
      if (i + BATCH_SIZE < dates.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    for (const item of allResults) {
      if (!item) continue;
      const { dateStr, data } = item;
      if (!data) continue;

      analytics.totalNewSubscriptions += data.totalNewSubscriptions || 0;
      analytics.totalRenewals += data.totalRenewals || 0;

      if (data.salesData) {
        analytics.subscriptionRevenue += data.salesData.subscriptionRevenue || 0;
        analytics.oneTimeRevenue += data.salesData.oneTimeRevenue || 0;

        if (data.salesData.subscriptionTypes) {
          for (const [type, count] of Object.entries(data.salesData.subscriptionTypes)) {
            analytics.subscriptionTypes.set(type, (analytics.subscriptionTypes.get(type) || 0) + (count as number));
          }
        }

        if (data.salesData.countries) {
          for (const [country, revenue] of Object.entries(data.salesData.countries)) {
            analytics.geographicDistribution.set(country, (analytics.geographicDistribution.get(country) || 0) + (revenue as number));
          }
        }
      }

      analytics.dailyMetrics.push({
        date: dateStr,
        newSubscriptions: data.totalNewSubscriptions,
        renewals: data.totalRenewals,
        estimatedMRR: data.estimatedMRR
      });
    }

    analytics.netSubscriberGrowth = analytics.totalNewSubscriptions - analytics.totalChurn;
    if (analytics.totalNewSubscriptions > 0) {
      analytics.averageSubscriptionValue = analytics.subscriptionRevenue / analytics.totalNewSubscriptions;
    }

    const sortedTypes = Array.from(analytics.subscriptionTypes.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count }));

    const sortedCountries = Array.from(analytics.geographicDistribution.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([country, revenue]) => ({
        country,
        revenue,
        percentage: analytics.subscriptionRevenue > 0
          ? (revenue / analytics.subscriptionRevenue * 100).toFixed(1)
          : '0.0'
      }));

    return {
      ...analytics,
      subscriptionTypes: sortedTypes,
      topCountries: sortedCountries,
      summary: {
        totalRevenue: analytics.subscriptionRevenue + analytics.oneTimeRevenue,
        subscriptionPercentage: analytics.subscriptionRevenue + analytics.oneTimeRevenue > 0
          ? ((analytics.subscriptionRevenue / (analytics.subscriptionRevenue + analytics.oneTimeRevenue)) * 100).toFixed(1)
          : '0.0',
        estimatedActiveSubscribers: analytics.totalNewSubscriptions + analytics.totalRenewals - analytics.totalChurn,
        averageSubscriptionValue: analytics.averageSubscriptionValue.toFixed(2)
      }
    };
  }

  private analyzeSubscriptionData(parsedData: any): any {
    const analysis = {
      totalSubscribers: 0,
      activeSubscribers: 0,
      newSubscribers: 0,
      canceledSubscribers: 0,
      revenue: 0,
      averagePrice: 0,
      subscriptionsByProduct: new Map<string, number>(),
      subscriptionsByCountry: new Map<string, number>()
    };

    for (const row of parsedData.rows) {
      const active = parseInt(row['Active Standard Price Subscriptions'] || '0', 10);
      const newSubs = parseInt(row['New Standard Price Subscriptions'] || '0', 10);
      const canceled = parseInt(row['Canceled Subscriptions'] || '0', 10);
      const revenue = parseFloat(row['Developer Proceeds'] || row['Proceeds'] || '0');
      const product = row['SKU'] || row['Product'] || 'Unknown';
      const country = row['Country Code'] || 'Unknown';

      analysis.activeSubscribers += active;
      analysis.newSubscribers += newSubs;
      analysis.canceledSubscribers += canceled;
      analysis.revenue += revenue;

      if (product !== 'Unknown') {
        analysis.subscriptionsByProduct.set(product, (analysis.subscriptionsByProduct.get(product) || 0) + active);
      }
      if (country !== 'Unknown') {
        analysis.subscriptionsByCountry.set(country, (analysis.subscriptionsByCountry.get(country) || 0) + active);
      }
    }

    analysis.totalSubscribers = analysis.activeSubscribers;
    if (analysis.activeSubscribers > 0) {
      analysis.averagePrice = analysis.revenue / analysis.activeSubscribers;
    }
    return analysis;
  }

  private extractSubscriptionFromSales(parsedData: any): any {
    const extracted = {
      subscriptionRevenue: 0,
      oneTimeRevenue: 0,
      newSubscriptions: 0,
      subscriptionTypes: {} as Record<string, number>,
      countries: {} as Record<string, number>,
      products: [] as any[]
    };

    for (const row of parsedData.rows) {
      const productType = row['Product Type Identifier'] || '';
      const revenue = row._proceedsUSD || 0;
      const units = parseInt(row['Units'] || '0', 10);
      const product = row['Title'] || row['Product Title'] || 'Unknown';
      const country = row['Country Code'] || 'Unknown';
      const sku = row['SKU'] || '';

      const isSubscription =
        productType.includes('Auto-Renewable') ||
        productType.includes('Subscription') ||
        product.toLowerCase().includes('subscription') ||
        product.toLowerCase().includes('monthly') ||
        product.toLowerCase().includes('yearly') ||
        product.toLowerCase().includes('annual');

      if (isSubscription) {
        extracted.subscriptionRevenue += revenue;
        extracted.newSubscriptions += units;
        extracted.subscriptionTypes[productType] = (extracted.subscriptionTypes[productType] || 0) + units;
      } else {
        extracted.oneTimeRevenue += revenue;
      }

      extracted.countries[country] = (extracted.countries[country] || 0) + revenue;

      if (isSubscription && units > 0) {
        extracted.products.push({ sku, product, units, revenue, averagePrice: revenue / units });
      }
    }

    extracted.products.sort((a, b) => b.revenue - a.revenue);
    return extracted;
  }

  private calculateEstimatedMRR(data: any): number {
    if (data.renewalData?.activeSubscribers > 0) {
      return data.renewalData.activeSubscribers * data.renewalData.averagePrice;
    }
    if (data.salesData?.newSubscriptions > 0) {
      const estimatedActiveBase = data.salesData.newSubscriptions * 10;
      const averagePrice = data.salesData.subscriptionRevenue / data.salesData.newSubscriptions;
      return estimatedActiveBase * averagePrice;
    }
    return 0;
  }

  private getYesterdayDate(): string {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday.toISOString().split('T')[0];
  }
}

import { decompressIfNeeded, parseCSVReport } from '../utils/report-utils.js';
export class FinanceService {
    client;
    vendorNumber;
    constructor(client, vendorNumber) {
        this.client = client;
        this.vendorNumber = vendorNumber;
    }
    /**
     * Get sales report for a specific date
     */
    async getSalesReport(options) {
        if (!this.vendorNumber && !options.vendorNumber) {
            throw new Error('Vendor number required for financial reports. Set APP_STORE_VENDOR_NUMBER');
        }
        const params = {
            'filter[vendorNumber]': options.vendorNumber || this.vendorNumber,
            'filter[reportType]': options.reportType || 'SALES',
            'filter[reportSubType]': options.reportSubType || 'SUMMARY',
            'filter[frequency]': options.dateType || 'DAILY',
            'filter[reportDate]': options.date || this.getYesterdayDate(),
            'filter[version]': '1_1' // Latest version for sales reports per Apple
        };
        const response = await this.client.request('/salesReports', params);
        // Apple returns gzipped CSV data, need to decompress
        const decompressed = decompressIfNeeded(response);
        return parseCSVReport(decompressed, options.reportType || 'SALES');
    }
    /**
     * Get financial reports (more detailed than sales)
     */
    async getFinancialReport(year, month) {
        if (!this.vendorNumber) {
            throw new Error('Vendor number required for financial reports');
        }
        const params = {
            'filter[vendorNumber]': this.vendorNumber,
            'filter[regionCode]': 'ZZ', // All regions
            'filter[reportType]': 'FINANCIAL',
            'filter[fiscalYear]': year,
            'filter[fiscalPeriod]': String(month).padStart(2, '0'),
            'filter[version]': '1_0' // Required version for financial reports
        };
        const response = await this.client.request('/financeReports', params);
        // Decompress and parse the financial report
        const decompressed = decompressIfNeeded(response);
        return parseCSVReport(decompressed, 'FINANCIAL');
    }
    /**
     * Calculate MRR and ARR from current data
     */
    async getRevenueMetrics(appId) {
        try {
            // Get subscription report for MRR/ARR calculation
            const salesData = await this.getSalesReport({
                reportType: 'SUBSCRIPTION',
                reportSubType: 'SUMMARY',
                dateType: 'MONTHLY',
                date: this.getCurrentMonthDate()
            });
            // Calculate metrics from parsed data
            return this.calculateRevenueMetricsFromData(salesData);
        }
        catch (error) {
            // If subscription report fails, try regular sales report
            const salesData = await this.getSalesReport({
                reportType: 'SALES',
                reportSubType: 'SUMMARY',
                dateType: 'MONTHLY',
                date: this.getCurrentMonthDate()
            });
            return this.calculateRevenueMetricsFromData(salesData);
        }
    }
    /**
     * Get subscription metrics
     */
    async getSubscriptionMetrics() {
        if (!this.vendorNumber) {
            throw new Error('Vendor number required for subscription reports');
        }
        // Try different parameter combinations until one works
        const parameterSets = [
            // Try version 1_2 first (might work better)
            {
                'filter[vendorNumber]': this.vendorNumber,
                'filter[reportType]': 'SUBSCRIPTION',
                'filter[reportSubType]': 'SUMMARY',
                'filter[frequency]': 'DAILY',
                'filter[reportDate]': this.getYesterdayDate(),
                'filter[version]': '1_2'
            },
            // Try without version (let API choose)
            {
                'filter[vendorNumber]': this.vendorNumber,
                'filter[reportType]': 'SUBSCRIPTION',
                'filter[reportSubType]': 'SUMMARY',
                'filter[frequency]': 'DAILY',
                'filter[reportDate]': this.getYesterdayDate()
            },
            // Try DETAILED subtype
            {
                'filter[vendorNumber]': this.vendorNumber,
                'filter[reportType]': 'SUBSCRIPTION',
                'filter[reportSubType]': 'DETAILED',
                'filter[frequency]': 'DAILY',
                'filter[reportDate]': this.getYesterdayDate(),
                'filter[version]': '1_3'
            },
            // Original failing params (kept as fallback)
            {
                'filter[vendorNumber]': this.vendorNumber,
                'filter[reportType]': 'SUBSCRIPTION',
                'filter[reportSubType]': 'SUMMARY',
                'filter[frequency]': 'DAILY',
                'filter[reportDate]': this.getYesterdayDate(),
                'filter[version]': '1_3'
            }
        ];
        let lastError = null;
        // Try each parameter set until one works
        for (const params of parameterSets) {
            try {
                const response = await this.client.request('/salesReports', params);
                // If we get here, request succeeded
                const decompressed = decompressIfNeeded(response);
                const parsedData = parseCSVReport(decompressed, 'SUBSCRIPTION');
                // Format for AI consumption
                return this.formatSubscriptionData(parsedData);
            }
            catch (error) {
                lastError = error;
                // Continue to next parameter set
            }
        }
        // If all parameter sets failed, throw the last error
        throw lastError || new Error('Failed to fetch subscription metrics');
    }
    /**
     * Calculate revenue metrics from parsed data
     */
    calculateRevenueMetricsFromData(parsedData) {
        const metrics = {
            totalRevenue: 0,
            totalUnits: 0,
            byProduct: [],
            byCountry: [],
            subscriptions: undefined
        };
        if (!parsedData.rows || parsedData.rows.length === 0) {
            return metrics;
        }
        // Aggregate metrics from rows
        const productMap = new Map();
        const countryMap = new Map();
        let activeSubscribers = 0;
        let newSubscribers = 0;
        for (const row of parsedData.rows) {
            // Common fields across report types
            // Use the pre-converted USD value from parseCSVReport
            const revenue = row._proceedsUSD || parseFloat(row['Developer Proceeds'] || row['Proceeds'] || '0');
            const units = parseInt(row['Units'] || row['Unit Sales'] || '0', 10);
            const product = row['SKU'] || row['Product'] || 'Unknown';
            const title = row['Title'] || row['Product Title'] || product;
            const country = row['Country Code'] || row['Territory'] || 'Unknown';
            // Subscription specific fields
            if (row['Active Standard Price Subscriptions']) {
                activeSubscribers += parseInt(row['Active Standard Price Subscriptions'], 10) || 0;
            }
            if (row['New Standard Price Subscriptions']) {
                newSubscribers += parseInt(row['New Standard Price Subscriptions'], 10) || 0;
            }
            // Only add if revenue is positive and reasonable (filter out bad conversions)
            if (revenue > 0 && revenue < 1000000) { // Sanity check: single transaction shouldn't be > $1M
                metrics.totalRevenue += revenue;
                metrics.totalUnits += units;
            }
            // Aggregate by product
            if (!productMap.has(product)) {
                productMap.set(product, { revenue: 0, units: 0, title });
            }
            const productData = productMap.get(product);
            productData.revenue += revenue;
            productData.units += units;
            // Aggregate by country
            if (!countryMap.has(country)) {
                countryMap.set(country, { revenue: 0, units: 0 });
            }
            const countryData = countryMap.get(country);
            countryData.revenue += revenue;
            countryData.units += units;
        }
        // Convert maps to arrays
        metrics.byProduct = Array.from(productMap.entries())
            .map(([sku, data]) => ({ sku, ...data }))
            .sort((a, b) => b.revenue - a.revenue)
            .slice(0, 10); // Top 10 products
        metrics.byCountry = Array.from(countryMap.entries())
            .map(([country, data]) => ({ country, ...data }))
            .sort((a, b) => b.revenue - a.revenue)
            .slice(0, 10); // Top 10 countries
        // Calculate subscription metrics if available
        if (parsedData.reportType === 'SUBSCRIPTION' || activeSubscribers > 0) {
            const mrr = metrics.totalRevenue; // Monthly recurring revenue
            metrics.subscriptions = {
                activeCount: activeSubscribers,
                newCount: newSubscribers,
                cancelledCount: 0, // Would need cancellation report
                mrr: Math.round(mrr * 100) / 100,
                arr: Math.round(mrr * 12 * 100) / 100 // Annual recurring revenue
            };
        }
        return metrics;
    }
    /**
     * Format subscription data for AI
     */
    /**
     * Get aggregated monthly revenue by summing all daily reports
     */
    async getMonthlyRevenue(year, month) {
        if (!this.vendorNumber) {
            throw new Error('Vendor number required for revenue reports');
        }
        const monthlyData = {
            year,
            month,
            monthName: new Date(year, month - 1).toLocaleDateString('en-US', { month: 'long' }),
            totalRevenue: 0,
            totalTransactions: 0,
            daysWithData: 0,
            dailyRevenues: [],
            countryBreakdown: new Map(),
            productBreakdown: new Map(),
            currencyBreakdown: new Map(),
            highRevenueDays: []
        };
        // Build date list for all days in the month
        const daysInMonth = new Date(year, month, 0).getDate();
        const dates = Array.from({ length: daysInMonth }, (_, i) => {
            const day = i + 1;
            return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        });
        // Fetch all days concurrently in batches of 10 to respect rate limits
        const BATCH_SIZE = 10;
        const dayResults = [];
        for (let i = 0; i < dates.length; i += BATCH_SIZE) {
            const batch = dates.slice(i, i + BATCH_SIZE);
            const batchResults = await Promise.allSettled(batch.map(async (dateStr) => {
                const report = await this.getSalesReport({ reportType: 'SALES', dateType: 'DAILY', date: dateStr });
                return { dateStr, report };
            }));
            for (let j = 0; j < batchResults.length; j++) {
                const result = batchResults[j];
                if (result.status === 'fulfilled') {
                    dayResults.push(result.value);
                }
                else {
                    const msg = result.reason?.message || '';
                    if (!msg.includes('not found') && !msg.includes('404') && !msg.includes('No data')) {
                        process.stderr.write(`[finance-service] fetch error for ${batch[j]}: ${msg}\n`);
                    }
                    dayResults.push(null);
                }
            }
            // Small pause between batches to avoid bursting the rate limit
            if (i + BATCH_SIZE < dates.length) {
                await new Promise(r => setTimeout(r, 200));
            }
        }
        // Aggregate results
        for (const item of dayResults) {
            if (!item)
                continue;
            const { dateStr, report } = item;
            if (report.rows && report.rows.length > 0) {
                monthlyData.daysWithData++;
                monthlyData.totalTransactions += report.rows.length;
                let dailyTotal = 0;
                report.rows.forEach((row) => {
                    const revenue = row._proceedsUSD || 0;
                    const country = row['Country Code'] || 'Unknown';
                    const product = row['Title'] || row['Product Title'] || 'Unknown';
                    const currency = row['Customer Currency'] || 'USD';
                    dailyTotal += revenue;
                    monthlyData.countryBreakdown.set(country, (monthlyData.countryBreakdown.get(country) || 0) + revenue);
                    monthlyData.productBreakdown.set(product, (monthlyData.productBreakdown.get(product) || 0) + revenue);
                    monthlyData.currencyBreakdown.set(currency, (monthlyData.currencyBreakdown.get(currency) || 0) + revenue);
                });
                monthlyData.totalRevenue += dailyTotal;
                monthlyData.dailyRevenues.push(dailyTotal);
                if (dailyTotal > 10000) {
                    monthlyData.highRevenueDays.push({ date: dateStr, revenue: dailyTotal, transactions: report.rows.length });
                }
            }
        }
        // Calculate statistics
        const stats = {
            ...monthlyData,
            dailyAverage: monthlyData.daysWithData > 0 ? monthlyData.totalRevenue / monthlyData.daysWithData : 0,
            perTransaction: monthlyData.totalTransactions > 0 ? monthlyData.totalRevenue / monthlyData.totalTransactions : 0
        };
        if (monthlyData.dailyRevenues.length > 0) {
            const sorted = [...monthlyData.dailyRevenues].sort((a, b) => a - b);
            stats.dailyMin = Math.min(...monthlyData.dailyRevenues);
            stats.dailyMax = Math.max(...monthlyData.dailyRevenues);
            stats.dailyMedian = sorted[Math.floor(sorted.length / 2)];
        }
        // Convert maps to sorted arrays for response
        stats.topCountries = Array.from(monthlyData.countryBreakdown.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([country, revenue]) => ({
            country,
            revenue,
            percentage: (revenue / monthlyData.totalRevenue * 100).toFixed(1)
        }));
        stats.topProducts = Array.from(monthlyData.productBreakdown.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([product, revenue]) => ({
            product,
            revenue,
            percentage: (revenue / monthlyData.totalRevenue * 100).toFixed(1)
        }));
        stats.currencyBreakdown = Array.from(monthlyData.currencyBreakdown.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([currency, revenue]) => ({
            currency,
            revenue,
            percentage: (revenue / monthlyData.totalRevenue * 100).toFixed(1)
        }));
        // Sort high revenue days
        stats.highRevenueDays = monthlyData.highRevenueDays
            .sort((a, b) => b.revenue - a.revenue)
            .slice(0, 10);
        // Clean up internal tracking
        delete stats.countryBreakdown;
        delete stats.productBreakdown;
        delete stats.dailyRevenues;
        return stats;
    }
    formatSubscriptionData(parsedData) {
        const metrics = this.calculateRevenueMetricsFromData(parsedData);
        return {
            summary: 'Subscription metrics calculated from report data',
            metrics: {
                activeSubscribers: metrics.subscriptions?.activeCount || 0,
                newSubscribers: metrics.subscriptions?.newCount || 0,
                mrr: metrics.subscriptions?.mrr || 0,
                arr: metrics.subscriptions?.arr || 0,
                churnRate: 0, // Would need historical data to calculate
                avgSubscriptionLength: 0, // Would need additional data
                topProducts: metrics.byProduct.slice(0, 5),
                topCountries: metrics.byCountry.slice(0, 5)
            },
            totalRevenue: metrics.totalRevenue,
            totalUnits: metrics.totalUnits
        };
    }
    /**
     * Helper to get yesterday's date in YYYY-MM-DD format
     */
    getYesterdayDate() {
        const date = new Date();
        date.setDate(date.getDate() - 1);
        return date.toISOString().split('T')[0];
    }
    /**
     * Helper to get current month in YYYY-MM format
     */
    getCurrentMonthDate() {
        const date = new Date();
        return date.toISOString().slice(0, 7);
    }
}
//# sourceMappingURL=finance-service.js.map
export class AppService {
    client;
    constructor(client) {
        this.client = client;
    }
    /**
     * Get all apps
     */
    async listApps() {
        const apps = await this.client.getAll('/apps');
        return apps;
    }
    /**
     * Get a specific app by ID
     */
    async getApp(appId) {
        const response = await this.client.request(`/apps/${appId}`);
        return response.data;
    }
    /**
     * Get app by bundle ID
     */
    async getAppByBundleId(bundleId) {
        const response = await this.client.request('/apps', {
            'filter[bundleId]': bundleId
        });
        if (response.data.length === 0) {
            return null;
        }
        return response.data[0];
    }
    /**
     * Get formatted app summary for AI consumption
     */
    async getAppSummary(appId) {
        const app = await this.getApp(appId);
        return {
            id: app.id,
            name: app.attributes.name,
            bundleId: app.attributes.bundleId,
            sku: app.attributes.sku,
            primaryLocale: app.attributes.primaryLocale,
            kidsApp: app.attributes.isOrEverWasMadeForKids,
            // Add more formatted fields as needed
        };
    }
    /**
     * Get all apps with their basic info
     */
    async getAllAppsSummary() {
        const apps = await this.listApps();
        return apps.map(app => ({
            id: app.id,
            name: app.attributes.name,
            bundleId: app.attributes.bundleId,
            sku: app.attributes.sku
        }));
    }
}
//# sourceMappingURL=app-service.js.map
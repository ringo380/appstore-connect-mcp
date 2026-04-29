/**
 * App Store Connect MCP Server — Code Mode (v2.0)
 *
 * Two tools. 923 endpoints. Fixed token cost.
 *
 * search(code) — Agent writes JS to query the API spec
 * execute(code) — Agent writes JS to call the authenticated API
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { JWTManager } from '../auth/jwt-manager.js';
import { AppStoreClient } from '../api/client.js';
import { loadSpec } from '../spec/loader.js';
import { executeInSandbox } from '../executor/sandbox.js';
import { ServerConfig } from '../types/config.js';

const SETUP_MSG = `App Store Connect credentials are not configured.

Run /appstore-connect-mcp:setup in Claude Code to get started.

Or set these environment variables manually in ~/.zshenv:
  export APP_STORE_KEY_ID="<your-key-id>"
  export APP_STORE_ISSUER_ID="<your-issuer-id>"
  export APP_STORE_P8_PATH="<path-to-your.p8>"

Then reconnect via /mcp.`;

export class AppStoreMCPServer {
  private server: McpServer;
  private auth: JWTManager | null;
  private client: AppStoreClient | null;
  private spec: any;

  constructor(config: ServerConfig) {
    this.server = new McpServer({
      name: 'appstore-connect-mcp',
      version: '2.0.0'
    });

    if (config.auth) {
      this.auth = new JWTManager(config.auth);
      this.client = new AppStoreClient(this.auth);
    } else {
      this.auth = null;
      this.client = null;
    }

    this.spec = loadSpec();

    this.registerTools();
  }

  private registerTools() {
    this.server.registerTool(
      'search',
      {
        description: `Write JavaScript to explore the App Store Connect API specification (${this.spec.pathCount} endpoints, ${this.spec.schemaCount} schemas, API v${this.spec.info.version}).

Available globals:
- \`spec\` — Object with all API endpoints. Structure: spec.paths['/v1/endpoint'].method

How to use:
- List all paths: Object.keys(spec.paths)
- Filter by keyword: Object.entries(spec.paths).filter(([p]) => p.includes('reviews'))
- Get endpoint details: spec.paths['/v1/apps'].get
- Check parameters: spec.paths['/v1/apps'].get.parameters
- Check response schema: spec.paths['/v1/apps'].get.responses
- Get tags: spec.paths['/v1/apps'].get.tags
- Search by tag: Object.entries(spec.paths).filter(([p, m]) => Object.values(m).some(op => op.tags?.includes('Apps')))

Return your findings as a value or use console.log().

Example — find all review-related endpoints:
  const reviews = Object.entries(spec.paths)
    .filter(([p]) => p.toLowerCase().includes('review'))
    .map(([path, methods]) => ({
      path,
      methods: Object.entries(methods).map(([m, op]) => ({ method: m.toUpperCase(), summary: op.summary }))
    }));
  return reviews;`,
        inputSchema: {
          code: z.string().describe('JavaScript code to execute. Has access to the `spec` object containing the full App Store Connect OpenAPI specification.')
        }
      },
      async ({ code }) => {
        const result = await executeInSandbox(code, { spec: this.spec });
        const output = result.error
          ? { error: result.error, logs: result.logs }
          : { result: result.result, logs: result.logs.length > 0 ? result.logs : undefined };
        return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }] };
      }
    );

    this.server.registerTool(
      'execute',
      {
        description: `Write JavaScript to call the App Store Connect API. Authentication is automatic (JWT injected).

Available globals:
- \`api\` — Authenticated client for App Store Connect.

Usage:
  const result = await api.request({
    method: 'GET',             // GET, POST, PATCH, DELETE
    path: '/v1/apps',          // API path (from search results)
    params: { limit: '10' },   // Query parameters (optional)
    body: { ... }              // Request body for POST/PATCH (optional)
  });

The response is parsed JSON. You can chain multiple API calls in one execution.
Use try/catch for error handling. Reports endpoints may return gzipped data — the client handles decompression.

Example — list apps then get reviews for first app:
  const apps = await api.request({ method: 'GET', path: '/v1/apps', params: { limit: '5' } });
  const appId = apps.data[0].id;
  const appName = apps.data[0].attributes.name;
  const reviews = await api.request({
    method: 'GET',
    path: '/v1/apps/' + appId + '/customerReviews',
    params: { limit: '5', sort: '-createdDate' }
  });
  return {
    app: appName,
    reviewCount: reviews.data.length,
    latest: reviews.data[0]?.attributes
  };`,
        inputSchema: {
          code: z.string().describe('JavaScript code to execute. Has access to the authenticated `api` client for App Store Connect.')
        }
      },
      async ({ code }) => {
        if (!this.client) {
          return { content: [{ type: 'text' as const, text: SETUP_MSG }] };
        }

        const client = this.client;
        const api = {
          request: async (opts: { method: string; path: string; params?: any; body?: any }) => {
            return client.request(opts.path, opts.params, {
              method: opts.method,
              data: opts.body
            });
          }
        };

        const result = await executeInSandbox(code, { api });
        const output = result.error
          ? { error: result.error, logs: result.logs }
          : { result: result.result, logs: result.logs.length > 0 ? result.logs : undefined };
        return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }] };
      }
    );

    this.server.registerTool(
      'test_connection',
      {
        description: 'Test connection to App Store Connect API and show server info',
        inputSchema: {}
      },
      async () => {
        if (!this.client) {
          return { content: [{ type: 'text' as const, text: SETUP_MSG }] };
        }

        const connected = await this.client.testConnection();
        const output = {
          connected,
          message: connected ? 'Successfully connected to App Store Connect' : 'Connection failed',
          server: 'appstore-connect-mcp',
          version: '2.0.0',
          mode: 'code-mode',
          spec: {
            apiVersion: this.spec.info.version,
            endpoints: this.spec.pathCount,
            schemas: this.spec.schemaCount
          }
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }] };
      }
    );
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

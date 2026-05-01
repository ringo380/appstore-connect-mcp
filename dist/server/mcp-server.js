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
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { MAX_CODE_LENGTH } from '../constants.js';
import { JWTManager } from '../auth/jwt-manager.js';
import { AppStoreClient } from '../api/client.js';
import { loadSpec } from '../spec/loader.js';
import { executeInSandbox } from '../executor/sandbox.js';
const SETUP_MSG = `App Store Connect credentials are not configured.

Run /appstore-connect-mcp:setup in Claude Code to get started.

Or set these environment variables manually in ~/.zshenv:
  export APP_STORE_KEY_ID="<your-key-id>"
  export APP_STORE_ISSUER_ID="<your-issuer-id>"
  export APP_STORE_P8_PATH="<path-to-your.p8>"

Then reconnect via /mcp.`;
export class AppStoreMCPServer {
    server;
    auth;
    client;
    spec;
    constructor(config) {
        this.server = new McpServer({
            name: 'appstore-connect-mcp',
            version: '2.0.0'
        });
        if (config.auth) {
            this.auth = new JWTManager(config.auth);
            this.client = new AppStoreClient(this.auth);
        }
        else {
            this.auth = null;
            this.client = null;
        }
        this.spec = loadSpec();
        this.registerTools();
        this.registerConfigureTool();
    }
    registerTools() {
        this.server.registerTool('search', {
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
                code: z.string().max(MAX_CODE_LENGTH).describe('JavaScript code to execute. Has access to the `spec` object containing the full App Store Connect OpenAPI specification.')
            }
        }, async ({ code }) => {
            const result = await executeInSandbox(code, { spec: this.spec });
            const output = result.error
                ? { error: result.error, logs: result.logs }
                : { result: result.result, logs: result.logs.length > 0 ? result.logs : undefined };
            return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
        });
        this.server.registerTool('execute', {
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
                code: z.string().max(MAX_CODE_LENGTH).describe('JavaScript code to execute. Has access to the authenticated `api` client for App Store Connect.')
            }
        }, async ({ code }) => {
            if (!this.client) {
                return { content: [{ type: 'text', text: SETUP_MSG }] };
            }
            const client = this.client;
            const api = {
                request: async (opts) => {
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
            return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
        });
        this.server.registerTool('test_connection', {
            description: 'Test connection to App Store Connect API and show server info',
            inputSchema: {}
        }, async () => {
            if (!this.client) {
                return { content: [{ type: 'text', text: SETUP_MSG }] };
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
            return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
        });
    }
    registerConfigureTool() {
        this.server.registerTool('configure', {
            description: `Set up App Store Connect API credentials. Writes the required environment variables to ~/.zshenv so they persist across sessions.

You need three things from App Store Connect → Users and Access → Integrations → API Keys:
1. Key ID — 10-character string (e.g. A1B2C3D4E5)
2. Issuer ID — UUID shown at the top of the API Keys page
3. P8 file path — full path to your downloaded .p8 private key file

Optionally provide your Vendor Number (from Payments and Financial Reports) for sales/financial reports.`,
            inputSchema: {
                keyId: z.string().describe('10-character Key ID from App Store Connect → Users and Access → Integrations → API Keys'),
                issuerId: z.string().describe('Issuer ID UUID from the same page'),
                p8Path: z.string().describe('Absolute path to your .p8 private key file (e.g. /Users/you/.private_keys/AuthKey_XXXXXXXX.p8)'),
                vendorNumber: z.string().optional().describe('Vendor number for sales/financial reports (optional — from Payments and Financial Reports)')
            }
        }, async ({ keyId, issuerId, p8Path, vendorNumber }) => {
            // Only expand ~ — leave absolute paths untouched, reject relative paths early
            const expandedPath = p8Path.startsWith('~')
                ? resolve(p8Path.replace(/^~/, homedir()))
                : p8Path;
            if (!existsSync(expandedPath)) {
                return { content: [{ type: 'text', text: `Error: P8 file not found at ${expandedPath}\n\nDouble-check the path and try again. The file is only downloadable once from App Store Connect.` }] };
            }
            const zshenvPath = `${homedir()}/.zshenv`;
            let content = existsSync(zshenvPath) ? readFileSync(zshenvPath, 'utf8') : '';
            const vars = {
                APP_STORE_KEY_ID: keyId,
                APP_STORE_ISSUER_ID: issuerId,
                APP_STORE_P8_PATH: expandedPath,
                ...(vendorNumber ? { APP_STORE_VENDOR_NUMBER: vendorNumber } : {})
            };
            for (const [key, value] of Object.entries(vars)) {
                const regex = new RegExp(`^export ${key}=.*$`, 'm');
                const line = `export ${key}="${value}"`;
                if (regex.test(content)) {
                    content = content.replace(regex, line);
                }
                else {
                    content = content.trimEnd() + '\n' + line + '\n';
                }
            }
            writeFileSync(zshenvPath, content, 'utf8');
            const saved = Object.keys(vars).map(k => `  ${k}`).join('\n');
            return { content: [{ type: 'text', text: `Credentials saved to ~/.zshenv:\n${saved}\n\nTo activate: reconnect this MCP server via /mcp in Claude Code, then call test_connection to verify.` }] };
        });
    }
    async start() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
    }
}
//# sourceMappingURL=mcp-server.js.map
// Fixed Notion configuration; preserve the public API, errors, and browser keys.
import { createHostedMCPClient } from './mcp-client.js';

export function createNotionClient(options = {}) {
  return createHostedMCPClient({
    name: 'Notion',
    mcp: 'https://mcp.notion.com/mcp',
    authorize: 'https://mcp.notion.com/authorize',
    token: 'https://mcp.notion.com/token',
    register: 'https://mcp.notion.com/register',
    issuer: 'https://mcp.notion.com',
    scope: 'default',
    otherPendingKeys: ['prism.composio.worker.pending'],
    keys: { client: 'prism.notion.client', tokens: 'prism.notion.tokens', pending: 'prism.notion.pending' },
  }, options);
}

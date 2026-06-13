/**
 * Statically-defined OpenAPI 3.1 spec for the ORB2 REST API.
 *
 * Hand-written rather than generated so we don't need a zod-to-openapi
 * dependency in the compiled binary. Mirrors the route handlers in
 * `server.ts`. If a route is added/changed, edit BOTH this file AND
 * the handler.
 */
export function buildOpenApiSpec(opts: {
  version: string
  agentId: string
  serverUrl?: string
}): Record<string, unknown> {
  const servers = opts.serverUrl ? [{ url: opts.serverUrl }] : [{ url: '/' }]
  return {
    openapi: '3.1.0',
    info: {
      title: `ORB2 Agent API — ${opts.agentId}`,
      description:
        'REST + SSE surface for the ORB2 coding agent, deployed as an A2A platform agent. Authenticate with a Bearer `orb2_*` API key minted by an admin via `POST /v1/keys` (or set in the SPA). Every /v1/* call carries the same auth model.',
      version: opts.version,
      license: { name: 'See LICENSE file' },
    },
    servers,
    components: {
      securitySchemes: {
        bearerKey: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'orb2_*',
          description:
            'Static API key minted via `POST /v1/keys` (admin-only). Plaintext shown ONCE; only the SHA-256 is persisted server-side.',
        },
      },
      schemas: {
        ChatRequest: {
          type: 'object',
          required: ['message'],
          properties: {
            message: { type: 'string' },
            session_id: {
              type: 'string',
              description:
                'Reuse to continue a multi-turn conversation. New UUID is allocated when omitted.',
            },
            model: { type: 'string' },
            working_directory: {
              type: 'string',
              description: 'Per-session workspace path; defaults to /workspace/<session_id>.',
            },
            task_packet_json: {
              type: 'string',
              description:
                'JSON-encoded TaskPacket — same schema as the gRPC ChatRequest.task_packet_json field.',
            },
          },
        },
        ChatResponse: {
          type: 'object',
          properties: {
            session_id: { type: 'string' },
            full_text: { type: 'string' },
            tool_calls: {
              type: 'array',
              items: { $ref: '#/components/schemas/ToolCall' },
            },
            tool_results: {
              type: 'array',
              items: { $ref: '#/components/schemas/ToolResult' },
            },
            usage: {
              type: 'object',
              properties: {
                prompt_tokens: { type: 'integer' },
                completion_tokens: { type: 'integer' },
              },
            },
          },
        },
        ToolCall: {
          type: 'object',
          properties: {
            tool_name: { type: 'string' },
            arguments: { type: 'object' },
            tool_use_id: { type: 'string' },
          },
        },
        ToolResult: {
          type: 'object',
          properties: {
            tool_name: { type: 'string' },
            tool_use_id: { type: 'string' },
            output: { type: 'string' },
            is_error: { type: 'boolean' },
          },
        },
        ApiKey: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            owner_email: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
            last_used_at: {
              type: 'string',
              format: 'date-time',
              nullable: true,
            },
            allowed_models: {
              type: 'array',
              items: { type: 'string' },
              nullable: true,
            },
            allowed_tools: {
              type: 'array',
              items: { type: 'string' },
              nullable: true,
            },
            admin: { type: 'boolean' },
          },
        },
        ApiKeyMint: {
          allOf: [
            { $ref: '#/components/schemas/ApiKey' },
            {
              type: 'object',
              properties: {
                plaintext: {
                  type: 'string',
                  description:
                    'Full key; shown ONCE. Store it now — only the hash is persisted.',
                },
              },
            },
          ],
        },
        Model: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            provider: { type: 'string' },
            label: { type: 'string' },
            endpoint: { type: 'string' },
          },
        },
        Tool: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            code: { type: 'string' },
          },
        },
      },
    },
    security: [{ bearerKey: [] }],
    paths: {
      '/healthz': {
        get: {
          summary: 'Liveness probe.',
          security: [],
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
      '/readyz': {
        get: {
          summary: 'Readiness probe (also pings Redis).',
          security: [],
          responses: {
            '200': { description: 'Ready' },
            '503': { description: 'Dependencies unhealthy' },
          },
        },
      },
      '/metrics': {
        get: {
          summary: 'Prometheus exposition format.',
          security: [],
          responses: {
            '200': {
              description: 'Metrics',
              content: { 'text/plain': { schema: { type: 'string' } } },
            },
          },
        },
      },
      '/.well-known/agent.json': {
        get: {
          summary: 'A2A agent card (per A2A spec).',
          description:
            'Returns the agent card consumed by the agentgateway / platform discovery — name, capabilities, tools, skills, endpoints. Matches `wellKnownEndpoint: true` in our Agent CR.',
          security: [],
          responses: { '200': { description: 'Agent card' } },
        },
      },
      '/v1/info': {
        get: {
          summary: 'Service-level info (auth requirement, LLM endpoint, ART context).',
          security: [],
          responses: { '200': { description: 'OK' } },
        },
      },
      '/v1/whoami': {
        get: {
          summary: 'Identify the caller (apikey or service).',
          responses: {
            '200': { description: 'OK' },
            '401': { description: 'Authentication required' },
          },
        },
      },
      '/v1/keys': {
        get: {
          summary: 'List keys (admin only).',
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      keys: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/ApiKey' },
                      },
                    },
                  },
                },
              },
            },
            '403': { description: 'Authentication required' },
          },
        },
        post: {
          summary: 'Mint a new API key. Plaintext returned ONCE.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string', description: 'Human-friendly label, e.g. "ci-pipeline".' },
                    owner_email: {
                      type: 'string',
                      description:
                        'App-owner email this key belongs to. Defaults to the admin minting the key.',
                    },
                    allowed_models: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                    allowed_tools: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Key created',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ApiKeyMint' },
                },
              },
            },
            '403': { description: 'Authentication required' },
          },
        },
      },
      '/v1/keys/{id}': {
        delete: {
          summary: 'Revoke an API key.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '204': { description: 'Revoked' },
            '403': { description: 'Authentication required' },
            '404': { description: 'Key not found' },
          },
        },
      },
      '/v1/models': {
        get: {
          summary: 'List the LLM(s) this agent has been configured with.',
          security: [],
          description:
            'Returns the deployment provided by the platform via env vars (`OPENAI_BASE_URL` / `OPENAI_MODEL`). Per-key allowlists apply when a Bearer is sent.',
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      models: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Model' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/v1/tools': {
        get: {
          summary: 'List tools available to the caller.',
          security: [],
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      tools: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Tool' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/v1/chat': {
        post: {
          summary: 'Synchronous chat: collect the agent\'s answer and return it as JSON.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ChatRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ChatResponse' },
                },
              },
            },
            '400': {
              description: 'Bad request',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' },
                },
              },
            },
            '401': { description: 'Authentication required' },
            '403': { description: 'Tool / model denied by per-key policy' },
          },
        },
      },
      '/v1/chat/stream': {
        post: {
          summary: 'Streaming chat over SSE.',
          description:
            'Returns text/event-stream. Events: `text_chunk`, `tool_start`, `tool_result`, `session`, `done`, `error`. Each event\'s `data:` is JSON.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ChatRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'SSE stream',
              content: { 'text/event-stream': { schema: { type: 'string' } } },
            },
          },
        },
      },
      '/v1/sessions': {
        get: {
          summary: 'List the caller\'s sessions.',
          responses: { '200': { description: 'OK' } },
        },
      },
      '/v1/sessions/{id}': {
        get: {
          summary: 'Fetch a session\'s message history.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
        },
        delete: {
          summary: 'Clear a session.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { '204': { description: 'Cleared' } },
        },
      },
      '/v1/policies/topics': {
        get: {
          summary: 'Read the current topic-policy document.',
          responses: { '200': { description: 'OK' } },
        },
        put: {
          summary: 'Replace the topic-policy document. Bumps version.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    mode: { type: 'string', enum: ['off', 'deny_list', 'allow_list'] },
                    classifier: { type: 'string', enum: ['keyword', 'hybrid', 'llm'] },
                    llm_model: { type: 'string' },
                    rider_template: { type: 'string', description: 'Must contain literal {{topics}}.' },
                    rules: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          topic: { type: 'string' },
                          description: { type: 'string' },
                          patterns: { type: 'array', items: { type: 'string' } },
                          examples: { type: 'array', items: { type: 'string' } },
                          enabled: { type: 'boolean' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'Saved' }, '400': { description: 'Validation error' } },
        },
      },
      '/v1/policies/topics/rules': {
        post: {
          summary: 'Append a single rule.',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { '201': { description: 'Created' } },
        },
      },
      '/v1/policies/topics/rules/{id}': {
        patch: {
          summary: 'Partially update a rule.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
        },
        delete: {
          summary: 'Delete a rule.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
        },
      },
      '/v1/policies/topics/test': {
        post: {
          summary: 'Dry-run classification for a sample message.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', required: ['message'], properties: { message: { type: 'string' } } },
              },
            },
          },
          responses: { '200': { description: 'Matched topics + rider preview.' } },
        },
      },
      '/v1/audit': {
        get: {
          summary: 'Tail the audit log (admin only).',
          parameters: [
            {
              name: 'date',
              in: 'query',
              schema: { type: 'string', format: 'date' },
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 1000 },
            },
          ],
          responses: { '200': { description: 'OK' }, '403': { description: 'Admin only' } },
        },
      },
      '/docs/integration': {
        get: {
          summary: 'Hand-written integration documentation page (HTML).',
          security: [],
          responses: {
            '200': {
              description: 'Docs page',
              content: { 'text/html': { schema: { type: 'string' } } },
            },
          },
        },
      },
      '/a2a': {
        post: {
          summary: 'A2A JSON-RPC 2.0 endpoint.',
          description:
            'Agent-to-Agent task protocol. Methods: tasks/send (sync), tasks/sendSubscribe (SSE streaming), tasks/get, tasks/cancel.',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['jsonrpc', 'method'],
                  properties: {
                    jsonrpc: { type: 'string', enum: ['2.0'] },
                    id: { oneOf: [{ type: 'string' }, { type: 'number' }] },
                    method: {
                      type: 'string',
                      enum: ['tasks/send', 'tasks/sendSubscribe', 'tasks/get', 'tasks/cancel'],
                    },
                    params: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', description: 'Task ID (generated if omitted)' },
                        sessionId: { type: 'string', description: 'Session ID for multi-turn context' },
                        message: { type: 'string', description: 'User message text' },
                        messages: {
                          type: 'array',
                          description: 'A2A message array (alternative to message string)',
                          items: {
                            type: 'object',
                            properties: {
                              role: { type: 'string' },
                              parts: {
                                type: 'array',
                                items: {
                                  type: 'object',
                                  properties: {
                                    type: { type: 'string' },
                                    text: { type: 'string' },
                                  },
                                },
                              },
                            },
                          },
                        },
                        model: { type: 'string', description: 'LLM model override' },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description:
                'JSON-RPC response (tasks/send, tasks/get, tasks/cancel) or SSE stream (tasks/sendSubscribe)',
            },
          },
        },
      },
    },
  }
}

export const SWAGGER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ORB2 API — Swagger UI</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
<style>body{margin:0}</style></head>
<body><div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
<script>window.addEventListener('load',()=>{SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui',deepLinking:true})})</script>
</body></html>`

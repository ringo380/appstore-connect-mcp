/**
 * OpenAPI Spec Loader for Code Mode
 *
 * Loads Apple's official OpenAPI spec and pre-resolves $refs
 * so agent-generated code can traverse it without following references.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Raw OpenAPI spec shapes (input types — before resolution)

interface RawSchema {
  $ref?: string;
  type?: string;
  properties?: Record<string, RawSchema>;
  items?: RawSchema;
  enum?: unknown[];
  description?: string;
}

interface RawParameter {
  $ref?: string;
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: RawSchema;
}

interface RawOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  parameters?: RawParameter[];
  requestBody?: RawRequestBody;
  responses?: Record<string, RawResponse>;
}

interface RawRequestBody {
  required?: boolean;
  description?: string;
  content?: {
    'application/json'?: {
      schema?: RawSchema;
    };
  };
}

interface RawResponse {
  description?: string;
  content?: {
    'application/json'?: {
      schema?: RawSchema;
    };
  };
}

interface RawSpec {
  info: { title: string; version: string };
  paths: Record<string, Record<string, RawOperation>>;
  components?: {
    schemas?: Record<string, RawSchema>;
  };
}

// Resolved output shapes (what the sandbox agent sees)

interface ResolvedProperty {
  type: string;
  description: string;
}

interface ResolvedSchema {
  type?: string;
  properties?: Record<string, ResolvedProperty>;
  items?: ResolvedSchema;
  enum?: unknown[];
  description?: string;
  ref?: string;
}

interface ResolvedParameter {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: ResolvedSchema;
  $ref?: string;
  _unresolved?: boolean;
}

interface ResolvedRequestBody {
  required?: boolean;
  description?: string;
  schema?: ResolvedSchema;
}

interface ResolvedResponse {
  description: string;
  schema?: ResolvedSchema;
}

interface ResolvedOperation {
  summary: string;
  description: string;
  operationId: string;
  tags: string[];
  parameters: ResolvedParameter[];
  requestBody?: ResolvedRequestBody;
  responses: Record<string, ResolvedResponse>;
}

export interface ResolvedSpec {
  info: { title: string; version: string };
  paths: Record<string, Record<string, ResolvedOperation>>;
  pathCount: number;
  schemaCount: number;
}

/**
 * Load and resolve the OpenAPI spec.
 * Resolves all $ref pointers inline so generated code can traverse freely.
 */
export function loadSpec(): ResolvedSpec {
  const rawPath = join(__dirname, 'openapi.json');
  const raw = JSON.parse(readFileSync(rawPath, 'utf-8')) as RawSpec;

  const schemas = raw.components?.schemas ?? {};

  // Resolve $ref pointers inline (one level deep — sufficient for search)
  const paths: Record<string, Record<string, ResolvedOperation>> = {};

  for (const [path, methods] of Object.entries(raw.paths)) {
    paths[path] = {};
    for (const [method, operation] of Object.entries(methods)) {
      if (method === 'parameters') continue; // skip path-level params

      paths[path][method] = {
        summary: operation.summary ?? '',
        description: operation.description ?? '',
        operationId: operation.operationId ?? '',
        tags: operation.tags ?? [],
        parameters: (operation.parameters ?? []).map((p) => {
          if (p.$ref) {
            return resolveRef(p.$ref, raw) as ResolvedParameter;
          }
          return {
            name: p.name,
            in: p.in,
            required: p.required ?? false,
            description: p.description ?? '',
            schema: resolveSchemaShallow(p.schema, schemas)
          };
        }),
        requestBody: operation.requestBody
          ? summarizeRequestBody(operation.requestBody, schemas)
          : undefined,
        responses: summarizeResponses(operation.responses ?? {}, schemas)
      };
    }
  }

  return {
    info: raw.info,
    paths,
    pathCount: Object.keys(paths).length,
    schemaCount: Object.keys(schemas).length
  };
}

/**
 * Resolve a $ref pointer to its target in the spec.
 * Returns the referenced node, or a sentinel object if the ref is unresolvable.
 */
function resolveRef(ref: string, root: RawSpec): unknown {
  const parts = ref.replace('#/', '').split('/');
  let current: unknown = root;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') {
      return { $ref: ref, _unresolved: true };
    }
    current = (current as Record<string, unknown>)[part];
    if (current === undefined) return { $ref: ref, _unresolved: true };
  }
  return current;
}

/**
 * Resolve schema one level deep (type + properties, not full tree)
 */
function resolveSchemaShallow(
  schema: RawSchema | undefined,
  schemas: Record<string, RawSchema>
): ResolvedSchema | undefined {
  if (!schema) return undefined;

  if (schema.$ref) {
    const name = schema.$ref.split('/').pop();
    if (!name) return { type: 'unknown', ref: schema.$ref };
    const resolved = schemas[name];
    if (!resolved) return { type: 'unknown', ref: name };
    return {
      type: resolved.type ?? 'object',
      properties: resolved.properties
        ? Object.fromEntries(
            Object.entries(resolved.properties).map(([k, v]) => [
              k,
              { type: v.type ?? (v.$ref ? 'object' : 'unknown'), description: v.description ?? '' }
            ])
          )
        : undefined,
      enum: resolved.enum,
      description: resolved.description
    };
  }

  if (schema.type === 'array' && schema.items) {
    return {
      type: 'array',
      items: resolveSchemaShallow(schema.items, schemas)
    };
  }

  return schema as ResolvedSchema;
}

/**
 * Summarize request body (type + required fields, not full schema)
 */
function summarizeRequestBody(
  body: RawRequestBody,
  schemas: Record<string, RawSchema>
): ResolvedRequestBody {
  const content = body.content?.['application/json'];
  if (!content?.schema) return { description: body.description ?? '' };

  return {
    required: body.required ?? false,
    schema: resolveSchemaShallow(content.schema, schemas)
  };
}

/**
 * Summarize responses (status codes + descriptions, not full schemas)
 */
function summarizeResponses(
  responses: Record<string, RawResponse>,
  schemas: Record<string, RawSchema>
): Record<string, ResolvedResponse> {
  const result: Record<string, ResolvedResponse> = {};
  for (const [status, resp] of Object.entries(responses)) {
    const content = resp.content?.['application/json'];
    result[status] = {
      description: resp.description ?? '',
      schema: content?.schema ? resolveSchemaShallow(content.schema, schemas) : undefined
    };
  }
  return result;
}

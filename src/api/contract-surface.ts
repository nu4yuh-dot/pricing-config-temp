import { openApiDocument } from './openapi';

/**
 * Every published path, method, and field name, flattened into sorted strings.
 *
 * This is the thing the contract test compares. The core enforces the same rule with a
 * robot rather than a reviewer — "CI compares the API spec on every pull request and fails
 * the build on a breaking change. It has already blocked a real one" — and the append-only
 * rule applies to what this service publishes too.
 *
 * Deliberately names only what a caller can depend on. Descriptions and summaries are not
 * in here: rewording a sentence is not a breaking change, and a check that fails on prose
 * gets its snapshot updated without being read, which is how the real signal gets lost.
 */
export function contractSurface(): string[] {
  const document = openApiDocument() as {
    paths: Record<string, Record<string, unknown>>;
    components: { securitySchemes: Record<string, unknown> };
  };

  const surface: string[] = [];

  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const verb = `${method.toUpperCase()} ${path}`;
      surface.push(verb);

      const detail = operation as {
        parameters?: { name: string; in: string }[];
        requestBody?: { content?: Record<string, { schema?: unknown }> };
        responses?: Record<string, unknown>;
      };

      for (const parameter of detail.parameters ?? []) {
        surface.push(`${verb} ?${parameter.name}`);
      }

      const schema = detail.requestBody?.content?.['application/json']?.schema as
        | { properties?: Record<string, unknown>; required?: string[] }
        | undefined;
      for (const field of Object.keys(schema?.properties ?? {})) {
        surface.push(`${verb} body.${field}`);

        /**
         * Required-ness is recorded as its own entry rather than as a suffix on the field.
         *
         * The two directions are not symmetric. Making an optional field required breaks
         * every caller that has always omitted it, so it must fail. Making a required
         * field optional breaks nobody — and with required-ness baked into the field's
         * name, that harmless relaxation looked exactly like a deletion. It cost a false
         * failure to notice, which is the cheap way to find out.
         */
        if ((schema?.required ?? []).includes(field)) {
          surface.push(`requires ${verb} body.${field}`);
        }
      }

      for (const status of Object.keys(detail.responses ?? {})) {
        surface.push(`${verb} -> ${status}`);
      }
    }
  }

  for (const scheme of Object.keys(document.components.securitySchemes)) {
    surface.push(`auth ${scheme}`);
  }

  return surface.sort();
}

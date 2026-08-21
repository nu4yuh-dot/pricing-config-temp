import { openApiDocument, SERVICE_TITLE } from '../../../api/openapi';
import { docsAreOpen, docsClosed } from './visibility';

/**
 * A browsable reference, rendered from the same document the spec endpoint serves.
 *
 * Deliberately one self-contained page with no external script: a documentation viewer
 * pulled from a CDN is a third party executing on the same origin as an endpoint that
 * prices freight, and it would stop working the day the CDN did.
 */

const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface Operation {
  summary?: string;
  description?: string;
  parameters?: { name: string; required?: boolean; schema?: unknown }[];
  requestBody?: { content: Record<string, { schema: unknown }> };
  responses?: Record<string, { description?: string }>;
  security?: unknown[];
}

function fieldRows(schema: unknown): string {
  const asObject = schema as { properties?: Record<string, unknown>; required?: string[] };
  const entries = Object.entries(asObject?.properties ?? {});
  if (entries.length === 0) return '';
  return `<table><thead><tr><th>Field</th><th>Type</th><th></th></tr></thead><tbody>${entries
    .map(([name, definition]) => {
      const detail = definition as { type?: string; enum?: unknown[]; description?: string };
      const type = detail.enum
        ? detail.enum.map((value) => escape(String(value))).join(' | ')
        : escape(detail.type ?? 'any');
      const need = (asObject.required ?? []).includes(name)
        ? '<span class="req">required</span>'
        : '';
      return `<tr><td><code>${escape(name)}</code></td><td>${type}</td><td>${need}</td></tr>`;
    })
    .join('')}</tbody></table>`;
}

export async function GET() {
  if (!docsAreOpen()) return docsClosed();

  const document = openApiDocument() as {
    info: { title: string; description: string };
    paths: Record<string, Record<string, Operation>>;
    components: { securitySchemes: Record<string, { description?: string }> };
  };

  const sections = Object.entries(document.paths)
    .map(([path, methods]) =>
      Object.entries(methods)
        .map(([method, operation]) => {
          const body = operation.requestBody?.content['application/json']?.schema;
          const params = operation.parameters ?? [];
          return `<section>
  <h3><span class="verb ${method}">${method.toUpperCase()}</span> <code>${escape(path)}</code></h3>
  ${operation.summary ? `<p class="summary">${escape(operation.summary)}</p>` : ''}
  ${operation.description ? `<p>${escape(operation.description)}</p>` : ''}
  ${
    params.length > 0
      ? `<h4>Query</h4><table><thead><tr><th>Name</th><th></th></tr></thead><tbody>${params
          .map(
            (parameter) =>
              `<tr><td><code>${escape(parameter.name)}</code></td><td>${
                parameter.required ? '<span class="req">required</span>' : ''
              }</td></tr>`,
          )
          .join('')}</tbody></table>`
      : ''
  }
  ${body ? `<h4>Body</h4>${fieldRows(body)}` : ''}
  <h4>Responses</h4>
  <table><tbody>${Object.entries(operation.responses ?? {})
    .map(
      ([code, response]) =>
        `<tr><td><code>${escape(code)}</code></td><td>${escape(response.description ?? '')}</td></tr>`,
    )
    .join('')}</tbody></table>
</section>`;
        })
        .join(''),
    )
    .join('');

  const auth = Object.entries(document.components.securitySchemes)
    .map(
      ([name, scheme]) =>
        `<section><h3>${escape(name)}</h3><pre>${escape(scheme.description ?? '')}</pre></section>`,
    )
    .join('');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(SERVICE_TITLE)} — API</title>
<style>
  :root { color-scheme: light dark; --line: #d6d9de; --ink: #1a1d21; --bg: #fff; --dim: #616875; --code: #f4f5f7; }
  @media (prefers-color-scheme: dark) { :root { --line: #33383f; --ink: #e6e8eb; --bg: #16181c; --dim: #969db0; --code: #1f2228; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 20px 64px; background: var(--bg); color: var(--ink);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  main { max-width: 820px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim);
    margin: 40px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
  h3 { font-size: 15px; margin: 0 0 6px; }
  h4 { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--dim); margin: 14px 0 4px; }
  section { border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; margin: 10px 0; }
  code { background: var(--code); padding: 1px 5px; border-radius: 4px; font-size: 13px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { background: var(--code); padding: 12px; border-radius: 6px; overflow-x: auto;
    font-size: 12.5px; white-space: pre-wrap; margin: 0; }
  table { width: 100%; border-collapse: collapse; margin: 4px 0; display: block; overflow-x: auto; }
  td, th { text-align: left; padding: 4px 8px 4px 0; border-bottom: 1px solid var(--line); font-size: 13.5px; }
  th { color: var(--dim); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
  .summary { font-weight: 500; margin: 0 0 6px; }
  p { margin: 6px 0; color: var(--dim); }
  .req { font-size: 11px; color: #b4441c; }
  .verb { font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 4px;
    background: var(--code); letter-spacing: .05em; }
  .verb.post { color: #1f6f43; } .verb.get { color: #1d4ed8; }
  .lede { color: var(--dim); white-space: pre-wrap; margin: 0 0 8px; }
</style></head><body><main>
<h1>${escape(document.info.title)}</h1>
<p class="lede">${escape(document.info.description)}</p>
<p>Machine-readable: <a href="/api/docs/openapi.json"><code>/api/docs/openapi.json</code></a></p>
<h2>Endpoints</h2>
${sections}
<h2>Authentication</h2>
${auth}
</main></body></html>`;

  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

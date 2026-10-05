import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { explainDelta, generateBrief, generateVerdicts, proposeMitigation } from './brief';
import type { BriefRequest } from './briefInput';
import { createAnthropicClient, type LlmClient } from './llm';

try { process.loadEnvFile('.env'); } catch { /* no .env: ANTHROPIC_API_KEY may come from the shell or an `ant auth login` profile */ }

const PORT = Number(process.env.PORT ?? 8787);
const offline = process.env.BRIEF_OFFLINE === '1';

function makeLlm(): LlmClient | undefined {
  if (offline) return undefined;
  try { return createAnthropicClient(); } catch (e) {
    console.warn(`[brief] no Anthropic credentials, serving cached/template briefs only: ${e instanceof Error ? e.message : e}`);
    return undefined;
  }
}
const llm = makeLlm();

const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) as Record<string, unknown> : {};
};

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const routes: Record<string, (b: Record<string, unknown>) => Promise<unknown>> = {
  '/api/brief': (b) => generateBrief(b as unknown as BriefRequest, { llm }),
  '/api/verdicts': (b) => generateVerdicts(b.request as BriefRequest, String(b.candidateId), { llm }),
  '/api/mitigation': (b) => proposeMitigation(b.request as BriefRequest, String(b.candidateId), { llm }),
  '/api/delta': (b) => explainDelta(b.before as BriefRequest, b.after as BriefRequest, { llm }),
};

createServer(async (req, res) => {
  const url = (req.url ?? '').split('?')[0];
  if (req.method === 'GET' && url === '/api/health') return send(res, 200, { ok: true, llm: Boolean(llm) });
  const handler = routes[url];
  if (!handler || req.method !== 'POST') return send(res, 404, { error: 'not found' });
  try {
    const t0 = Date.now();
    const out = await handler(await readJson(req)) as { source?: string; warning?: string };
    console.log(`[brief] ${url} ${Date.now() - t0} ms source=${out.source ?? '-'}${out.warning ? ` warning=${out.warning}` : ''}`);
    send(res, 200, out);
  } catch (e) {
    send(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`[brief] http://127.0.0.1:${PORT} (llm: ${llm ? 'on' : 'off'})`));

// Мок Messages API Claude для автотестов обработки разбора документов поставщиков.
// Проверяет запрос так, как его проверяет API (заголовки, PDF в base64 без переносов, схема ответа,
// бета резервной модели, запрещённые параметры), и отвечает разбором, записанным для этого PDF
// в samples/gen/claude_fixtures.json (ключ: SHA-256 файла).
// Запуск: node tools/claude-mock.js [--port 8472] [--data samples/gen/claude_fixtures.json]
//
// Служебные методы (без ключа):
//   POST /__mock/reset     сбросить сбои и журнал
//   POST /__mock/fault     добавить сбой: {status, times, headers, body} или {mode, times}
//                          mode: "refusal", "max_tokens", "fallback", "not_json"
//   GET  /__mock/log       журнал запросов; ?clear=1 очищает
//   POST /__mock/shutdown  остановить мок
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const PORT = Number(arg('--port', 8472));
const DATA = path.resolve(arg('--data', path.join(__dirname, '..', 'samples', 'gen', 'claude_fixtures.json')));
const EXPECTED = path.join(path.dirname(DATA), 'expected.json');
const KEY = JSON.parse(fs.readFileSync(EXPECTED, 'utf8')).apiKey;
const VERSION = '2026-10-21';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

let fixtures;
let faults;
let log;
function reset() {
  fixtures = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  faults = [];
  log = [];
}
reset();

const reqId = () => 'req_mock' + crypto.randomBytes(8).toString('hex');
const msgId = () => 'msg_mock' + crypto.randomBytes(8).toString('hex');
const errorBody = (type, message) => ({ type: 'error', error: { type, message }, request_id: reqId() });

function send(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'request-id': reqId(), ...headers });
  res.end(text);
}

// Все объекты схемы должны быть закрыты: так требует структурированный вывод API.
function schemaProblem(schema, where = 'schema') {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) return `${where}: additionalProperties must be false`;
    for (const [k, v] of Object.entries(schema.properties || {})) {
      const p = schemaProblem(v, `${where}.properties.${k}`);
      if (p) return p;
    }
  }
  if (schema.type === 'array' && schema.items) return schemaProblem(schema.items, `${where}.items`);
  for (const bad of ['minimum', 'maximum', 'minLength', 'maxLength', 'multipleOf']) if (bad in schema) return `${where}: ${bad} is not supported`;
  return null;
}

function validate(req, body) {
  if (!req.headers['anthropic-version']) return [400, errorBody('invalid_request_error', 'anthropic-version: header is required')];
  if (req.headers['anthropic-version'] !== VERSION) return [400, errorBody('invalid_request_error', `anthropic-version: unsupported version ${req.headers['anthropic-version']}`)];
  if (req.headers['x-api-key'] !== KEY) return [401, errorBody('authentication_error', 'invalid x-api-key')];
  if (!body || typeof body !== 'object') return [400, errorBody('invalid_request_error', 'request body must be JSON')];
  if (typeof body.model !== 'string' || !body.model) return [400, errorBody('invalid_request_error', 'model: field required')];
  if (typeof body.max_tokens !== 'number') return [400, errorBody('invalid_request_error', 'max_tokens: field required')];
  for (const p of ['temperature', 'top_p', 'top_k']) if (p in body) return [400, errorBody('invalid_request_error', `${p}: not supported in API version ${VERSION}`)];
  if (body.thinking && body.thinking.type !== 'adaptive') return [400, errorBody('invalid_request_error', `thinking.type: "${body.thinking.type}" is not supported for this model; omit thinking or use "adaptive"`)];
  if ('fallbacks' in body && !String(req.headers['anthropic-beta'] || '').split(',').map((s) => s.trim()).includes(FALLBACK_BETA))
    return [400, errorBody('invalid_request_error', `fallbacks: requires the anthropic-beta header ${FALLBACK_BETA}`)];
  const fmt = body.output_config && body.output_config.format;
  if (fmt) {
    if (fmt.type !== 'json_schema' || !fmt.schema) return [400, errorBody('invalid_request_error', 'output_config.format: type must be json_schema with a schema')];
    const p = schemaProblem(fmt.schema, 'output_config.format.schema');
    if (p) return [400, errorBody('invalid_request_error', p)];
  }
  const effort = body.output_config && body.output_config.effort;
  if (effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return [400, errorBody('invalid_request_error', `output_config.effort: invalid value ${effort}`)];
  const msg = Array.isArray(body.messages) && body.messages[0];
  const content = msg && Array.isArray(msg.content) ? msg.content : [];
  const docBlock = content.find((b) => b && b.type === 'document');
  if (!docBlock) return [400, errorBody('invalid_request_error', 'messages.0.content: a document block is expected')];
  const src = docBlock.source || {};
  if (src.type !== 'base64' || src.media_type !== 'application/pdf') return [400, errorBody('invalid_request_error', 'messages.0.content.0.source: base64 application/pdf expected')];
  if (typeof src.data !== 'string' || /[\r\n ]/.test(src.data)) return [400, errorBody('invalid_request_error', 'messages.0.content.0.source.data: invalid base64 data')];
  return null;
}

function messageFor(body, fixture, mode) {
  const text = JSON.stringify(fixture.output);
  const pages = fixture.pages || 1;
  const usage = { input_tokens: 1800 * pages + 900, output_tokens: 140 + 70 * fixture.output.lines.length, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const thinking = { type: 'thinking', thinking: '', signature: 'mock-' + crypto.randomBytes(12).toString('base64') };
  const msg = { id: msgId(), type: 'message', role: 'assistant', model: body.model, content: [thinking, { type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, stop_details: null, usage };
  if (mode === 'max_tokens') {
    msg.content = [thinking, { type: 'text', text: text.slice(0, Math.floor(text.length * 0.6)) }];
    msg.stop_reason = 'max_tokens';
    msg.usage.output_tokens = body.max_tokens;
  } else if (mode === 'refusal') {
    msg.content = [];
    msg.stop_reason = 'refusal';
    msg.stop_details = { type: 'refusal', category: null, explanation: 'The request was declined by a safety classifier.' };
    msg.usage.output_tokens = 0;
  } else if (mode === 'fallback') {
    // Отказ основной модели и ответ резервной в том же вызове: блок fallback, затем ответ.
    msg.model = 'claude-opus-4-8';
    msg.content = [{ type: 'fallback', from: { model: body.model }, to: { model: 'claude-opus-4-8' } }, thinking, { type: 'text', text }];
    msg.usage.iterations = [{ type: 'message', output_tokens: 0 }, { type: 'fallback_message', output_tokens: usage.output_tokens }];
  } else if (mode === 'not_json') {
    msg.content = [thinking, { type: 'text', text: 'Не удалось распознать документ.' }];
  }
  return msg;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const raw = await readBody(req);
  let body;
  try { body = raw ? JSON.parse(raw) : undefined; } catch (e) { body = undefined; }

  if (p.startsWith('/__mock/')) {
    if (p === '/__mock/reset') { reset(); return send(res, 200, { ok: true }); }
    if (p === '/__mock/shutdown') { send(res, 200, { ok: true }); server.close(); setTimeout(() => process.exit(0), 50); return; }
    if (p === '/__mock/fault') { faults.push({ times: 1, ...body }); return send(res, 200, { ok: true, faults: faults.length }); }
    if (p === '/__mock/log') { const out = log.slice(); if (url.searchParams.get('clear')) log = []; return send(res, 200, out); }
    return send(res, 404, { error: 'unknown mock method' });
  }

  const started = Date.now();
  const doc = body && body.messages && body.messages[0] && Array.isArray(body.messages[0].content) ? body.messages[0].content.find((b) => b && b.type === 'document') : null;
  const data = doc && doc.source && typeof doc.source.data === 'string' ? doc.source.data : '';
  const sha = data ? crypto.createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex') : '';
  const entry = {
    t: started, method: req.method, path: p, sha, file: fixtures[sha] ? fixtures[sha].file : '',
    model: body && body.model, max_tokens: body && body.max_tokens, effort: body && body.output_config && body.output_config.effort,
    format: !!(body && body.output_config && body.output_config.format), fallbacks: body && body.fallbacks,
    beta: req.headers['anthropic-beta'] || '', version: req.headers['anthropic-version'] || '', hasKey: !!req.headers['x-api-key'],
    newlines: /[\r\n]/.test(data),
  };
  const finish = (status, out, headers) => { entry.status = status; entry.ms = Date.now() - started; log.push(entry); send(res, status, out, headers); };

  if (req.method !== 'POST' || p !== '/v1/messages') return finish(404, errorBody('not_found_error', `Not found: ${req.method} ${p}`));

  const fault = faults.find((f) => f.times > 0);
  if (fault && fault.status) {
    fault.times--;
    const types = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error', 500: 'api_error', 529: 'overloaded_error' };
    const outBody = fault.body || errorBody(types[fault.status] || 'api_error', fault.message || (fault.status === 529 ? 'Overloaded' : fault.status === 429 ? 'Number of request tokens has exceeded your per-minute rate limit' : 'Internal server error'));
    return finish(fault.status, outBody, fault.headers || {});
  }

  const problem = validate(req, body);
  if (problem) return finish(problem[0], problem[1]);
  const fixture = fixtures[sha];
  if (!fixture) return finish(500, errorBody('api_error', `mock: no recorded answer for this document (sha256 ${sha})`));

  let mode;
  if (fault && fault.mode) { fault.times--; mode = fault.mode; }
  entry.mode = mode || '';
  return finish(200, messageFor(body, fixture, mode));
});

server.listen(PORT, '127.0.0.1', () => console.log(`Claude API mock on http://127.0.0.1:${PORT}, fixtures ${Object.keys(fixtures).length}`));

// Probe CLIProxyAPI with the request shapes grokbot's agent loop uses.
import OpenAI from 'openai';
const key = process.env.LLM_API_KEY;
const model = process.argv[2] ?? 'gpt-6-luna';
const c = new OpenAI({ apiKey: key, baseURL: 'http://127.0.0.1:8317/v1', timeout: 120000 });
const fn = { type: 'function', name: 'computer_screenshot', description: 'Take a screenshot', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } };
// 1x1 red PNG
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

async function run(name, body) {
  try {
    const s = await c.responses.create({ model, store: false, stream: true, ...body });
    let types = new Set(), final;
    for await (const ev of s) { types.add(ev.type); if (ev.type === 'response.completed' || ev.type === 'response.incomplete') final = ev.response; }
    const out = (final?.output ?? []).map((o) => o.type + (o.name ? `:${o.name}` : '')).join(',');
    console.log(`OK  ${name}: output=[${out}] text=${JSON.stringify((final?.output_text ?? final?.output?.find?.((o) => o.type === 'message')?.content?.[0]?.text ?? '').slice(0, 80))} usage=${final?.usage?.input_tokens}`);
    return final;
  } catch (e) { console.log(`ERR ${name}: ${e.status} ${String(e.message).slice(0, 300)}`); }
}

const sys = { role: 'system', content: 'You are a test bot. Be terse.' };
await run('basic', { input: [sys, { role: 'user', content: 'Say hi in 2 words.' }] });
await run('full-flags', { input: [sys, { role: 'user', content: 'Say ok.' }], reasoning: { effort: 'medium' }, include: ['reasoning.encrypted_content'], prompt_cache_key: 'grokbot:test:1', safety_identifier: 'abc123' });
const f = await run('function-call', { input: [sys, { role: 'user', content: 'Take a screenshot now using the tool.' }], tools: [fn], include: ['reasoning.encrypted_content'], reasoning: { effort: 'low' } });
const call = f?.output?.find((o) => o.type === 'function_call');
if (call) {
  await run('image-in-tool-output', {
    input: [sys, { role: 'user', content: 'Take a screenshot now using the tool, then tell me the dominant colour.' }, ...f.output,
      { type: 'function_call_output', call_id: call.call_id, output: [{ type: 'input_text', text: 'Current screen. Screen is 1x1px.' }, { type: 'input_image', image_url: png, detail: 'high' }] }],
    tools: [fn], include: ['reasoning.encrypted_content'], reasoning: { effort: 'low' },
  });
}
await run('web_search', { input: [sys, { role: 'user', content: 'Search the web: what is the latest stable Node.js major version? One line.' }], tools: [fn, { type: 'web_search' }], reasoning: { effort: 'low' } });
await run('x_search', { input: [sys, { role: 'user', content: 'Say ok.' }], tools: [fn, { type: 'x_search' }] });

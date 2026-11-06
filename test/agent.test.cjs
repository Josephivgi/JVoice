'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runAgent, parseKeys, blockedCombo, tools, pruneImages, makeSentencer, forSpeech, trimHistory } = require('../app/agent.cjs');

test('parseKeys presses in order and releases in reverse, extended keys flagged', () => {
  assert.deepEqual(parseKeys('ctrl+shift+t'), [
    { vk: 0x11, ext: false }, { vk: 0x10, ext: false }, { vk: 0x54, ext: false },
    { vk: 0x54, up: true, ext: false }, { vk: 0x10, up: true, ext: false }, { vk: 0x11, up: true, ext: false },
  ]);
  assert.equal(parseKeys('Down')[0].ext, true);
  assert.throws(() => parseKeys('ctrl+banana'), /Unknown key/);
  assert.throws(() => parseKeys(''), /one to five keys/);
});

test('Win+L and Ctrl+Alt+Delete are blocked', () => {
  assert.ok(blockedCombo(parseKeys('win+l')));
  assert.ok(blockedCombo(parseKeys('ctrl+alt+delete')));
  assert.ok(!blockedCombo(parseKeys('ctrl+l')));
});

test('run_command is only offered when commands are allowed', () => {
  const names = (o) => tools(o).map((t) => t.function.name);
  assert.ok(names({ allowCommands: true }).includes('run_command'));
  assert.ok(!names({ allowCommands: false }).includes('run_command'));
});

test('only the newest screenshots stay in the conversation', () => {
  const img = () => ({ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] });
  const msgs = pruneImages([img(), img(), img(), img(), img()]);
  assert.equal(msgs.filter((m) => m.content[0].type === 'image_url').length, 2);
  assert.equal(msgs[0].content[0].text, '(older screenshot removed)');
});

function fakeIo(log) {
  return {
    window: () => ({ title: 'Untitled - Notepad', exe: 'notepad.exe' }),
    screenshot: async (settle) => { log.push(`shot ${settle}`); return { width: 100, height: 50, dataUrl: 'data:image/jpeg;base64,AA' }; },
    click: async (x, y, b, n) => log.push(`click ${x},${y} ${b} ${n}`),
    typeText: async (t) => log.push(`type ${t}`),
    keys: async (k) => log.push(`keys ${k.length}`),
    scroll: async () => log.push('scroll'),
    wait: async () => log.push('wait'),
    open: async (t) => { log.push(`open ${t}`); return `Opened ${t}.`; },
    run: async (c) => { log.push(`run ${c}`); return 'exit code 0\nhi'; },
    write: async (t) => { log.push(`write ${t}`); return 'Pasted.'; },
    say: (t) => log.push(`say ${t}`),
  };
}
const tc = (name, args) => ({ id: `c${Math.random()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
// A fake streaming chat: speaks `text` in small pieces, then returns the tool calls.
const reply = (text, ...calls) => async ({ onText }) => {
  for (let i = 0; i < text.length; i += 7) onText(text.slice(i, i + 7));
  return { message: { content: text, ...(calls.length && { tool_calls: calls }) }, cost: 0.01 };
};
const script = (...turns) => { const seen = []; const chat = async (o) => { seen.push(o.messages.at(-1)); return turns.shift()(o); }; chat.seen = seen; return chat; };

test('a question is one model call, answered out loud, with no actions', async () => {
  const log = [];
  const chat = script(reply('Paris is the capital of France. Anything else?'));
  const r = await runAgent({ chat, task: 'capital of france', io: fakeIo(log) });
  assert.equal(r.success, true);
  assert.equal(r.summary, 'Paris is the capital of France. Anything else?');
  assert.equal(r.steps, 0);
  assert.deepEqual(log, ['shot 0', 'say Paris is the capital of France.', 'say Anything else?']);
});

test('several actions run in one turn with one screenshot after them; text with no tool ends it', async () => {
  const log = [];
  const chat = script(
    reply('Opening Notepad.', tc('open', { target: 'notepad' }), tc('type_text', { text: 'hi' }), tc('click', { x: 500, y: 20 }), tc('press_keys', { keys: 'win+l' })),
    reply('Done, I wrote hi in Notepad.'),
  );
  const r = await runAgent({ chat, task: 'write hi in notepad', io: fakeIo(log) });
  assert.equal(r.summary, 'Done, I wrote hi in Notepad.');
  assert.equal(r.steps, 1);
  assert.equal(r.cost, 0.02);
  assert.deepEqual(log, ['shot 0', 'say Opening Notepad.', 'open notepad', 'type hi', 'shot 900', 'say Done, I wrote hi in Notepad.']);
  // The off-screen click and the blocked combo went back to the model as errors, before the new screenshot.
  const msgs = r.history;
  assert.ok(msgs.some((m) => m.role === 'tool' && /outside the 100x50/.test(m.content)));
  assert.ok(msgs.some((m) => m.role === 'tool' && /lock or sign out/.test(m.content)));
  // No screenshots are kept for follow ups.
  assert.ok(!JSON.stringify(msgs).includes('image_url'));
});

test('run_command is used without a screenshot after it', async () => {
  const log = [];
  const chat = script(reply('', tc('run_command', { command: 'echo hi' })), reply('It said hi.'));
  await runAgent({ chat, task: 'x', io: fakeIo(log), allowCommands: true });
  assert.deepEqual(log, ['shot 0', 'run echo hi', 'say It said hi.']);
  assert.equal(chat.seen[1].content, 'exit code 0\nhi');
});

test('text-only tasks are written where the user was typing', async () => {
  const log = [];
  const chat = script(reply('', tc('write_text', { text: 'Hello Sam' })), reply('Wrote it.'));
  const r = await runAgent({ chat, task: 'say hello to Sam', io: fakeIo(log) });
  assert.equal(r.written, 'Hello Sam');
  assert.deepEqual(log, ['shot 0', 'write Hello Sam', 'say Wrote it.']);
});

test('an early screenshot is used instead of taking a new one, and history is sent first', async () => {
  const log = [];
  let sent;
  const chat = async (o) => { sent = o.messages; return reply('Sure.')(o); };
  const history = [{ role: 'user', content: [{ type: 'text', text: '[earlier] open spotify' }] }, { role: 'assistant', content: 'Opened it.' }];
  const r = await runAgent({ chat, task: 'turn it up', io: fakeIo(log), history, firstShot: Promise.resolve({ width: 10, height: 10, dataUrl: 'd' }) });
  assert.ok(!log.some((l) => l.startsWith('shot')));
  assert.equal(sent[1].content, history[0].content);
  assert.match(sent[3].content[0].text, /turn it up$/);
  assert.equal(r.history.length, 4);
});

test('a cancelled run stops before the next model call', async () => {
  const ac = new AbortController();
  let calls = 0;
  await assert.rejects(runAgent({
    chat: async (o) => { calls++; ac.abort(); return reply('', tc('wait', { seconds: 1 }))(o); },
    task: 'x', io: fakeIo([]), signal: ac.signal,
  }), /Cancelled/);
  assert.equal(calls, 1);
});

test('streamed text is spoken a sentence at a time, without markdown', () => {
  const out = [];
  const s = makeSentencer((t) => out.push(t));
  for (const piece of ['Sure', '! The **answer** is 4', '2. See https://x.com/a for', ' more, e.g. this. Last bit']) s.push(piece);
  assert.deepEqual(out, ['Sure!', 'The answer is 42.', 'See the link for more, e.g. this.']);
  s.flush();
  assert.deepEqual(out, ['Sure!', 'The answer is 42.', 'See the link for more, e.g. this.', 'Last bit']);
  assert.equal(forSpeech('- one\n- `two`'), 'one two');
});

test('history is trimmed at the start of a request', () => {
  const req = (n) => [{ role: 'user', content: [{ type: 'text', text: `[t] ${n}` }] }, { role: 'assistant', content: '', tool_calls: [] }, { role: 'tool', content: 'ok' }, { role: 'assistant', content: 'done' }];
  const all = Array.from({ length: 15 }, (_, i) => req(i)).flat();
  const kept = trimHistory(all);
  assert.ok(kept.length <= 40);
  assert.equal(kept[0].role, 'user');
});
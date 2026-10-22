'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createAdapter } = require('../kit/_meta/skripte/hook-vault-codex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-vault-test-'));
const vault = path.join(root, 'vault');
const scripts = path.join(vault, '_meta/skripte');
fs.mkdirSync(scripts, { recursive: true });
fs.mkdirSync(path.join(vault, 'projekte/demo/offen'), { recursive: true });
fs.writeFileSync(path.join(vault, '_meta/brain.config.json'), JSON.stringify({projektOrdner:path.join(root,'projects'),ausgenommen:['private']}));
fs.copyFileSync(path.join(__dirname,'..','kit','_meta','skripte','sitzung-lib.js'),path.join(scripts,'sitzung-lib.js'));
const lib = require(path.join(scripts,'sitzung-lib.js'));
const adapter = createAdapter(vault, {lib,search:()=>[{titel:'Testwissen',pfad:'erkenntnis.md',hinweis:'Beleg'}]});
const base = {session_id:'test-session-one',cwd:path.join(root,'projects/demo')};
const call = (event,extra={}) => adapter.handle({...base,hook_event_name:event,...extra});

test('start context is bounded and reads the matching project', async()=>{
 fs.writeFileSync(path.join(vault,'projekte/demo/_index.md'),'# Demo\n'+'Kontext '.repeat(2000));
 const r=await call('SessionStart');
 assert.match(r.hookSpecificOutput.additionalContext,/Projekt: demo/);
 assert.ok(r.hookSpecificOutput.additionalContext.length<8501);
});
test('prompt hits are deduplicated per session',async()=>{
 assert.match((await call('UserPromptSubmit',{prompt:'Projektwissen suchen'})).hookSpecificOutput.additionalContext,/Testwissen/);
 assert.deepEqual(await call('UserPromptSubmit',{prompt:'Projektwissen suchen'}),{});
});
test('only explicit edits trigger one reminder; continuation does not loop',async()=>{
 for(let i=0;i<3;i++) await call('PostToolUse',{tool_name:'apply_patch',tool_use_id:'patch'+i,tool_input:{command:'*** Update File: file'+i+'.ts\n@@\n-old\n+new'}});
 const reminder=await call('Stop'); assert.equal(reminder.decision,'block');
 assert.deepEqual(await call('Stop',{stop_hook_active:true}),{});
 assert.deepEqual(await call('Stop'),{});
 await call('PostToolUse',{tool_name:'Bash',tool_input:{command:'echo only reading'}});
 assert.deepEqual(await call('Stop'),{});
});
test('a real vault write suppresses the reminder; duplicate tools do not count',async()=>{
 const id='test-session-two';
 for(let i=0;i<3;i++) await call('PostToolUse',{session_id:id,tool_name:'apply_patch',tool_use_id:'p'+i,tool_input:{command:'*** Update File: file'+i+'.ts'}});
 await call('PostToolUse',{session_id:id,tool_name:'apply_patch',tool_input:{command:'*** Add File: '+path.join(vault,'projekte/demo/erkenntnisse/neu.md')}});
 assert.deepEqual(await call('Stop',{session_id:id}),{});
});
test('session lock prevents overlapping state writes; private and automation skipped',async()=>{
 const crypto=require('crypto'); const k=crypto.createHash('sha256').update(base.session_id).digest('hex').slice(0,24);
 const release=lib.sperre('codex-'+k,5); assert.ok(release);
 assert.deepEqual(await call('UserPromptSubmit',{prompt:'relevant'}),{}); release();
 assert.deepEqual(await call('SessionStart',{cwd:path.join(root,'projects/private')}),{});
 process.env.BRAIN_AUTOMATION='1'; try {assert.deepEqual(await call('SessionStart'),{});}finally{delete process.env.BRAIN_AUTOMATION;}
});
test('visible messages saved, secrets redacted, tool output omitted; distinct IDs do not collide',async()=>{
 const transcript=path.join(root,'transcript.jsonl');
 const message=(role,text)=>({timestamp:'2026-10-19T10:00:00Z',type:'response_item',payload:{type:'message',role,content:[{type:role==='user'?'input_text':'output_text',text}]}});
 fs.writeFileSync(transcript,[message('user','Erste Frage'),message('assistant','Antwort'),{type:'response_item',payload:{type:'function_call_output',output:'TOOL_SECRET'}},message('developer','SYSTEM_SECRET'),message('user','Zweite Frage: kontakt@example.org'),message('assistant','Ergebnis')].map(x=>JSON.stringify(x)).join('\n'));
 await call('Stop',{session_id:'archive-one',transcript_path:transcript});
 await call('Stop',{session_id:'archive-two',transcript_path:transcript});
 const raw=path.join(vault,'projekte/demo/generiert/sitzungen-roh'); const files=fs.readdirSync(raw);
 assert.equal(files.length,2); assert.ok(files.every(f=>/^2026-10-19-codex[a-f0-9]{24}\.txt$/.test(f)));
 const text=fs.readFileSync(path.join(raw,files[0]),'utf8');
 assert.match(text,/Erste Frage/); assert.match(text,/Ergebnis/); assert.doesNotMatch(text,/TOOL_SECRET|SYSTEM_SECRET|kontakt@example.org/);
 assert.match(text,/geschwärzt/);
 assert.equal(lib.unverarbeiteteRoh('demo').length,2);
 await call('SessionEnd',{session_id:'archive-one',transcript_path:transcript});
});
test('unknown transcript format does not fabricate a conversation',async()=>{
 const transcript=path.join(root,'unknown.jsonl');fs.writeFileSync(transcript,'{"new_format":true}\n');
 await call('Stop',{session_id:'unknown',transcript_path:transcript});
 const log=fs.readFileSync(path.join(vault,'_meta/logs/automation.log.jsonl'),'utf8'); assert.match(log,/transkript_unbekannt/);
});
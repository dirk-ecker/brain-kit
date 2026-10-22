#!/usr/bin/env node
'use strict';
// Local automatic Git snapshots. No remote and no model invocation.
// node vault-sicherung.js [--einrichten] [--nachricht "Brain: ..."]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const defaults = require('./sitzung-lib');

function createBackup(vault, lib = defaults) {
  return function sichern(nachricht = 'Brain: Automatische Sicherung', initialisieren = false) {
    const release = lib.sperre('git-sicherung', 10);
    if (!release) return { ok: true, uebersprungen: 'Sperre belegt' };
    let result;
    const log = (event, data) => {
      fs.mkdirSync(path.join(vault, '_meta/logs'), {recursive:true});
      fs.appendFileSync(path.join(vault, '_meta/logs/automation.log.jsonl'), JSON.stringify({ts:new Date().toISOString(),quelle:'git-sicherung',event,...data})+'\n');
    };
    const git = (...args) => {
      const r = spawnSync('git',['-C',vault,'-c','user.name=Brain-Automation','-c','user.email=brain@localhost','-c','core.autocrlf=false',...args],{encoding:'utf8',windowsHide:true,timeout:60000});
      if (r.error || (r.status !== 0 && !(args[0] === 'diff' && r.status === 1))) {
        const error=new Error(`git ${args[0]}: ${r.error?.code || String(r.stderr || '').trim().slice(0,300)}`);error.code='GIT_FEHLER';throw error;
      }
      return r;
    };
    try {
      if (!fs.existsSync(path.join(vault,'.git'))) {
        if (!initialisieren) {const error=new Error('Vault hat kein .git-Verzeichnis; Sicherung nicht ausgefuehrt.');error.code='KEIN_REPOSITORY';throw error;}
        git('init','--quiet');
      }
      const ignore=path.join(vault,'.gitignore');
      if (initialisieren && !fs.existsSync(ignore)) {
        fs.writeFileSync(ignore,'# Fluechtiger Sitzungszustand und UI; Notizen, Skripte und Rohsicherungen bleiben versioniert.\n_meta/state/\n_meta/logs/\n.obsidian/\n*.lock\n*.tmp\n*.claim\n',{encoding:'utf8',flag:'wx'});
      }
      const repo=git('rev-parse','--show-toplevel').stdout.trim();
      if(path.resolve(repo).toLowerCase()!==path.resolve(vault).toLowerCase()) throw new Error('Unerwartete Repository-Wurzel.');
      git('add','-A');
      if(git('diff','--cached','--quiet').status===0) {
        result={ok:true,unveraendert:true};log('git_unveraendert',result);
      } else {
        git('commit','--quiet','-m',nachricht);
        result={ok:true,commit:git('rev-parse','--short','HEAD').stdout.trim()};log('git_commit',{nachricht,...result});
      }
    } catch(error) {
      result={ok:false,fehler:error.code||'FEHLER',meldung:error.message};
      try{log('git_fehler',result);}catch{}
    } finally {
      try{lib.schreibeAtomar(path.join(vault,'_meta/state/git-sicherung.json'),JSON.stringify({ts:new Date().toISOString(),...result},null,2));}catch{}
      release();
    }
    return result;
  };
}
const sichern=createBackup(defaults.VAULT);
if(require.main===module){
  const index=process.argv.indexOf('--nachricht');
  const result=sichern(index>=0?process.argv[index+1]:undefined,process.argv.includes('--einrichten'));
  console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
}
module.exports={createBackup,sichern};
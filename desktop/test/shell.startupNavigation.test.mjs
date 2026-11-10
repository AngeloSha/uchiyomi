import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const main=fs.readFileSync(new URL('../src/main.js',import.meta.url),'utf8');
// Execute the real orchestration with deferred window loads, without launching a supervisor or native window.
const runAppSource=main.slice(main.indexOf('async function runApp() {'),main.indexOf('\n/** Standalone:'));
function rig(mode='standalone') {
  const calls=[],errors=[];let finish,reject,replaceFinish;
  const firstLoad=new Promise((res,rej)=>{finish=res;reject=rej;});
  const replacement=new Promise(res=>{replaceFinish=res;});
  const context=vm.createContext({
    process:{platform:'darwin',pid:1},lang:'en',t:()=>'',args:{},updates:null,appMode:null,
    app:{getLocale:()=> 'en',getLoginItemSettings:()=>({}),getVersion:()=> 'test'},
    pickLang:()=> 'en',translator:()=>()=>'',Updates:class{on(){}},
    installBridge(){},ipcMain:{},shell:{},firstRunApi:{},welcomeApi:{},str:v=>typeof v==='string'?v:undefined,
    stateFile:{read:()=>({}),update(_p,fn){fn({});}},L:{state:'fixture'},
    pickStartup:()=>({mode}),createTray(){},createWindow(){calls.push('loading');return firstLoad;},
    runStandalone:async()=>{calls.push('app');},runServer:async()=>{calls.push('server');},
    installCertCheck(){},session:{defaultSession:{}},firstLaunch:async()=>({mode:'standalone'}),
    replaceWindow(){calls.push('replacement');return replacement;},
    log:{info(){},error(_message,error){errors.push(error.error);}},showError(error){calls.push('error');errors.push(error);},
  });
  return {run:vm.runInContext(`'use strict';${runAppSource};runApp`,context),calls,errors,finish,reject,replaceFinish};
}

test('standalone startup waits for the shell load before navigating to the app',async()=>{
  const fixture=rig();const pending=fixture.run();
  await Promise.resolve();assert.deepEqual(fixture.calls,['loading'],'the application load must not abort an unfinished loading.html');
  fixture.finish();await pending;
  assert.deepEqual(fixture.calls,['loading','app']);assert.deepEqual(fixture.errors,[]);
  const createWindow=main.slice(main.indexOf('function createWindow('),main.indexOf('\n/** The origin the window'));
  assert.match(createWindow,/return w\.loadFile\(path\.join\(__dirname, 'loading\.html'\)\);/,'the awaited promise is the actual shell navigation');
});

test('a failed shell load is reported and never starts the application behind an error page',async()=>{
  const fixture=rig(),pending=fixture.run(),failure=new Error('ERR_FILE_NOT_FOUND');
  fixture.reject(failure);await pending;
  assert.deepEqual(fixture.calls,['loading','error']);assert.equal(fixture.errors[0],failure);
});

test('choosing standalone waits for the replacement window shell before starting its app',async()=>{
  const fixture=rig('choose'),pending=fixture.run();fixture.finish();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(fixture.calls,['loading','replacement']);
  fixture.replaceFinish();await pending;
  assert.deepEqual(fixture.calls,['loading','replacement','app']);
  const replace=main.slice(main.indexOf('function replaceWindow() {'),main.indexOf('\n/** @param {boolean} show'));
  assert.match(replace,/const loaded = createWindow\(true, bounds\);/);
  assert.match(replace,/return loaded;/,'replacement must propagate the new window load promise');
});

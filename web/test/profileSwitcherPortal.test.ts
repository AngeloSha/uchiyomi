// Execute both real callers and the real switcher/OnBody against a DOM container target.
// Real React portals retain document.body; hooks/auth/query inputs are isolated fixture boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as jsxRuntime from 'react/jsx-runtime';
import { transformSync } from 'esbuild';

const body={nodeType:1,fixture:'document.body'},document={body};
let states:any[]=[],stateIndex=0;
const hooks={...React,useState:(initial:any)=>[stateIndex<states.length?states[stateIndex++]:typeof initial==='function'?initial():initial,()=>{}],
  useEffect:()=>{},useLayoutEffect:()=>{},useRef:(value:any)=>({current:value}),useCallback:(fn:any)=>fn,useId:()=> 'profile-menu-fixture'};
const auth={user:{id:'owner-a',displayName:'A'},desktop:false,switchProfile:async()=>({ok:true}),resumeProfile:async()=>({ok:true}),leave:async()=>{},backToOwner:async()=>true};
function load(path:string,modules:Record<string,any>){
  const module={exports:{} as any};
  const code=transformSync(readFileSync(join(__dirname,'..',path),'utf8'),{loader:'tsx',format:'cjs',jsx:'automatic',target:'es2022'}).code;
  vm.runInNewContext(code,{module,exports:module.exports,require:(name:string)=>{assert.ok(name in modules,'unexpected dependency '+name);return modules[name];},document,console},{filename:path});
  return module.exports;
}
const ui=load('components/ui.tsx',{
  react:hooks,'react/jsx-runtime':jsxRuntime,'react-dom':ReactDOM,
  '@/lib/art':{},'@/lib/effects':{},'@/lib/coverBust':{},'@/lib/layers':{},'@/lib/i18n':{t:(value:string)=>value},
  '@/lib/hostNavigation/chrome':{useHostNavigationActive:()=>false},
});
const switcher=load('components/ProfileSwitcher.tsx',{
  react:hooks,'react/jsx-runtime':jsxRuntime,'next/navigation':{useRouter:()=>({push(){}})},
  '@tanstack/react-query':{useQuery:({queryKey}:any)=>({data:{content:queryKey[0]==='switchable-profiles'?[{id:'profile-b',displayName:'B',avatar:{}}]:[]}})},
  '@/lib/api':{},'@/lib/auth':{useAuth:()=>auth},'@/lib/i18n':{t:(value:string)=>value},'./Avatar':{Avatar:()=>null},'./ui':ui,
});
const menu=load('components/ProfileMenu.tsx',{
  react:hooks,'react/jsx-runtime':jsxRuntime,'next/navigation':{},'@tanstack/react-query':{},'@/lib/auth':{useAuth:()=>auth},
  '@/lib/i18n':{t:(value:string)=>value},'@/lib/incognito':{},'@/lib/adult':{},'@/lib/desktop':{},'@/lib/destinations':{},'@/lib/consoleOnScreen':{},
  '@/lib/useReduceEffects':{},'./Avatar':{Avatar:()=>null},'./ProfileSwitcher':switcher,'./IncognitoBanner':{},'./AdultToggle':{},'./settings':{},'./Switch':{},'./ui':{...ui,useRtl:()=>false},
});
function portalOf(element:any){
  assert.equal(element.type,switcher.ProfileSwitcher,'caller retains the same switch component');
  states=[];stateIndex=0;const mounted=switcher.ProfileSwitcher(element.props);
  assert.equal(mounted.type,ui.OnBody,'switch sheet is portaled independently of its caller');
  const portal=mounted.type(mounted.props);
  assert.equal(portal.containerInfo,body,'real React portal targets document.body, outside filtered ancestors');
  assert.equal(portal.children.type,ui.Sheet);assert.equal(portal.children.props.overBottomNav,true);
  assert.equal(portal.children.props.onClose,element.props.onClose,'close behavior survives the portal');
  return portal;
}

test('desktop profile switch sheet escapes the blurred header through the real OnBody portal',()=>{
  states=[false,true];stateIndex=0;const rendered=menu.ProfileMenu({active:false});
  const element=React.Children.toArray(rendered.props.children).find((child:any)=>child.type===switcher.ProfileSwitcher);
  const portal=portalOf(element);assert.equal(portal.children.props.title,'Switch profile');
});
test('phone quick settings uses the same portaled switcher and preserves its close callback',()=>{
  states=[true];stateIndex=0;const onClose=()=>{};const element=menu.QuickSettingsSheet({onClose});
  assert.equal(element.props.onClose,onClose);portalOf(element);
});

// A 401 that is an answer must not be mistaken for an expired session.
//
// `/auth/password` and `/auth/totp/disable` say 401 `{ error: 'wrong_password' }` when the current password
// is wrong; the api client used to read every 401 as "the access token died", rotate the refresh cookie and
// re-POST the same wrong password a second time -- two attempts against the lockout counter for one press
// of Enter, and a refresh round trip for nothing. Driven against the real client with a stubbed fetch.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NEXT_PUBLIC_API_BASE = '';

// `api.ts` seeds itself from localStorage at load, so the stub goes in before the import.
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
};

const calls: string[] = [];
let firstBody = '{"error":"wrong_password"}';
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = url.replace(/\?.*$/, '');
  calls.push(`${init?.method ?? 'GET'} ${path}`);
  if (path === '/auth/refresh') {
    return new Response(JSON.stringify({ accessToken: 'fresh', user: { id: 'u1' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // The first answer is the refusal under test; a retry, if one happens, gets a 200 so it is visible as a
  // SECOND call rather than as the same error twice.
  const first = calls.filter((c) => c.endsWith(path)).length === 1;
  return first
    ? new Response(firstBody, { status: 401, headers: { 'content-type': 'application/json' } })
    : new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
}) as any;

let apiMod: typeof import('../lib/api');
before(async () => {
  apiMod = await import('../lib/api');
});

test('a wrong current password is sent once and refused once', async () => {
  // Reintroduce by dropping `&& !(await isRefusal(res))` from the 401 branch in raw(): the client refreshes,
  // re-POSTs the same body, and the second answer (200 here) is returned as a success.
  calls.length = 0;
  firstBody = '{"error":"wrong_password"}';
  await assert.rejects(
    () => apiMod.api('/auth/password', { json: { current: 'wrong', next: 'new-password' } }),
    (e: any) => e instanceof apiMod.ApiError && e.status === 401 && /wrong_password/.test(e.body),
    'the refusal did not reach the caller as a 401 with its body',
  );
  assert.equal(calls.filter((c) => c === 'POST /auth/password').length, 1, 'a wrong current password is sent once and refused once');
  assert.equal(calls.filter((c) => c === 'POST /auth/refresh').length, 0, 'a spelled-out refusal rotated the refresh cookie');
});

test('a bad authentication code is not retried either', async () => {
  calls.length = 0;
  firstBody = '{"error":"totp_invalid","message":"Incorrect authentication code."}';
  await assert.rejects(() => apiMod.api('/auth/login', { json: { username: 'a', password: 'b', code: '000000' } }));
  assert.equal(calls.filter((c) => c === 'POST /auth/login').length, 1, 'a bad code was re-sent');
  assert.equal(calls.filter((c) => c === 'POST /auth/refresh').length, 0);
});

test('a bare 401 still earns the refresh and the retry', async () => {
  // The control: an expired access token has no `error` the client recognises, and that path is the whole
  // reason the retry exists -- it must keep working, or every long-open tab signs itself out.
  calls.length = 0;
  firstBody = '{"error":"unauthorized"}';
  apiMod.setCurrentUser('u1');
  const out = await apiMod.api('/api/settings', { method: 'PUT', json: { accent: '#7c5cff' } });
  assert.deepEqual(out, {}, 'the retried request did not return the second answer');
  assert.equal(calls.filter((c) => c === 'PUT /api/settings').length, 2, 'the request was not retried after the refresh');
  assert.equal(calls.filter((c) => c === 'POST /auth/refresh').length, 1, 'the session was not refreshed');
});

test('authenticated locale settings retain the ordinary same-account refresh and retry',async()=> {
  const original=globalThis.fetch,sent:Array<{path:string;authorization:string|null}>=[];apiMod.setCurrentUser('u1');apiMod.setAccessToken('expired');
  globalThis.fetch=(async(input:any,init?:RequestInit)=>{
    const path=String(input).split('?')[0];sent.push({path,authorization:new Headers(init?.headers).get('authorization')});
    if(path==='/auth/refresh')return new Response(JSON.stringify({accessToken:'fresh-locale',user:{id:'u1'}}),{headers:{'content-type':'application/json'}});
    return sent.filter(call=>call.path===path).length===1 ? new Response('{}',{status:401})
      : new Response('{"lang":"ar"}',{headers:{'content-type':'application/json'}});
  }) as typeof fetch;
  try {
    assert.deepEqual(await apiMod.api('/api/settings'),{lang:'ar'});
    assert.deepEqual(sent,[{path:'/api/settings',authorization:'Bearer expired'},{path:'/auth/refresh',authorization:null},{path:'/api/settings',authorization:'Bearer fresh-locale'}]);
  } finally {globalThis.fetch=original;}
});

test('an unknown-owner request is never replayed after refresh, for reads or private writes',async()=> {
  const original=globalThis.fetch;
  try {
    for(const method of ['GET','POST']) {
      apiMod.setCurrentUser(null);apiMod.setAccessToken(null);const sent:string[]=[];
      globalThis.fetch=(async(input:any,init?:RequestInit)=>{
        const path=String(input).split('?')[0];sent.push(`${init?.method??'GET'} ${path}`);
        return path==='/auth/refresh' ? new Response(JSON.stringify({accessToken:'adopted',user:{id:'u1'}}),{headers:{'content-type':'application/json'}})
          : new Response('{"error":"unauthorized"}',{status:401});
      }) as typeof fetch;
      const path=method==='GET'?'/api/settings':'/api/library/upload?visibility=private';
      await assert.rejects(()=>apiMod.api(path,{method,...(method==='POST'?{body:new Blob(['fixture-private-file'])}:{})}),
        (error:any)=>error instanceof apiMod.ApiError && error.status===409 && /account_changed/.test(error.body));
      assert.equal(sent.filter(call=>call===`${method} ${path.split('?')[0]}`).length,1,'unknown-owner data must not cross identity adoption');
    }
  } finally {globalThis.fetch=original;}
});

test('concurrent identity adoption rejects an older unknown-owner401 or200 response',async()=> {
  const original=globalThis.fetch;
  try {
    for(const status of [401,200]) {
      apiMod.setCurrentUser(null);apiMod.setAccessToken(null);let finish:(response:Response)=>void=()=>{};const sent:string[]=[];
      globalThis.fetch=(async(input:any)=>{
        const path=String(input).split('?')[0];sent.push(path);
        if(path==='/auth/refresh')return new Response(JSON.stringify({accessToken:'adopted',user:{id:'u1'}}),{headers:{'content-type':'application/json'}});
        return new Promise<Response>(resolve=>{finish=resolve;});
      }) as typeof fetch;
      const older=apiMod.api('/api/settings');await apiMod.refreshSession();
      finish(new Response('{"lang":"old-device-locale"}',{status,headers:{'content-type':'application/json'}}));
      await assert.rejects(older,(error:any)=>error instanceof apiMod.ApiError && error.status===409 && /account_changed/.test(error.body));
      assert.deepEqual(sent,['/api/settings','/auth/refresh'],'an older response never drives another request or overwrites the authenticated locale');
    }
  } finally {globalThis.fetch=original;}
});

test('a response started by one account cannot populate the next account’s UI', async () => {
  const original = globalThis.fetch;
  let finish: (response: Response) => void = () => {};
  apiMod.setCurrentUser('owner-a');
  globalThis.fetch = (() => new Promise<Response>((resolve) => { finish = resolve; })) as typeof fetch;
  try {
    const result = apiMod.api('/api/history');
    apiMod.setCurrentUser('owner-b');
    finish(new Response('{"privateHistory":"owner-a"}', { headers: { 'content-type': 'application/json' } }));
    await assert.rejects(result, (error: any) => error instanceof apiMod.ApiError && error.status === 409 && /account_changed/.test(error.body));
  } finally { globalThis.fetch = original; }
});

test('delayed work stays bound to the account that started it', async () => {
  const original=globalThis.fetch;
  let requests=0;
  apiMod.setCurrentUser('owner-b');apiMod.setAccessToken('token-b');
  globalThis.fetch=(async()=>{requests++;return new Response('{}');}) as typeof fetch;
  try {
    await assert.rejects(()=>apiMod.api('/api/library/upload',{expectedOwnerId:'owner-a',body:new Blob(['owner-a-file'])}),
      (error:any)=>error instanceof apiMod.ApiError && /account_changed/.test(error.body));
    assert.equal(requests,0,'old work must fail before sending any bytes or refreshing as the next user');
  } finally {globalThis.fetch=original;}
});

test('account transition leases hide credentials and fence requests until every lease ends',async()=> {
  const original=globalThis.fetch;let requests=0;
  apiMod.setCurrentUser('owner-a');apiMod.setAccessToken('token-a');
  globalThis.fetch=(async()=>{requests++;return new Response('{}');}) as typeof fetch;
  const first=apiMod.beginAccountTransition(),second=apiMod.beginAccountTransition();
  try {
    assert.equal(apiMod.getCurrentUser(),null);assert.equal(apiMod.getAccessToken(),null);
    await assert.rejects(()=>apiMod.api('/api/settings'),(error:any)=>error.status===409);
    assert.deepEqual(await apiMod.refreshSession(),{kind:'unreachable'});
    apiMod.setCurrentUser('owner-b');apiMod.setAccessToken('token-b');first();first();
    assert.equal(apiMod.getCurrentUser(),null,'ending one lease cannot release another transition');
    assert.equal(apiMod.getAccessToken(),null);assert.equal(requests,0);
    second();assert.equal(apiMod.getCurrentUser(),'owner-b');assert.equal(apiMod.getAccessToken(),'token-b');
  } finally {first();second();globalThis.fetch=original;}
});

test('JSON bodies finishing after an account change cannot populate the next account',async()=> {
  const original=globalThis.fetch;
  try {
    for(const request of [apiMod.api,apiMod.apiWithHeaders]) {
      apiMod.setCurrentUser('owner-a');apiMod.setAccessToken('token-a');
      let started:()=>void=()=>{},finish:(value:unknown)=>void=()=>{};
      const reading=new Promise<void>(resolve=>{started=resolve;});
      const response=new Response('{}',{headers:{'content-type':'application/json'}});
      Object.defineProperty(response,'json',{value:()=>{started();return new Promise(resolve=>{finish=resolve;});}});
      globalThis.fetch=(async()=>response) as typeof fetch;
      const pending=request('/api/history');await reading;
      apiMod.setCurrentUser('owner-b');apiMod.setAccessToken('token-b');finish({privateHistory:'owner-a'});
      await assert.rejects(pending,(error:any)=>error.status===409 && /account_changed/.test(error.body));
    }
  } finally {globalThis.fetch=original;}
});

test('a refresh body started before a transition cannot replace the committed account',async()=> {
  const original=globalThis.fetch;
  apiMod.setCurrentUser('owner-a');apiMod.setAccessToken('token-a');
  let started:()=>void=()=>{},finish:(value:unknown)=>void=()=>{};
  const reading=new Promise<void>(resolve=>{started=resolve;});
  const response=new Response('{}',{headers:{'content-type':'application/json'}});
  Object.defineProperty(response,'json',{value:()=>{started();return new Promise(resolve=>{finish=resolve;});}});
  globalThis.fetch=(async()=>response) as typeof fetch;
  try {
    const pending=apiMod.refreshSession();await reading;
    const release=apiMod.beginAccountTransition();
    apiMod.setCurrentUser(null);apiMod.setAccessToken(null);
    apiMod.setCurrentUser('owner-b');apiMod.setAccessToken('token-b');release();
    finish({accessToken:'late-token-a',user:{id:'owner-a'}});
    assert.deepEqual(await pending,{kind:'unreachable'});
    assert.equal(apiMod.getCurrentUser(),'owner-b');assert.equal(apiMod.getAccessToken(),'token-b');
  } finally {globalThis.fetch=original;}
});

test('a refreshed different account cannot receive a replayed upload or later stale-tab writes', async () => {
  const original = globalThis.fetch;
  const sent: string[] = [];
  apiMod.setCurrentUser('owner-a');
  apiMod.setAccessToken('token-a');
  mem.set('uchiyomi.offlineUser', JSON.stringify({v:1,id:'owner-b',username:'b',displayName:'B',role:'user',exp:Date.now()+60_000}));
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).split('?')[0];
    sent.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/auth/refresh') return new Response(JSON.stringify({ accessToken: 'token-b', user: { id: 'owner-b' } }), { headers: { 'content-type': 'application/json' } });
    return new Response('{"error":"unauthorized"}', { status: 401 });
  }) as typeof fetch;
  try {
    await assert.rejects(() => apiMod.api('/api/library/upload?visibility=private', { body: new Blob(['private-file']) }),
      (error: any) => error instanceof apiMod.ApiError && error.status === 409 && /account_changed/.test(error.body));
    assert.equal(sent.filter((entry) => entry === 'POST /api/library/upload').length, 1, 'private bytes were not replayed under owner-b');
    const before = sent.length;
    await assert.rejects(() => apiMod.api('/api/admin/import/batches', { json: { titles: ['old-tab-selection'] } }),
      (error: any) => error instanceof apiMod.ApiError && /account_changed/.test(error.body));
    assert.equal(sent.length, before, 'the stale tab stays blocked until a fresh document adopts the account');
    assert.equal(apiMod.getAccessToken(), null);
    assert.equal(apiMod.getCurrentUser(), null, 'a replaced document must never expose the next account to old offline callbacks');
    assert.equal(JSON.parse(mem.get('uchiyomi.offlineUser')!).id, 'owner-b', 'another tab’s trusted offline identity survives the old document’s rejection');
    await apiMod.refreshSession();
    assert.equal(apiMod.getAccessToken(), null, 'a later refresh cannot expose the next account token to a stale document');
    const release=apiMod.beginAccountTransition();apiMod.setAccessToken('not-authorized');release();
    assert.equal(apiMod.getAccessToken(),null,'finishing a transition cannot clear an unexpected-account reload barrier');
  } finally { globalThis.fetch = original; }
});

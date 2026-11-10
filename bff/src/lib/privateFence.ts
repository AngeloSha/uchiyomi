/** Like folder writer claims, these leases belong to this server process. */
const readers=new Map<string,number>();
const changing=new Set<string>();
export interface PrivacyLease {release():void}
export function claimPrivateContentRead(ids:readonly string[]):PrivacyLease|null{
  const keys=[...new Set(ids)];
  if(keys.some(id=>changing.has(id)))return null;
  for(const id of keys)readers.set(id,(readers.get(id)??0)+1);
  let active=true;
  return {release(){if(!active)return;active=false;for(const id of keys){const n=(readers.get(id)??1)-1;if(n)readers.set(id,n);else readers.delete(id);}}};
}
export function claimPrivateContentChange(id:string):PrivacyLease|null{
  if(changing.has(id)||readers.has(id))return null;
  changing.add(id);let active=true;
  return {release(){if(!active)return;active=false;changing.delete(id);}};
}

// Yomi source-plugin SDK — the ONLY surface a source plugin compiles against.
//
// A plugin is a compiled CommonJS module dropped into SOURCES_DIR. It either:
//   • exports a const/array of objects implementing SourceAdapter (no host services needed), or
//   • exports `register(host)` and returns an adapter (or array) — `host` provides the Cloudflare client
//     (cfGet/cfPost/cfSession) so plugins never import core internals by path and share one cookie store.
//
// Declared capabilities on SourceAdapter (requiresCloudflare / imageReferer / preferredOrder) let the core
// fetch images + order providers without knowing any specific source id.
export * from './types';
export { cfGet, cfPost, cfSession } from './flaresolverr';

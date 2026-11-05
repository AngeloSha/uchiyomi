// Source job identifiers are library-relative folders. URL-encoded long titles exceed
// find-my-way's 100-character default before cancel/dismiss can reach their handlers.
// Keep a finite bound; the server's request-line limit remains in force as well.
export const APP_ROUTER_OPTIONS = { maxParamLength: 4096 } as const;

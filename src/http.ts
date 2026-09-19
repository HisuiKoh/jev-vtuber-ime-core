/** Cloudflare Workers では global `fetch` をそのまま渡すと Illegal invocation になる。 */
export const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

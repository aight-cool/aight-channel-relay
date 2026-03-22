declare module "cloudflare:test" {
  interface ProvidedEnv {
    RELAY_SECRET: string;
    CHANNEL_ROOM: DurableObjectNamespace;
  }
}

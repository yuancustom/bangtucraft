import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import type { ModelsFile } from "./models/schema.ts";

/**
 * 按配置设置全局 fetch 代理。不走代理的模型接入点、本机地址加入 NO_PROXY。
 * 返回实际生效的 noProxy 列表，便于测试。
 */
export function setupNetwork(options: {
  httpsProxy?: string;
  noProxy?: string;
  models: ModelsFile;
  resolveBaseUrl: (providerId: string) => string;
}): string[] | undefined {
  if (!options.httpsProxy) return undefined;
  const hosts = new Set(["localhost", "127.0.0.1", "::1"]);
  for (const part of (options.noProxy ?? "").split(",")) if (part.trim()) hosts.add(part.trim());
  for (const provider of options.models.providers) {
    if (!provider.useProxy) hosts.add(new URL(options.resolveBaseUrl(provider.id)).hostname);
  }
  const noProxy = [...hosts];
  setGlobalDispatcher(
    new EnvHttpProxyAgent({ httpProxy: options.httpsProxy, httpsProxy: options.httpsProxy, noProxy: noProxy.join(",") }),
  );
  return noProxy;
}

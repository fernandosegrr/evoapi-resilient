import { socksDispatcher } from 'fetch-socks';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { ProxyAgent } from 'undici';

type Proxy = {
  host: string;
  password?: string;
  port: string;
  protocol: string;
  username?: string;
};

// https-proxy-agent/socks-proxy-agent open their raw TCP (or TLS-over-TCP) socket to the proxy
// directly inside their own `connect()` method, before agent-base's bookkeeping ever learns
// about it (that only happens once `connect()` resolves — see agent-base's `createSocket()`).
// Neither library exposes a connect timeout of its own for the CONNECT/SOCKS handshake phase,
// so if the proxy accepts the TCP connection but never completes that handshake, the socket is
// never registered anywhere `agent.destroy()` can reach it and is never closed on its own.
// Passing an AbortSignal is the one thing both `net.connect()`/`tls.connect()` (used directly by
// https-proxy-agent) and the `socks` package (used by socks-proxy-agent, via `socket_options`)
// already honor at the raw-socket level, regardless of what phase the negotiation is in —
// confirmed live: aborting the signal destroys the socket even after the TCP handshake
// completed and while it's still waiting on the proxy's CONNECT/SOCKS response.
function selectProxyAgent(proxyUrl: string, signal?: AbortSignal): HttpsProxyAgent<string> | SocksProxyAgent {
  const url = new URL(proxyUrl);

  // NOTE: The following constants are not used in the function but are defined for clarity.
  // When a proxy URL is used to build the URL object, the protocol returned by procotol's property contains a `:` at
  // the end so, we add the protocol constants without the `:` to avoid confusion.
  const PROXY_HTTP_PROTOCOL = 'http:';
  const PROXY_SOCKS_PROTOCOL = 'socks:';
  const PROXY_SOCKS5_PROTOCOL = 'socks5:';

  switch (url.protocol) {
    case PROXY_HTTP_PROTOCOL:
      return new HttpsProxyAgent(url, signal ? { signal } : undefined);
    case PROXY_SOCKS_PROTOCOL:
    case PROXY_SOCKS5_PROTOCOL: {
      let urlSocks = '';

      if (url.username && url.password) {
        urlSocks = `socks://${url.username}:${url.password}@${url.hostname}:${url.port}`;
      } else {
        urlSocks = `socks://${url.hostname}:${url.port}`;
      }

      return new SocksProxyAgent(urlSocks, signal ? { socketOptions: { signal } } : undefined);
    }
    default:
      throw new Error(`Unsupported proxy protocol: ${url.protocol}`);
  }
}

export function makeProxyAgent(proxy: Proxy | string, signal?: AbortSignal): HttpsProxyAgent<string> | SocksProxyAgent {
  if (typeof proxy === 'string') {
    return selectProxyAgent(proxy, signal);
  }

  const { host, password, port, protocol, username } = proxy;
  let proxyUrl = `${protocol}://${host}:${port}`;

  if (username && password) {
    proxyUrl = `${protocol}://${username}:${password}@${host}:${port}`;
  }

  return selectProxyAgent(proxyUrl, signal);
}

export type UndiciTimeouts = {
  /** Max wait for the response headers. undici's default is 300s. */
  headersTimeoutMs?: number;
  /** Max idle time between body chunks. undici's default is 300s. */
  bodyTimeoutMs?: number;
};

export function makeProxyAgentUndici(proxy: Proxy | string, timeouts?: UndiciTimeouts): ProxyAgent {
  const agentOptions = {
    ...(timeouts?.headersTimeoutMs ? { headersTimeout: timeouts.headersTimeoutMs } : {}),
    ...(timeouts?.bodyTimeoutMs ? { bodyTimeout: timeouts.bodyTimeoutMs } : {}),
  };
  const hasAgentOptions = Object.keys(agentOptions).length > 0;
  let proxyUrl: string;
  let protocol: string;

  if (typeof proxy === 'string') {
    const url = new URL(proxy);
    protocol = url.protocol.replace(':', '');
    proxyUrl = proxy;
  } else {
    const { host, password, port, protocol: proto, username } = proxy;
    protocol = (proto || 'http').replace(':', '');

    if (protocol === 'socks') {
      protocol = 'socks5';
    }

    const auth = username && password ? `${username}:${password}@` : '';
    proxyUrl = `${protocol}://${auth}${host}:${port}`;
  }

  protocol = protocol.toLowerCase();

  const PROXY_HTTP_PROTOCOL = 'http';
  const PROXY_HTTPS_PROTOCOL = 'https';
  const PROXY_SOCKS4_PROTOCOL = 'socks4';
  const PROXY_SOCKS5_PROTOCOL = 'socks5';

  switch (protocol) {
    case PROXY_HTTP_PROTOCOL:
    case PROXY_HTTPS_PROTOCOL:
      return hasAgentOptions ? new ProxyAgent({ uri: proxyUrl, ...agentOptions }) : new ProxyAgent(proxyUrl);

    case PROXY_SOCKS4_PROTOCOL:
    case PROXY_SOCKS5_PROTOCOL: {
      let type: 4 | 5 = 5;

      if (PROXY_SOCKS4_PROTOCOL === protocol) type = 4;

      const url = new URL(proxyUrl);

      return socksDispatcher(
        {
          type: type,
          host: url.hostname,
          port: Number(url.port),
          userId: url.username || undefined,
          password: url.password || undefined,
        },
        hasAgentOptions ? agentOptions : undefined,
      );
    }

    default:
      throw new Error(`Unsupported proxy protocol: ${protocol}`);
  }
}

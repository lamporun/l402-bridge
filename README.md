# l402-bridge

**Let any OpenAI-compatible tool pay for its own inference in sats, from any Nostr Wallet Connect wallet.**

l402-bridge is a small local proxy for tools that speak the OpenAI API, such as OpenClaw, Aider, Cline, Continue, Open WebUI or your own scripts. Point the tool at the bridge and it works as usual. When the seller asks for payment (an HTTP 402 with a Lightning invoice, per [L402](https://github.com/lightninglabs/L402)), the bridge pays from your wallet within the limits you set, caches the paid token, and retries. No account, no API key from the seller, no card.

```
your tool ──OpenAI API──▶ l402-bridge (127.0.0.1:8402) ──L402──▶ seller (e.g. lampo.run)
                               │
                               └── pays invoices over NWC ──▶ your wallet (Alby Hub, Coinos, Zeus, Rizful…)
```

Until now, paying for inference by itself in sats meant using an agent built for it: [pi402](https://github.com/lightninglabs/pi-402) does this for the Pi coding agent with Lightning Labs' Wavelength wallet. l402-bridge brings the same idea to every OpenAI-compatible tool and every wallet that offers Nostr Wallet Connect. It is built on Lightning Labs' [`@lightninglabs/aperture-client`](https://www.npmjs.com/package/@lightninglabs/aperture-client), the buyer library behind pi402, and Alby's [`@getalby/sdk`](https://github.com/getAlby/js-sdk) for NWC.

> Early software that spends real money. Start with a wallet connection that has a small budget.

## Quick start

You need Node.js 22 or newer and a Lightning wallet that offers **Nostr Wallet Connect** (NWC).

**1. Create a wallet connection with a budget.** In your wallet, open the app connections (often "Nostr Wallet Connect", "Connections" or "Apps"). Create one for l402-bridge with permission to pay invoices and a monthly budget, for example 10,000 sats, then copy the connection string. It starts with `nostr+walletconnect://`. The budget is enforced by your wallet, on top of the bridge's own limits.

**2. Start the bridge.**

```sh
export NWC_URL="nostr+walletconnect://…"
npx github:lamporun/l402-bridge
```

```
⚡ l402-bridge 0.1.0 is ready

  base URL   http://127.0.0.1:8402/v1
  API key    any value
  seller     https://lampo.run/v1
  wallet     My wallet (NWC), 12,345 sats
  limits     1,000 sats per payment, 10,000 sats per day (spent today: 0)
  status     http://127.0.0.1:8402/l402/status
```

**3. Point your tool at `http://127.0.0.1:8402/v1`** with any API key and a model the seller sells (see `GET /v1/models`). The first request buys a bundle for that model, for example 1,000 sats for about 2.8M DeepSeek V4 Flash tokens on lampo.run, and later requests use it until it runs out:

```
⚡ paid 1,000 sats + 1 fee · new bundle for deepseek-ai/DeepSeek-V4-Flash-0731 · today 1,001 / 10,000 sats
```

## Tools

The model ids below are lampo.run's. `curl http://127.0.0.1:8402/v1/models` lists the ids your seller sells.

### OpenClaw

Add a custom provider to `openclaw.json` and make one of its models the default:

```json5
{
  agents: {
    defaults: { model: { primary: "l402/deepseek-ai/DeepSeek-V4-Flash-0731" } },
  },
  models: {
    providers: {
      l402: {
        baseUrl: "http://127.0.0.1:8402/v1",
        api: "openai-completions",
        auth: "none",
        timeoutSeconds: 300,
        models: [
          { id: "deepseek-ai/DeepSeek-V4-Flash-0731", name: "DeepSeek V4 Flash (sats)", reasoning: true, input: ["text"], contextWindow: 1048576, maxTokens: 32768 },
          { id: "zai-org/GLM-5.3-Flash", name: "GLM 5.3 Flash (sats)", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 32768 },
          { id: "moonshotai/Kimi-K3", name: "Kimi K3 (sats)", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 32768 },
        ],
      },
    },
  },
}
```

Kimi K3 bundles on lampo.run cost 3,000 sats, so start the bridge with `--max-sats-per-payment 3000` to use it.

### Aider

```sh
export OPENAI_API_BASE=http://127.0.0.1:8402/v1
export OPENAI_API_KEY=unused
aider --model openai/deepseek-ai/DeepSeek-V4-Flash-0731
```

### Cline, Roo Code, Continue and other editors

Choose the **OpenAI Compatible** provider and set:
- **Base URL:** `http://127.0.0.1:8402/v1`
- **API key:** any value
- **Model:** a model id, such as `deepseek-ai/DeepSeek-V4-Flash-0731`

### Open WebUI and other apps in Docker

A container reaches the host under another name, which a loopback-only bridge refuses. So listen on all interfaces, protected by an access key:

```sh
npx github:lamporun/l402-bridge --host 0.0.0.0 --access-key "$(openssl rand -hex 24)"
```

Then add an OpenAI API connection with the URL `http://host.docker.internal:8402/v1` and that key.

### Your own code

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8402/v1", api_key="unused")
reply = client.chat.completions.create(
    model="deepseek-ai/DeepSeek-V4-Flash-0731",
    messages=[{"role": "user", "content": "Hello from sats"}],
)
print(reply.choices[0].message.content)
```

```sh
curl http://127.0.0.1:8402/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"deepseek-ai/DeepSeek-V4-Flash-0731","messages":[{"role":"user","content":"Hello"}]}'
```

## Options

| Option | Default | |
|---|---|---|
| `NWC_URL` or `--wallet-file <path>` | | The wallet connection string, from the environment or a file. |
| `--seller <url>` | `https://lampo.run/v1` | The seller's OpenAI base URL. Any L402 seller works, for example one running [Aperture](https://github.com/lightninglabs/aperture) with [Lightmeter](https://github.com/lightninglabs/lightmeter). |
| `--max-sats-per-payment <sats>` | `1000` | Refuse any single payment above this. |
| `--max-sats-per-day <sats>` | `10000` | Refuse payments past this total per day, fees included. |
| `--port <port>` | `8402` | Local port. |
| `--host <address>` | `127.0.0.1` | Listen address. Any address other than loopback requires `--access-key`. |
| `--access-key <key>` | | Require this as the tool's API key. Also `L402_BRIDGE_ACCESS_KEY`. |
| `--allow-origin <origin>` | | Let a browser app at this origin call the bridge. Repeatable. |
| `--data-dir <dir>` | `~/.l402-bridge` | Where paid tokens and the payment log are kept. |
| `--quiet` | | Log payments only. |

`GET /l402/status` shows the wallet balance (if the connection may read it), the limits and today's spend, the bundles you hold with what is left of each (where the seller reports it), and the last payments.

## How it handles your money

- **Only the seller you chose is paid**, and only through two limits that both have to agree: the per-payment cap is checked before any payment, and the daily cap counts payments already made today (routing fees included) plus those still in flight. Your wallet's own connection budget applies on top.
- **No double payments.** Requests that arrive together for a model with no bundle yet wait for the first purchase instead of each buying one. Every invoice is checked against the quoted amount before paying, and every preimage is checked against the invoice's payment hash after. If the wallet's reply never arrives, the bridge looks the payment up by its hash instead of paying again. If it still cannot tell, it pauses payments for two minutes and says so.
- **Web pages cannot spend your sats.** The bridge listens on loopback by default and checks the `Host` header, so DNS rebinding cannot reach it. Requests from a browser, which carry an `Origin` header, are refused unless you allowed that origin.
- **Your tool's API key, cookies and other headers never reach the seller.** The bridge forwards only the request body, `Content-Type` and `Accept`.
- **What is stored:** paid tokens (`tokens.json`) and the payment log (`payments.ndjson`, with each payment's hash and preimage as proof of payment), both readable by you only. Prompts and responses are never logged or stored.
- Each model has its own bundle, bought on its first request and bought again when the seller reports it used up. A bundle bought once survives restarts.

## Add an approval step with nwc-guard

[nwc-guard](https://github.com/lamporun/nwc-guard) sits between the bridge and your wallet. It refuses payees you haven't approved and payments over your limits, and it asks you on Telegram before paying anything new. Give the bridge the guard's connection instead of your wallet's:

```sh
NWC_URL="$(npx github:lamporun/nwc-guard url bridge)" npx github:lamporun/l402-bridge
```

## Tested on mainnet

On 2026-11-24 the bridge was run against https://lampo.run with real sats, driven by the openai SDK. With [Minibits](https://www.minibits.cash/) as the wallet, a streamed DeepSeek V4 Flash completion bought a 1,000-sat bundle and answered in 13.8 s including the payment, and the next request reused the bundle in 0.8 s. A longer run used a Wavelength wallet behind an NWC service over `wss://relay.getalby.com/v1`:

| Step | Result |
|---|---|
| `GET /v1/models` | 8 models, free |
| Streamed DeepSeek V4 Flash completion | one 1,000-sat payment, answer in 13.8 s including the payment |
| Second DeepSeek request | the bundle was reused, nothing paid, 1.0 s |
| Three GLM 5.3 Flash requests at once | one 1,000-sat payment for all three |
| Kimi K3 (3,000-sat bundle) | refused by the 1,000-sat per-payment limit, nothing paid |
| `/l402/status` | both bundles, with what the seller reports is left |

Whether a wallet can pay a seller depends on Lightning routing between them. If the wallet finds no route, the bridge passes its error on in one line and nothing is paid.

## Development

```sh
npm install
npm test          # unit and integration tests against a fake seller with signed invoices
npm run check     # type check
node dev/e2e-nwc.js   # end to end over a real Nostr relay, with a throwaway NWC wallet (no real sats)
```

## License

MIT. Built on [`@lightninglabs/aperture-client`](https://www.npmjs.com/package/@lightninglabs/aperture-client) (MIT, Lightning Labs) and [`@getalby/sdk`](https://github.com/getAlby/js-sdk) (MIT, Alby). Made by [Lampo](https://lampo.run), which sells inference over L402. The bridge works with any L402 seller.

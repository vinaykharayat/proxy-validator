# TestProxy

Tests SOCKS5 proxies from a JSON list, confirms IP masking, and writes working proxies into a `gost.yaml` rotating proxy chain.

## Requirements

- [Bun](https://bun.sh) runtime
- [gost](https://github.com/go-gost/gost) (optional, to run the proxy chain)

## Setup

```bash
bun install
```

## Usage

Put your proxies in `proxies.json` (array of objects with `ip` and `port` fields), then run:

```bash
bun run test-proxies.js
```

The script will:
1. Detect your real public IP
2. Test every proxy concurrently (10s timeout)
3. Print results — working / same IP / failed
4. Overwrite `gost.yaml` with only the working proxies

## proxies.json format

```json
[
  {
    "ip": "1.2.3.4",
    "port": 1080,
    "geolocation": { "country": "US", "city": "New York" }
  }
]
```

Extra fields (`proxy`, `protocol`, `anonymity`, `score`, etc.) are ignored.

## gost.yaml

The generated config runs a local SOCKS5 listener on `:1080` that round-robins across all verified working upstream proxies:

```bash
gost -C gost.yaml
```

Then point your app at `socks5://localhost:1080`.

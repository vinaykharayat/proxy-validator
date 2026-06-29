#!/usr/bin/env bun

import { SocksClient } from "socks";
import { readFileSync, writeFileSync } from "fs";

const proxies = JSON.parse(readFileSync("proxies.json", "utf8"));

// Only keep proxies faster than this — slow ones are usually flaky under load
const MAX_LATENCY_MS = 5_000;
const TIMEOUT_MS     = 8_000;

// Two independent endpoints — proxy must succeed on BOTH to be considered reliable
const CHECKS = [
  { host: "api.ipify.org",   port: 80, request: "GET /?format=json HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n" },
  { host: "ifconfig.me",     port: 80, request: "GET /ip HTTP/1.1\r\nHost: ifconfig.me\r\nUser-Agent: curl/8.0\r\nConnection: close\r\n\r\n" },
];

async function getRealIP() {
  const res = await fetch("http://api.ipify.org/?format=json");
  const { ip } = await res.json();
  return ip;
}

function proxyRequest(proxy, check) {
  return new Promise(async (resolve, reject) => {
    let socket;
    const outerTimer = setTimeout(() => reject(new Error("Connection timeout")), TIMEOUT_MS);

    try {
      const { socket: s } = await SocksClient.createConnection({
        proxy: { host: proxy.ip, port: proxy.port, type: 5 },
        command: "connect",
        destination: { host: check.host, port: check.port },
      });
      socket = s;
    } catch (err) {
      clearTimeout(outerTimer);
      return reject(err);
    }

    clearTimeout(outerTimer);

    const readTimer = setTimeout(() => { socket.destroy(); reject(new Error("Read timeout")); }, TIMEOUT_MS);

    let raw = "";
    socket.on("data", (chunk) => { raw += chunk.toString(); });
    socket.on("end", () => {
      clearTimeout(readTimer);
      socket.destroy();
      const body = raw.split("\r\n\r\n").slice(1).join("").trim();
      // ipify returns JSON, ifconfig.me returns plain text IP
      try {
        const ip = body.startsWith("{") ? JSON.parse(body).ip : body.split("\n")[0].trim();
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) resolve(ip);
        else reject(new Error(`Bad IP in response: ${body.slice(0, 60)}`));
      } catch {
        reject(new Error(`Parse error: ${body.slice(0, 60)}`));
      }
    });
    socket.on("error", (err) => { clearTimeout(readTimer); reject(err); });

    socket.write(check.request);
  });
}

async function testProxy(proxy, realIP) {
  const label = `${proxy.ip}:${proxy.port}`;
  const t0    = Date.now();

  try {
    // Run both checks concurrently — both must succeed
    const [ip1, ip2] = await Promise.all(CHECKS.map((c) => proxyRequest(proxy, c)));

    const ms = Date.now() - t0;

    if (ip1 !== ip2) {
      // The two endpoints returned different IPs — proxy is splitting traffic, unreliable
      console.log(`\x1b[33m⚠ SPLIT  \x1b[0m  ${label.padEnd(26)} endpoints disagree (${ip1} / ${ip2})  [${ms}ms]`);
      return { ...proxy, ok: false, reason: "split", ms };
    }

    if (ip1 === realIP) {
      console.log(`\x1b[33m⚠ SAME IP\x1b[0m  ${label.padEnd(26)} not masking  [${ms}ms]`);
      return { ...proxy, ok: false, reason: "same-ip", ms };
    }

    if (ms > MAX_LATENCY_MS) {
      console.log(`\x1b[33m⚠ SLOW   \x1b[0m  ${label.padEnd(26)} → ${ip1.padEnd(16)}  [${ms}ms > ${MAX_LATENCY_MS}ms limit]`);
      return { ...proxy, ok: false, reason: "slow", proxyIP: ip1, ms };
    }

    console.log(`\x1b[32m✓ WORKING\x1b[0m  ${label.padEnd(26)} → ${ip1.padEnd(16)}  [${ms}ms]`);
    return { ...proxy, ok: true, proxyIP: ip1, ms };

  } catch (err) {
    const ms = Date.now() - t0;
    console.log(`\x1b[31m✗ FAILED \x1b[0m  ${label.padEnd(26)} ${err.message}  [${ms}ms]`);
    return { ...proxy, ok: false, reason: "error", error: err.message, ms };
  }
}

function buildGostYaml(working) {
  const nodes = working
    .map((p, i) => {
      const geo = p.geolocation?.country && p.geolocation.country !== "ZZ"
        ? ` # ${p.geolocation.country}${p.geolocation.city !== "Unknown" ? " / " + p.geolocation.city : ""}`
        : "";
      return [
        `          - name: p${i + 1}${geo}`,
        `            addr: ${p.ip}:${p.port}`,
        `            connector:`,
        `              type: socks5`,
      ].join("\n");
    })
    .join("\n\n");

  return `services:
  - name: rotating
    addr: ":1080"
    handler:
      type: socks5
      chain: proxychain

chains:
  - name: proxychain
    hops:
      - name: hop-0
        selector:
          strategy: round
          maxFails: 1
          failTimeout: 30s
        nodes:
${nodes}
`;
}

async function main() {
  process.stdout.write("Fetching your real IP... ");
  const realIP = await getRealIP();
  console.log(`\x1b[1m${realIP}\x1b[0m\n`);

  console.log(`Testing ${proxies.length} proxies — dual-endpoint + latency < ${MAX_LATENCY_MS}ms...\n`);

  const results = await Promise.all(proxies.map((p) => testProxy(p, realIP)));
  const working = results.filter((r) => r.ok);
  const failed  = results.filter((r) => !r.ok);

  const byReason = failed.reduce((acc, r) => {
    acc[r.reason || "error"] = (acc[r.reason || "error"] || 0) + 1;
    return acc;
  }, {});

  console.log("\n─────────────────── Summary ───────────────────");
  console.log(`\x1b[32mPassed (dual-check + speed) : ${working.length}/${proxies.length}\x1b[0m`);
  console.log(`\x1b[31mFailed                      : ${failed.length}/${proxies.length}\x1b[0m`);
  for (const [reason, count] of Object.entries(byReason)) {
    console.log(`  ${reason.padEnd(12)} ${count}`);
  }
  if (working.length) {
    const avg = Math.round(working.reduce((s, r) => s + r.ms, 0) / working.length);
    console.log(`Avg latency of passing proxies: ${avg}ms`);
  }

  if (working.length === 0) {
    console.log("\nNo working proxies — gost.yaml not updated.");
    return;
  }

  writeFileSync("gost.yaml", buildGostYaml(working), "utf8");
  console.log(`\n\x1b[1mgost.yaml updated\x1b[0m with ${working.length} reliable proxies.`);
}

main().catch((err) => { console.error(err); process.exit(1); });

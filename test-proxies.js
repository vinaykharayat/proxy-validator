#!/usr/bin/env bun

import { SocksClient } from "socks";
import { readFileSync, writeFileSync } from "fs";

const proxies = JSON.parse(readFileSync("proxies.json", "utf8"));

const TIMEOUT_MS = 10_000;
const IP_HOST    = "api.ipify.org";
const IP_PORT    = 80;
const IP_REQUEST = `GET /?format=json HTTP/1.1\r\nHost: ${IP_HOST}\r\nConnection: close\r\n\r\n`;

async function getRealIP() {
  const res = await fetch(`http://${IP_HOST}/?format=json`);
  const { ip } = await res.json();
  return ip;
}

function getIPThroughProxy(proxy) {
  return new Promise(async (resolve, reject) => {
    let socket;
    const outerTimer = setTimeout(
      () => reject(new Error("Connection timeout")),
      TIMEOUT_MS
    );

    try {
      const { socket: s } = await SocksClient.createConnection({
        proxy: { host: proxy.ip, port: proxy.port, type: 5 },
        command: "connect",
        destination: { host: IP_HOST, port: IP_PORT },
      });
      socket = s;
    } catch (err) {
      clearTimeout(outerTimer);
      return reject(err);
    }

    clearTimeout(outerTimer);

    const readTimer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Read timeout"));
    }, TIMEOUT_MS);

    let raw = "";
    socket.on("data", (chunk) => { raw += chunk.toString(); });
    socket.on("end", () => {
      clearTimeout(readTimer);
      socket.destroy();
      const body = raw.split("\r\n\r\n").slice(1).join("").trim();
      try {
        resolve(JSON.parse(body).ip);
      } catch {
        reject(new Error(`Unexpected response: ${body.slice(0, 80)}`));
      }
    });
    socket.on("error", (err) => {
      clearTimeout(readTimer);
      reject(err);
    });

    socket.write(IP_REQUEST);
  });
}

async function testProxy(proxy, realIP) {
  const label = `${proxy.ip}:${proxy.port}`;
  const t0 = Date.now();
  try {
    const proxyIP = await getIPThroughProxy(proxy);
    const ms      = Date.now() - t0;
    const changed = proxyIP !== realIP;

    if (changed) {
      console.log(`\x1b[32m✓ WORKING\x1b[0m  ${label.padEnd(26)} → ${proxyIP.padEnd(16)}  [${ms}ms]`);
    } else {
      console.log(`\x1b[33m⚠ SAME IP\x1b[0m  ${label.padEnd(26)} (not masking)  [${ms}ms]`);
    }
    return { ...proxy, ok: true, changed, proxyIP, ms };
  } catch (err) {
    const ms = Date.now() - t0;
    console.log(`\x1b[31m✗ FAILED \x1b[0m  ${label.padEnd(26)} ${err.message}  [${ms}ms]`);
    return { ...proxy, ok: false, changed: false, error: err.message, ms };
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

  console.log(`Testing ${proxies.length} SOCKS5 proxies from proxies.json (concurrently)...\n`);

  const results  = await Promise.all(proxies.map((p) => testProxy(p, realIP)));
  const working  = results.filter((r) => r.ok && r.changed);
  const sameIP   = results.filter((r) => r.ok && !r.changed);
  const failed   = results.filter((r) => !r.ok);

  console.log("\n─────────────────── Summary ───────────────────");
  console.log(`\x1b[32mWorking & IP changed : ${working.length}/${proxies.length}\x1b[0m`);
  if (sameIP.length)  console.log(`\x1b[33mConnected / same IP  : ${sameIP.length}/${proxies.length}\x1b[0m`);
  console.log(`\x1b[31mFailed               : ${failed.length}/${proxies.length}\x1b[0m`);

  if (working.length === 0) {
    console.log("\nNo working proxies found — gost.yaml not updated.");
    return;
  }

  const yaml = buildGostYaml(working);
  writeFileSync("gost.yaml", yaml, "utf8");
  console.log(`\n\x1b[1mgost.yaml updated\x1b[0m with ${working.length} working proxies.`);
}

main().catch((err) => { console.error(err); process.exit(1); });

# Deploying reactnative-esm (esm.reactnative.run)

Server: `/opt/reactnative-run` (git checkout), systemd unit `reactnative-esm.service`
(tsx on :5200), nginx on 80/443, Cloudflare in front.

The platform-dimension release is **additive by design**: requests without a
`platform` take code paths byte-identical to the previous server (same esbuild
settings, same cache keys, same `v8:` hash input — pinned by
`test/platform.test.ts`), so the ~11GB web cache keeps serving untouched and
NO cache eviction is needed on deploy.

## Deploy

```sh
ssh <esm-origin-host>   # origin host + user are private; keep them out of this repo
cd /opt/reactnative-run

# 0. Record state + backup (repo convention)
OLD_SHA=$(git rev-parse HEAD); echo "$OLD_SHA" > /root/esm-rollback-sha
cp -a /opt/reactnative-run "/opt/reactnative-run-backup-$(date +%Y%m%d-%H%M%S)"

# 1. BEFORE upgrading: capture the web-regression baseline
bash reactnative-esm/scripts/verify-esm-deploy.sh capture http://127.0.0.1:5200

# 2. Upgrade
git fetch origin && git checkout <merged main sha>
npm install                                # workspace root; new esm deps: @babel/core, preset, 4 plugins
npm test --workspace reactnative-esm      # 6 platform regression tests
systemctl restart reactnative-esm

# 3. Verify WEB regression internally (must pass BEFORE any Cloudflare purge)
bash reactnative-esm/scripts/verify-esm-deploy.sh verify http://127.0.0.1:5200

# 4. Verify the NEW native surface
bash reactnative-esm/scripts/verify-esm-deploy.sh native http://127.0.0.1:5200
```

Only after step 3 passes: purge Cloudflare (optional for web — bytes are
unchanged; required only if stale error responses were cached).

## Rollback

```sh
cd /opt/reactnative-run
systemctl stop reactnative-esm
git checkout $(cat /root/esm-rollback-sha)
npm install                             # restores old lockfile state
systemctl start reactnative-esm
bash reactnative-esm/scripts/verify-esm-deploy.sh verify http://127.0.0.1:5200   # baseline still applies
```

Rollback needs **no cache surgery**: web keys were never touched, and the new
native entries (`*.ios.js`, `*.android.js`, `prelude-*.js`, native-hash
`bundle-deps-*`) are inert under the old code — old clients never request
those keys and they cannot collide with web keys. Delete them later at
leisure if the rollback becomes permanent:

```sh
find reactnative-esm/cache -name "*.ios.*" -o -name "*.android.*" -o -name "prelude-*" | xargs rm -f
```

Cloudflare on rollback: nothing to purge for web (still byte-identical). If
native URLs were already being used publicly, purge `/prelude/*` and
`?platform=` URLs or just wait out the TTL — old servers 404/ignore them
harmlessly.

## What changed server-side (risk map)

| Change | Web impact |
|---|---|
| `?platform=` + POST `platform` field | absent ⇒ "web" ⇒ identical |
| cache keys / dep hashes | web byte-identical (regression-tested) |
| `/prelude/:rnVersion` endpoint | new, additive |
| babel Hermes lowering | non-web builds only |
| node-builtin stubbing | historical scope preserved (web: /pkg only) |
| installs execSync → async exec | no more event-loop freezes during cold builds (bugfix); bun timeout retry + npm fallback |

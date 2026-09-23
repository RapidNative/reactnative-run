# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report privately through one of these channels:

- **GitHub:** [Report a vulnerability](https://github.com/RapidNative/reactnative-run/security/advisories/new) on this repository (preferred).
- **Email:** sanket@rapidnative.com

Include what you found, the affected component (`cli`, `reactnative-esm`, `browser-metro`, `expo-server`), steps to reproduce, and any proof of concept. Please keep testing non-destructive and avoid accessing data that is not yours.

## What to expect

- Acknowledgement within 3 business days.
- A fix or mitigation for confirmed issues as quickly as severity warrants, with status updates along the way.
- Coordinated disclosure through a GitHub Security Advisory with a CVE where applicable. We agree the timing with you before anything is published.
- Public credit by name, handle, and a link of your choice, unless you prefer to stay anonymous.

reactnative.run is an open-source project and does not run a paid bug bounty program.

## Scope

- The code in this repository.
- The hosted service at reactnative.run and its bundling origin.

Third-party packages bundled on request are out of scope. Report those upstream.

## Supported versions

Only the latest release receives security fixes. Self-hosters of `reactnative-esm` should track `main` or the latest `rnrun-v*` tag.

## Acknowledgements

- **Shai Dvash** ([@sha1cybr](https://github.com/sha1cybr), [LinkedIn](https://www.linkedin.com/in/shaidv/)): unauthenticated OS command injection and lifecycle-script execution in `reactnative-esm`, September 2026.

---
"@sapiom/harness": patch
---

Connect to GitHub now supports GitHub's Device Flow: click **Connect GitHub**, authorize the short code at github.com/login/device, then browse and clone your repositories (public and private) straight into your Workspace — no client secret, no redirect. The access token is kept server-side only (never sent to the browser or logged). Enabled by setting `SAPIOM_GITHUB_CLIENT_ID` to a GitHub OAuth App's client id; when unset, the paste-a-repo-URL option remains as a fallback.

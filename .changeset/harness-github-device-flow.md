---
"@sapiom/harness": patch
---

Connect to GitHub now supports GitHub's Device Flow: click **Connect GitHub** and the GitHub authorization page opens automatically with your code pre-filled and copied to your clipboard — just click **Authorize** and the Studio connects itself, then browse and clone your repositories (public and private) straight into your Workspace. No client secret, no redirect. The access token is kept server-side only (never sent to the browser or logged). Works out of the box; point at your own GitHub OAuth App per environment with `SAPIOM_GITHUB_CLIENT_ID`. The paste-a-repo-URL option remains as a fallback.

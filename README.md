# pr-media

Screenshots and screen recordings attached to pull requests.

This branch is **never merged into `main`**. It exists only so PR bodies can embed
images via `raw.githubusercontent.com` URLs — GitHub has no API to upload media to a
PR comment, so the alternative would be committing binaries into the PR diff.

Layout: `media/<pr-number>/<name>.png|.webm`
